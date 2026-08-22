import { z } from "zod";
import { circuitHealth, fetchValidated } from "./http";
import { markPayloadStale, mergeProviderPayloads, metric } from "./merge";
import {
  binancePlanForTier,
  failedBinanceHealth,
  getBinanceData,
  isBinanceHardFail,
} from "./providers/binance";
import {
  failedOkxHealth,
  fullOkxFetchPlan,
  getOkxData,
  okxL1Plan,
  okxL2Plan,
  okxL3CandlePlan,
} from "./providers/okx";
import { symbolsForTier } from "./symbols";
import {
  TIMEFRAMES,
  type FetchTier,
  type MarketHubPayload,
  type OkxFetchPlan,
  type ProviderHealth,
  type ProviderPayload,
} from "./types";

const FRESH_TTL_MS: Record<FetchTier, number> = {
  l1: 20_000,
  l2: 45_000,
  l3: 60_000,
};
const STALE_TTL_MS = 10 * 60_000;

/** Tier-scoped deadlines — average latency first */
const BINANCE_DEADLINE_MS: Record<FetchTier, number> = {
  l1: 3_500,
  l2: 8_000,
  l3: 18_000,
};
const OKX_DEADLINE_MS: Record<FetchTier, number> = {
  l1: 3_500,
  l2: 10_000,
  l3: 16_000,
};
const OKX_FORCE_DEADLINE_MS = 32_000;

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
  binance?: () => Promise<ProviderPayload>;
  okx?: (plan: OkxFetchPlan, signal?: AbortSignal) => Promise<ProviderPayload>;
  fear?: () => Promise<FearResult>;
  binanceTimeoutMs?: number;
  okxTimeoutMs?: number;
};

type CacheEntry = { payload: MarketHubPayload; storedAt: number };
const cacheByTier = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<MarketHubPayload>>();
let lastOkxHealth: ProviderHealth | null = null;

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

function unique(values: string[]) {
  return Array.from(new Set(values));
}

/**
 * Build OKX gap-fill plan from a Binance payload for the active tier.
 * L1: only ticker/funding gaps on symbols already present.
 * L2: also OI / positioning — never candles.
 * L3: candle gaps only (or full force path uses fullOkxFetchPlan).
 */
export function okxPlanForMissingFields(binance: ProviderPayload, tier: FetchTier = "l2"): OkxFetchPlan {
  const tickerSymbols: string[] = [];
  const fundingSymbols: string[] = [];
  const openInterestSymbols: string[] = [];
  const candleTimeframes: OkxFetchPlan["candleTimeframes"] = {};

  for (const asset of binance.assets) {
    if (tier === "l1") {
      if (asset.price === null || asset.change24h === null || asset.quoteVolume === null) tickerSymbols.push(asset.symbol);
      if (asset.funding === null) fundingSymbols.push(asset.symbol);
      continue;
    }
    if (tier === "l2") {
      if (asset.price === null || asset.change24h === null || asset.quoteVolume === null) tickerSymbols.push(asset.symbol);
      if (asset.funding === null) fundingSymbols.push(asset.symbol);
      if (asset.openInterest === null || asset.oiChange1h === null || !asset.globalRatios.length) {
        openInterestSymbols.push(asset.symbol);
      }
      continue;
    }
    // l3
    const missingTimeframes = TIMEFRAMES.filter((timeframe) => !asset.candlesByTimeframe[timeframe].length);
    if (missingTimeframes.length) candleTimeframes[asset.symbol] = missingTimeframes;
  }

  const symbols = unique([
    ...tickerSymbols,
    ...fundingSymbols,
    ...openInterestSymbols,
    ...Object.keys(candleTimeframes),
  ]);
  return { full: false, symbols, tickerSymbols, fundingSymbols, openInterestSymbols, candleTimeframes };
}

function fetchedFields(plan: OkxFetchPlan) {
  if (plan.full) return ["ticker", "funding", "openInterest", "oiChange", "longShortRatio", "candles:15m/1h/4h/1d"];
  return [
    ...plan.tickerSymbols.map((symbol) => `${symbol}:ticker`),
    ...plan.fundingSymbols.map((symbol) => `${symbol}:funding`),
    ...plan.openInterestSymbols.map((symbol) => `${symbol}:openInterest+positioning`),
    ...Object.entries(plan.candleTimeframes).flatMap(([symbol, timeframes]) =>
      (timeframes ?? []).map((timeframe) => `${symbol}:candles:${timeframe}`),
    ),
  ];
}

function okxStandbyPayload(): ProviderPayload {
  const health =
    lastOkxHealth ??
    ({
      name: "OKX" as const,
      state: "live" as const,
      latencyMs: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      consecutiveFailures: 0,
      circuitOpen: false,
      coverage: { ticker: 0, funding: 0, oi: 0, positioning: 0, candles: 0 },
      errors: [],
    } satisfies ProviderHealth);
  return { assets: [], health };
}

function cacheKey(forceOkx: boolean, tier: FetchTier) {
  return forceOkx ? `force-okx:${tier}` : `normal:${tier}`;
}

function resolveOkxPlanForTier(tier: FetchTier, binancePayload: ProviderPayload | null, hardFail: boolean): OkxFetchPlan {
  if (hardFail || !binancePayload) {
    if (tier === "l1") return okxL1Plan(symbolsForTier("l1"));
    if (tier === "l2") return okxL2Plan(symbolsForTier("l2"));
    return fullOkxFetchPlan();
  }
  const gap = okxPlanForMissingFields(binancePayload, tier);
  if (!gap.symbols.length) return gap;
  return gap;
}

export async function buildMarketHub(
  forceOkx = false,
  providers: ProviderClients = {},
  tier: FetchTier = "l2",
) {
  const startedAt = Date.now();
  const fearPromise = providers.fear ? providers.fear() : getFearGreed();
  const okxProvider = providers.okx ?? ((plan: OkxFetchPlan, signal?: AbortSignal) => getOkxData(plan, { signal }));
  const symbols = symbolsForTier(tier);
  const binancePlan = binancePlanForTier(tier, symbols);

  if (forceOkx) {
    // Force path: L3 / full includes short candles so scanner + chart still work on pure OKX
    const plan =
      tier === "l1" ? okxL1Plan(symbols) : tier === "l2" ? okxL2Plan(symbols) : fullOkxFetchPlan();
    const [okxResult, fear] = await Promise.all([
      settled(
        withDeadline("OKX force fallback", providers.okxTimeoutMs ?? OKX_FORCE_DEADLINE_MS, (signal) =>
          okxProvider(plan, signal),
        ),
      ),
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
      pipeline: {
        stage: "using-okx-fallback",
        mode: "force-okx",
        tier,
        marketApiDurationMs: duration,
        binanceDurationMs: null,
        okxDurationMs: okxHealth.latencyMs,
        okxFetchedFields: fetchedFields(plan),
      },
    });
  }

  const binanceStartedAt = Date.now();
  const binanceResult = await settled(
    withDeadline("Binance", providers.binanceTimeoutMs ?? BINANCE_DEADLINE_MS[tier], (signal) =>
      providers.binance
        ? providers.binance()
        : getBinanceData({ signal, plan: binancePlan }),
    ),
  );
  const binanceDurationMs = Date.now() - binanceStartedAt;
  const binanceHardFail = !binanceResult.value && isBinanceHardFail(binanceResult.error);
  const binancePayload = binanceResult.value?.assets.length ? binanceResult.value : null;
  const binanceHealth =
    binancePayload?.health ?? failedBinanceHealth(binanceResult.error ?? new Error("Binance returned zero assets"));

  // OKX policy (average-latency first):
  // - L1: only on hard-fail or empty Binance, or priority ticker/funding gaps
  // - L2: gap-fill OI/positioning; still no candles
  // - L3: candle gaps only
  const plan = resolveOkxPlanForTier(tier, binancePayload, binanceHardFail);
  const shouldRunOkx =
    binanceHardFail ||
    !binancePayload ||
    plan.symbols.length > 0 ||
    plan.full;

  let okxResult: { value: ProviderPayload | null; error: unknown } | null = null;
  if (shouldRunOkx) {
    const okxDeadline =
      binanceHardFail || !binancePayload
        ? (providers.okxTimeoutMs ?? OKX_DEADLINE_MS[tier])
        : (providers.okxTimeoutMs ?? OKX_DEADLINE_MS[tier]);
    const effectivePlan =
      binanceHardFail || !binancePayload
        ? tier === "l1"
          ? okxL1Plan(symbols)
          : tier === "l2"
            ? okxL2Plan(symbols)
            : fullOkxFetchPlan()
        : plan;
    okxResult = await settled(
      withDeadline("OKX fallback", okxDeadline, (signal) => okxProvider(effectivePlan, signal)),
    );
    if (okxResult.value) lastOkxHealth = okxResult.value.health;
  }

  const fear = await fearPromise;
  const okxPayload = okxResult
    ? {
        assets: okxResult.value?.assets ?? [],
        health: okxResult.value?.health ?? failedOkxHealth(okxResult.error),
      }
    : okxStandbyPayload();
  const duration = Date.now() - startedAt;
  const effectivePlanLogged =
    binanceHardFail || !binancePayload
      ? tier === "l1"
        ? okxL1Plan(symbols)
        : tier === "l2"
          ? okxL2Plan(symbols)
          : fullOkxFetchPlan()
      : plan;

  return mergeProviderPayloads({
    binance: { assets: binancePayload?.assets ?? [], health: binanceHealth },
    okx: okxPayload,
    fearGreed: fear.value,
    fearHealth: fear.health,
    staleTtlMs: STALE_TTL_MS,
    pipeline: {
      stage:
        !binancePayload || binanceHardFail
          ? "using-okx-fallback"
          : plan.symbols.length
            ? "filling-from-okx"
            : "using-binance",
      mode: "normal",
      tier,
      marketApiDurationMs: duration,
      binanceDurationMs,
      okxDurationMs: okxResult?.value?.health.latencyMs ?? null,
      okxFetchedFields: okxResult ? fetchedFields(effectivePlanLogged) : [],
    },
  });
}

/**
 * @param forceOkx — manual / test force path
 * @param providers — injectable clients (tests)
 * @param tier — l1 critical path | l2 derivatives | l3 candles/strategy
 */
export async function getMarketHub(
  forceOkx = false,
  providers?: ProviderClients,
  tier: FetchTier = "l2",
) {
  const now = Date.now();
  const key = cacheKey(forceOkx, tier);
  const freshTtl = FRESH_TTL_MS[tier];

  if (!providers && !forceOkx) {
    const hit = cacheByTier.get(key);
    if (hit && now - hit.storedAt < freshTtl) {
      return { ...hit.payload, cacheAgeMs: now - hit.storedAt };
    }
  }

  const existing = inFlight.get(key);
  if (existing) return existing;

  const task = buildMarketHub(forceOkx, providers ?? {}, tier)
    .then((payload) => {
      if (!payload.assets.length) throw new Error("Market Data Hub cannot return success with zero assets");
      if (!providers && !forceOkx) {
        cacheByTier.set(key, { payload, storedAt: Date.now() });
        // Promote L2 into a warmer L1 cache if L2 covers priority symbols (optional speed-up)
        if (tier === "l2") {
          const l1Key = cacheKey(false, "l1");
          if (!cacheByTier.has(l1Key)) {
            cacheByTier.set(l1Key, { payload, storedAt: Date.now() });
          }
        }
      }
      return payload;
    })
    .catch((error) => {
      const hit = !forceOkx ? cacheByTier.get(key) : undefined;
      const stale = hit ? markPayloadStale(hit.payload, hit.storedAt, Date.now(), STALE_TTL_MS) : null;
      if (stale) return stale;
      // Fall back to any tier cache if current tier empty
      if (!forceOkx) {
        for (const t of ["l2", "l1", "l3"] as FetchTier[]) {
          const alt = cacheByTier.get(cacheKey(false, t));
          if (alt) {
            const s = markPayloadStale(alt.payload, alt.storedAt, Date.now(), STALE_TTL_MS);
            if (s) return s;
          }
        }
      }
      throw error;
    })
    .finally(() => {
      inFlight.delete(key);
    });

  inFlight.set(key, task);
  return task;
}

/** On-demand L3 candle enrichment for specific symbols (strategy desk). */
export async function getMarketCandles(
  symbols: string[],
  providers?: ProviderClients,
): Promise<MarketHubPayload> {
  const list = symbols.length ? symbols : symbolsForTier("l1");
  return getMarketHub(false, {
    ...providers,
    binance: providers?.binance,
    okx: providers?.okx
      ? providers.okx
      : (plan, signal) => getOkxData(plan.full ? plan : okxL3CandlePlan(list), { signal }),
  }, "l3");
}

export function __setMarketCacheForTests(value: { payload: MarketHubPayload; storedAt: number } | null) {
  cacheByTier.clear();
  inFlight.clear();
  lastOkxHealth = null;
  if (value) {
    cacheByTier.set(cacheKey(false, "l2"), value);
    cacheByTier.set(cacheKey(false, "l1"), value);
  }
}
