import { z } from "zod";
import { circuitHealth, fetchValidated } from "./http";
import { markPayloadStale, mergeProviderPayloads, metric } from "./merge";
import {
  failedOkxHealth,
  getOkxData,
  okxL1Plan,
  okxL2Plan,
  okxL3CandlePlan,
} from "./providers/okx";
import { symbolsForTier } from "./symbols";
import {
  DEFAULT_TRADE_COSTS,
  TIMEFRAMES,
  type FetchTier,
  type MarketHubPayload,
  type OkxFetchPlan,
  type ProviderHealth,
  type ProviderPayload,
  type TradeCosts,
} from "./types";

const FRESH_TTL_MS: Record<FetchTier, number> = {
  l1: 20_000,
  l2: 45_000,
  l3: 60_000,
};
const STALE_TTL_MS = 10 * 60_000;

/** Tier-scoped deadlines — OKX only */
const OKX_DEADLINE_MS: Record<FetchTier, number> = {
  l1: 4_000,
  l2: 18_000,
  l3: 20_000,
};

const fearSchema = z.object({
  data: z.array(
    z.object({
      value: z.string().transform(Number),
      value_classification: z.string(),
      timestamp: z.string(),
    }),
  ),
});
type FearResult = Awaited<ReturnType<typeof getFearGreed>>;

type ProviderClients = {
  okx?: (plan: OkxFetchPlan, signal?: AbortSignal) => Promise<ProviderPayload>;
  fear?: () => Promise<FearResult>;
  okxTimeoutMs?: number;
};

type CacheEntry = { payload: MarketHubPayload; storedAt: number };
const cacheByTier = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<MarketHubPayload>>();
let providerRequestIds = new WeakMap<object, number>();
let providerRequestSequence = 0;

function normalizedCosts(costs: TradeCosts = DEFAULT_TRADE_COSTS): TradeCosts {
  return {
    feeRate: Math.max(0, Math.min(0.02, costs.feeRate)),
    slippageRate: Math.max(0, Math.min(0.02, costs.slippageRate)),
  };
}

function cacheKey(tier: FetchTier, costs: TradeCosts = DEFAULT_TRADE_COSTS) {
  const safe = normalizedCosts(costs);
  return `okx:${tier}:fee-${safe.feeRate.toFixed(6)}:slip-${safe.slippageRate.toFixed(6)}`;
}

function requestKey(tier: FetchTier, providers?: ProviderClients, costs: TradeCosts = DEFAULT_TRADE_COSTS) {
  if (!providers) return cacheKey(tier, costs);
  let id = providerRequestIds.get(providers);
  if (!id) {
    id = ++providerRequestSequence;
    providerRequestIds.set(providers, id);
  }
  return `injected:${id}:${cacheKey(tier, costs)}`;
}

async function getFearGreed() {
  const startedAt = Date.now();
  try {
    const response = await fetchValidated(
      "Alternative.me",
      "https://api.alternative.me/fng/?limit=1&format=json",
      fearSchema,
    );
    const row = response.data.data[0];
    const state = circuitHealth("Alternative.me");
    const health: ProviderHealth = {
      name: "Alternative.me",
      state: row ? "live" : "missing",
      latencyMs: Date.now() - startedAt,
      lastSuccessAt: state.lastSuccessAt,
      lastFailureAt: state.lastFailureAt,
      consecutiveFailures: state.consecutiveFailures,
      circuitOpen: state.circuitOpen,
      coverage: { ticker: row ? 1 : 0, funding: 0, oi: 0, positioning: 0, candles: 0 },
      errors: row ? [] : ["Fear & Greed empty response"],
    };
    return {
      value: row
        ? metric({ value: row.value, label: row.value_classification }, "Alternative.me", "live", response.latencyMs)
        : metric<{ value: number; label: string }>(null, "Alternative.me", "missing", null, "Fear & Greed 沒有資料"),
      health,
    };
  } catch (error) {
    const state = circuitHealth("Alternative.me");
    const message = error instanceof Error ? error.message : String(error);
    const health: ProviderHealth = {
      name: "Alternative.me",
      state: "missing",
      latencyMs: null,
      lastSuccessAt: state.lastSuccessAt,
      lastFailureAt: state.lastFailureAt,
      consecutiveFailures: state.consecutiveFailures,
      circuitOpen: state.circuitOpen,
      coverage: { ticker: 0, funding: 0, oi: 0, positioning: 0, candles: 0 },
      errors: [message],
    };
    return {
      value: metric<{ value: number; label: string }>(null, "Alternative.me", "missing", null, "來源暫時離線"),
      health,
    };
  }
}

async function settled<T>(promise: Promise<T>) {
  try {
    return { value: await promise, error: null };
  } catch (error) {
    return { value: null, error };
  }
}

async function withDeadline<T>(label: string, timeoutMs: number, factory: (signal: AbortSignal) => Promise<T>) {
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), timeoutMs);
  let hardTimer: ReturnType<typeof setTimeout> | null = null;
  const hardDeadline = new Promise<never>((_, reject) => {
    hardTimer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms deadline`)), timeoutMs + 500);
  });
  try {
    return await Promise.race([factory(controller.signal), hardDeadline]);
  } finally {
    clearTimeout(abortTimer);
    if (hardTimer) clearTimeout(hardTimer);
    controller.abort();
  }
}

function fetchedFields(plan: OkxFetchPlan) {
  if (plan.full) return ["ticker", "funding", "openInterest", "oiChange", "longShortRatios", "topPositionRatio", "liquidations", `candles:${TIMEFRAMES.join("/")}`];
  return [
    ...plan.tickerSymbols.map((symbol) => `${symbol}:ticker`),
    ...plan.fundingSymbols.map((symbol) => `${symbol}:funding`),
    ...plan.openInterestSymbols.map((symbol) => `${symbol}:openInterest+positioning+liquidations`),
    ...Object.entries(plan.candleTimeframes).flatMap(([symbol, timeframes]) =>
      (timeframes ?? []).map((timeframe) => `${symbol}:candles:${timeframe}`),
    ),
  ];
}

function planForTier(tier: FetchTier): OkxFetchPlan {
  const symbols = symbolsForTier(tier);
  if (tier === "l1") return okxL1Plan(symbols);
  if (tier === "l2") return okxL2Plan(symbols);
  return okxL3CandlePlan(symbols, [...TIMEFRAMES]);
}

/**
 * Market Data Hub — OKX only (Binance removed for AU / Vercel reliability).
 */
export async function buildMarketHub(
  providers: ProviderClients = {},
  tier: FetchTier = "l2",
  costs: TradeCosts = DEFAULT_TRADE_COSTS,
) {
  const startedAt = Date.now();
  const fearPromise = providers.fear ? providers.fear() : getFearGreed();
  const okxProvider = providers.okx ?? ((plan: OkxFetchPlan, signal?: AbortSignal) => getOkxData(plan, { signal }));
  const plan = planForTier(tier);

  const [okxResult, fear] = await Promise.all([
    settled(
      withDeadline("OKX", providers.okxTimeoutMs ?? OKX_DEADLINE_MS[tier], (signal) => okxProvider(plan, signal)),
    ),
    fearPromise,
  ]);

  const okxHealth = okxResult.value?.health ?? failedOkxHealth(okxResult.error);
  const duration = Date.now() - startedAt;

  return mergeProviderPayloads({
    okx: { assets: okxResult.value?.assets ?? [], health: okxHealth },
    fearGreed: fear.value,
    fearHealth: fear.health,
    costs: normalizedCosts(costs),
    staleTtlMs: STALE_TTL_MS,
    pipeline: {
      stage: "using-okx",
      mode: "normal",
      tier,
      marketApiDurationMs: duration,
      binanceDurationMs: null,
      okxDurationMs: okxHealth.latencyMs,
      okxFetchedFields: fetchedFields(plan),
    },
  });
}

export async function getMarketHub(
  providers?: ProviderClients,
  tier: FetchTier = "l2",
  costs: TradeCosts = DEFAULT_TRADE_COSTS,
) {
  const now = Date.now();
  const key = cacheKey(tier, costs);
  const activeRequestKey = requestKey(tier, providers, costs);
  const freshTtl = FRESH_TTL_MS[tier];

  if (!providers) {
    const hit = cacheByTier.get(key);
    if (hit && now - hit.storedAt < freshTtl) {
      return { ...hit.payload, cacheAgeMs: now - hit.storedAt };
    }
  }

  const existing = inFlight.get(activeRequestKey);
  if (existing) return existing;

  const task = buildMarketHub(providers ?? {}, tier, costs)
    .then((payload) => {
      if (!payload.assets.length) throw new Error("Market Data Hub cannot return success with zero assets");
      if (!providers) {
        cacheByTier.set(key, { payload, storedAt: Date.now() });
      }
      return payload;
    })
    .catch((error) => {
      const hit = cacheByTier.get(key);
      const stale = hit ? markPayloadStale(hit.payload, hit.storedAt, Date.now(), STALE_TTL_MS) : null;
      if (stale) return stale;
      throw error;
    })
    .finally(() => {
      inFlight.delete(activeRequestKey);
    });

  inFlight.set(activeRequestKey, task);
  return task;
}

/** On-demand L3 candle enrichment for specific symbols (strategy desk). */
export async function getMarketCandles(
  symbols: string[],
  providers?: ProviderClients,
): Promise<MarketHubPayload> {
  const list = symbols.length ? symbols : symbolsForTier("l1");
  return getMarketHub({
    ...providers,
    okx: providers?.okx
      ? providers.okx
      : (_plan, signal) => getOkxData(okxL3CandlePlan(list), { signal }),
  }, "l3", DEFAULT_TRADE_COSTS);
}

export function __setMarketCacheForTests(
  value: { payload: MarketHubPayload; storedAt: number } | null,
  tier: FetchTier = "l2",
) {
  if (!value) {
    cacheByTier.clear();
    inFlight.clear();
    providerRequestIds = new WeakMap<object, number>();
    providerRequestSequence = 0;
    return;
  }
  cacheByTier.set(cacheKey(tier, DEFAULT_TRADE_COSTS), value);
}
