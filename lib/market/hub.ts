import { z } from "zod";
import { circuitHealth, fetchValidated } from "./http";
import { markPayloadStale, mergeProviderPayloads, metric } from "./merge";
import { failedBinanceHealth, getBinanceData } from "./providers/binance";
import { failedOkxHealth, fullOkxFetchPlan, getOkxData } from "./providers/okx";
import { TIMEFRAMES, type MarketHubPayload, type OkxFetchPlan, type ProviderHealth, type ProviderPayload } from "./types";

const FRESH_TTL_MS = 30_000;
const STALE_TTL_MS = 10 * 60_000;
const BINANCE_DEADLINE_MS = 10_000;
const OKX_NORMAL_DEADLINE_MS = 20_000;
const OKX_FORCE_DEADLINE_MS = 35_000;
const fearSchema = z.object({ data: z.array(z.object({ value: z.string().transform(Number), value_classification: z.string(), timestamp: z.string() })) });
type FearResult = Awaited<ReturnType<typeof getFearGreed>>;
type ProviderClients = {
  binance?: () => Promise<ProviderPayload>;
  okx?: (plan: OkxFetchPlan, signal?: AbortSignal) => Promise<ProviderPayload>;
  fear?: () => Promise<FearResult>;
  binanceTimeoutMs?: number;
  okxTimeoutMs?: number;
};

let cache: { payload: MarketHubPayload; storedAt: number } | null = null;
const inFlight = new Map<"normal" | "force-okx", Promise<MarketHubPayload>>();
let lastOkxHealth: ProviderHealth | null = null;

async function getFearGreed() {
  const startedAt = Date.now();
  try {
    const response = await fetchValidated("Alternative.me", "https://api.alternative.me/fng/?limit=1&format=json", fearSchema);
    const row = response.data.data[0];
    const state = circuitHealth("Alternative.me");
    const health: ProviderHealth = { name: "Alternative.me", state: row ? "live" : "missing", latencyMs: Date.now() - startedAt, lastSuccessAt: state.lastSuccessAt, lastFailureAt: state.lastFailureAt, consecutiveFailures: state.consecutiveFailures, circuitOpen: state.circuitOpen, coverage: { ticker: row ? 1 : 0, funding: 0, oi: 0, positioning: 0, candles: 0 }, errors: row ? [] : ["Fear & Greed empty response"] };
    return { value: row ? metric({ value: row.value, label: row.value_classification }, "Alternative.me", "live", response.latencyMs) : metric<{ value: number; label: string }>(null, "Alternative.me", "missing", null, "Fear & Greed 沒有資料"), health };
  } catch (error) {
    const state = circuitHealth("Alternative.me");
    const message = error instanceof Error ? error.message : String(error);
    const health: ProviderHealth = { name: "Alternative.me", state: "missing", latencyMs: null, lastSuccessAt: state.lastSuccessAt, lastFailureAt: state.lastFailureAt, consecutiveFailures: state.consecutiveFailures, circuitOpen: state.circuitOpen, coverage: { ticker: 0, funding: 0, oi: 0, positioning: 0, candles: 0 }, errors: [message] };
    return { value: metric<{ value: number; label: string }>(null, "Alternative.me", "missing", null, "來源暫時離線"), health };
  }
}

async function settled<T>(promise: Promise<T>) {
  try { return { value: await promise, error: null }; } catch (error) { return { value: null, error }; }
}

async function withDeadline<T>(label: string, timeoutMs: number, factory: (signal: AbortSignal) => Promise<T>) {
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), timeoutMs);
  let hardTimer: ReturnType<typeof setTimeout> | null = null;
  const hardDeadline = new Promise<never>((_, reject) => {
    hardTimer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms deadline`)), timeoutMs + 750);
  });
  try {
    return await Promise.race([factory(controller.signal), hardDeadline]);
  } finally {
    clearTimeout(abortTimer);
    if (hardTimer) clearTimeout(hardTimer);
    controller.abort();
  }
}

function unique(values: string[]) { return Array.from(new Set(values)); }

export function okxPlanForMissingFields(binance: ProviderPayload): OkxFetchPlan {
  const tickerSymbols: string[] = [];
  const fundingSymbols: string[] = [];
  const openInterestSymbols: string[] = [];
  const candleTimeframes: OkxFetchPlan["candleTimeframes"] = {};
  for (const asset of binance.assets) {
    if (asset.price === null || asset.change24h === null || asset.quoteVolume === null) tickerSymbols.push(asset.symbol);
    if (asset.funding === null) fundingSymbols.push(asset.symbol);
    if (asset.openInterest === null) openInterestSymbols.push(asset.symbol);
    const missingTimeframes = TIMEFRAMES.filter((timeframe) => !asset.candlesByTimeframe[timeframe].length);
    if (missingTimeframes.length) candleTimeframes[asset.symbol] = missingTimeframes;
  }
  const symbols = unique([...tickerSymbols, ...fundingSymbols, ...openInterestSymbols, ...Object.keys(candleTimeframes)]);
  return { full: false, symbols, tickerSymbols, fundingSymbols, openInterestSymbols, candleTimeframes };
}

function fetchedFields(plan: OkxFetchPlan) {
  if (plan.full) return ["ticker", "funding", "openInterest", "candles:15m/1h/4h/1d"];
  return [
    ...plan.tickerSymbols.map((symbol) => `${symbol}:ticker`),
    ...plan.fundingSymbols.map((symbol) => `${symbol}:funding`),
    ...plan.openInterestSymbols.map((symbol) => `${symbol}:openInterest`),
    ...Object.entries(plan.candleTimeframes).flatMap(([symbol, timeframes]) => (timeframes ?? []).map((timeframe) => `${symbol}:candles:${timeframe}`)),
  ];
}

function okxStandbyPayload(): ProviderPayload {
  const health = lastOkxHealth ?? { name: "OKX" as const, state: "live" as const, latencyMs: null, lastSuccessAt: null, lastFailureAt: null, consecutiveFailures: 0, circuitOpen: false, coverage: { ticker: 0, funding: 0, oi: 0, positioning: 0, candles: 0 }, errors: [] };
  return { assets: [], health };
}

export async function buildMarketHub(forceOkx = false, providers: ProviderClients = {}) {
  const startedAt = Date.now();
  const fearPromise = providers.fear ? providers.fear() : getFearGreed();
  const okxProvider = providers.okx ?? ((plan: OkxFetchPlan, signal?: AbortSignal) => getOkxData(plan, { signal }));

  if (forceOkx) {
    const plan = fullOkxFetchPlan();
    const [okxResult, fear] = await Promise.all([
      settled(withDeadline("OKX force fallback", providers.okxTimeoutMs ?? OKX_FORCE_DEADLINE_MS, (signal) => okxProvider(plan, signal))),
      fearPromise,
    ]);
    const okxHealth = okxResult.value?.health ?? failedOkxHealth(okxResult.error);
    if (okxResult.value) lastOkxHealth = okxResult.value.health;
    const duration = Date.now() - startedAt;
    return mergeProviderPayloads({
      binance: null,
      okx: { assets: okxResult.value?.assets ?? [], health: okxHealth },
      fearGreed: fear.value,
      fearHealth: fear.health,
      staleTtlMs: STALE_TTL_MS,
      pipeline: { stage: "using-okx-fallback", mode: "force-okx", marketApiDurationMs: duration, binanceDurationMs: null, okxDurationMs: okxHealth.latencyMs, okxFetchedFields: fetchedFields(plan) },
    });
  }

  const binanceStartedAt = Date.now();
  const binanceResult = await settled(withDeadline("Binance", providers.binanceTimeoutMs ?? BINANCE_DEADLINE_MS, () => (providers.binance ?? getBinanceData)()));
  const binanceDurationMs = Date.now() - binanceStartedAt;
  const binancePayload = binanceResult.value?.assets.length ? binanceResult.value : null;
  const binanceHealth = binancePayload?.health ?? failedBinanceHealth(binanceResult.error ?? new Error("Binance returned zero assets"));
  const plan = binancePayload ? okxPlanForMissingFields(binancePayload) : fullOkxFetchPlan();
  let okxResult: { value: ProviderPayload | null; error: unknown } | null = null;
  if (!binancePayload || plan.symbols.length) {
    okxResult = await settled(withDeadline("OKX normal fallback", providers.okxTimeoutMs ?? OKX_NORMAL_DEADLINE_MS, (signal) => okxProvider(plan, signal)));
    if (okxResult.value) lastOkxHealth = okxResult.value.health;
  }
  const fear = await fearPromise;
  const okxPayload = okxResult ? { assets: okxResult.value?.assets ?? [], health: okxResult.value?.health ?? failedOkxHealth(okxResult.error) } : okxStandbyPayload();
  const duration = Date.now() - startedAt;
  return mergeProviderPayloads({
    binance: { assets: binancePayload?.assets ?? [], health: binanceHealth },
    okx: okxPayload,
    fearGreed: fear.value,
    fearHealth: fear.health,
    staleTtlMs: STALE_TTL_MS,
    pipeline: {
      stage: !binancePayload ? "using-okx-fallback" : plan.symbols.length ? "filling-from-okx" : "using-binance",
      mode: "normal",
      marketApiDurationMs: duration,
      binanceDurationMs,
      okxDurationMs: okxResult?.value?.health.latencyMs ?? null,
      okxFetchedFields: okxResult ? fetchedFields(plan) : [],
    },
  });
}

export async function getMarketHub(forceOkx = false, providers?: ProviderClients) {
  const now = Date.now();
  if (!providers && !forceOkx && cache && now - cache.storedAt < FRESH_TTL_MS) return { ...cache.payload, cacheAgeMs: now - cache.storedAt };
  const key = forceOkx ? "force-okx" : "normal";
  const existing = inFlight.get(key);
  if (existing) return existing;
  const task = buildMarketHub(forceOkx, providers).then((payload) => {
    if (!payload.assets.length) throw new Error("Market Data Hub cannot return success with zero assets");
    if (!providers && !forceOkx) cache = { payload, storedAt: Date.now() };
    return payload;
  }).catch((error) => {
    const stale = !forceOkx && cache ? markPayloadStale(cache.payload, cache.storedAt, Date.now(), STALE_TTL_MS) : null;
    if (stale) return stale;
    throw error;
  }).finally(() => { inFlight.delete(key); });
  inFlight.set(key, task);
  return task;
}

export function __setMarketCacheForTests(value: { payload: MarketHubPayload; storedAt: number } | null) {
  cache = value;
  inFlight.clear();
  lastOkxHealth = null;
}

