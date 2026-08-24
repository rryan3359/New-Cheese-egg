import { z } from "zod";
import { circuitHealth, fetchValidated, mapWithConcurrency } from "../http";
import { CORE_SYMBOLS } from "../symbols";
import {
  CANDLE_LIMITS,
  TIMEFRAMES,
  emptyCandleMap,
  type BinanceFetchPlan,
  type Candle,
  type CandleMap,
  type FieldGroup,
  type ProviderHealth,
  type RawAsset,
  type Timeframe,
} from "../types";

const DESIRED = [...CORE_SYMBOLS];
const API = "https://fapi.binance.com";
const numberString = z.string().transform(Number);
const tickerSchema = z.array(
  z
    .object({
      symbol: z.string(),
      lastPrice: numberString,
      priceChangePercent: numberString,
      quoteVolume: numberString,
    })
    .passthrough(),
);
const premiumSchema = z.array(
  z
    .object({
      symbol: z.string(),
      lastFundingRate: numberString,
    })
    .passthrough(),
);
const exchangeSchema = z
  .object({
    symbols: z.array(
      z
        .object({
          symbol: z.string(),
          status: z.string(),
          contractType: z.string(),
          quoteAsset: z.string(),
          underlyingType: z.string().optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();
const oiSchema = z.object({ openInterest: numberString }).passthrough();
const oiHistorySchema = z.array(
  z
    .object({
      sumOpenInterest: numberString,
      timestamp: z.number(),
    })
    .passthrough(),
);
const ratioSchema = z.array(
  z
    .object({
      longShortRatio: numberString,
      timestamp: z.number(),
    })
    .passthrough(),
);
const klineSchema = z.array(z.array(z.union([z.string(), z.number()])));

const intervalMap: Record<Timeframe, string> = {
  "15m": "15m",
  "1h": "1h",
  "4h": "4h",
  "1d": "1d",
};

function toCandles(rows: Array<Array<string | number>>): Candle[] {
  return rows.map((row) => ({
    time: Number(row[0]),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
  }));
}

function message(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason);
}

function hasField(fields: FieldGroup[], field: FieldGroup) {
  return fields.includes(field);
}

/** Fast-fail statuses that should immediately trigger OKX fallback (geo-block, forbidden, etc.) */
export function isBinanceHardFail(error: unknown): boolean {
  const msg = message(error);
  return /HTTP (403|451|418|502|503)/.test(msg) || /circuit open/i.test(msg) || /exceeded .*deadline/i.test(msg);
}

export function binancePlanForTier(
  tier: "l1" | "l2" | "l3",
  symbols: string[],
): BinanceFetchPlan {
  if (tier === "l1") {
    // Critical path: bulk ticker + funding only
    return { symbols, fields: ["ticker", "funding"] };
  }
  if (tier === "l2") {
    // Derivatives desk: OI / positioning, still no K (charts/strategies come from L3)
    return { symbols, fields: ["ticker", "funding", "oi", "positioning"] };
  }
  // L3: short-depth candles for strategy engine (chart UI uses TradingView; not full multi-TF deep K).
  // Keep bulk ticker+funding so server-side strategy eval has funding; OI comes from L2 merge.
  return {
    symbols,
    fields: ["ticker", "funding", "candles"],
    candleLimits: { ...CANDLE_LIMITS },
  };
}

export async function getBinanceData(
  options: {
    signal?: AbortSignal;
    symbols?: string[];
    /** Explicit plan; when omitted uses full legacy-ish fields without deep candles preference */
    plan?: BinanceFetchPlan;
  } = {},
) {
  const startedAt = Date.now();
  const signal = options.signal;
  const plan: BinanceFetchPlan = options.plan ?? {
    symbols: options.symbols?.length ? options.symbols : DESIRED,
    fields: ["ticker", "funding", "oi", "positioning", "candles"],
    candleLimits: { ...CANDLE_LIMITS },
  };
  const wantTicker = hasField(plan.fields, "ticker");
  const wantFunding = hasField(plan.fields, "funding");
  const wantOi = hasField(plan.fields, "oi");
  const wantPositioning = hasField(plan.fields, "positioning");
  const wantCandles = hasField(plan.fields, "candles");

  // Bulk endpoints — always cheap relative to per-symbol fan-out
  const bulkPromises: [
    ReturnType<typeof fetchValidated<typeof exchangeSchema>>,
    ReturnType<typeof fetchValidated<typeof tickerSchema>> | Promise<null>,
    ReturnType<typeof fetchValidated<typeof premiumSchema>> | Promise<null>,
  ] = [
    fetchValidated("Binance", `${API}/fapi/v1/exchangeInfo`, exchangeSchema, {
      signal,
      timeoutMs: 4_000,
    }),
    wantTicker
      ? fetchValidated("Binance", `${API}/fapi/v1/ticker/24hr`, tickerSchema, {
          signal,
          timeoutMs: 4_000,
        })
      : Promise.resolve(null),
    wantFunding
      ? fetchValidated("Binance", `${API}/fapi/v1/premiumIndex`, premiumSchema, {
          signal,
          timeoutMs: 4_000,
        })
      : Promise.resolve(null),
  ];

  const [exchange, tickers, premiums] = await Promise.all(bulkPromises);
  const eligible = new Set(
    exchange.data.symbols
      .filter(
        (item) =>
          item.status === "TRADING" &&
          item.contractType === "PERPETUAL" &&
          item.quoteAsset === "USDT" &&
          (item.underlyingType ?? "COIN") === "COIN",
      )
      .map((item) => item.symbol),
  );
  const desired = plan.symbols.length ? plan.symbols : DESIRED;
  const symbols = desired.filter((symbol) => eligible.has(symbol));
  const tickerMap = new Map((tickers?.data ?? []).map((item) => [item.symbol, item]));
  const premiumMap = new Map((premiums?.data ?? []).map((item) => [item.symbol, item]));

  // L1: no per-symbol fan-out — bulk data is enough
  if (!wantOi && !wantPositioning && !wantCandles) {
    const assets: RawAsset[] = symbols.map((symbol) => {
      const ticker = tickerMap.get(symbol);
      const premium = premiumMap.get(symbol);
      return {
        symbol,
        base: symbol.replace("USDT", ""),
        price: ticker?.lastPrice ?? null,
        change24h: ticker?.priceChangePercent ?? null,
        quoteVolume: ticker?.quoteVolume ?? null,
        quoteVolumeUnit: ticker?.quoteVolume !== undefined ? "USDT" : null,
        quoteVolumeMethod: "Binance ticker quoteVolume（USDT 報價成交額）",
        funding: premium?.lastFundingRate ?? null,
        openInterest: null,
        oiChange1h: null,
        topRatios: [],
        globalRatios: [],
        candlesByTimeframe: emptyCandleMap(),
        latencyMs: Date.now() - startedAt,
        errors: [],
      };
    });
    return finalize(assets, startedAt);
  }

  const concurrency = wantCandles ? 3 : 4;
  const assets = await mapWithConcurrency(symbols, concurrency, async (symbol): Promise<RawAsset> => {
    const coreRequests: Array<Promise<unknown> | null> = [
      wantOi
        ? fetchValidated("Binance", `${API}/fapi/v1/openInterest?symbol=${symbol}`, oiSchema, {
            signal,
            timeoutMs: 4_000,
          })
        : null,
      wantOi
        ? fetchValidated(
            "Binance",
            `${API}/futures/data/openInterestHist?symbol=${symbol}&period=1h&limit=2`,
            oiHistorySchema,
            { signal, timeoutMs: 4_000 },
          )
        : null,
      wantPositioning
        ? fetchValidated(
            "Binance",
            `${API}/futures/data/topLongShortPositionRatio?symbol=${symbol}&period=1h&limit=30`,
            ratioSchema,
            { signal, timeoutMs: 4_000 },
          )
        : null,
      wantPositioning
        ? fetchValidated(
            "Binance",
            `${API}/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=1h&limit=30`,
            ratioSchema,
            { signal, timeoutMs: 4_000 },
          )
        : null,
    ];

    const candleRequests = wantCandles
      ? TIMEFRAMES.map((timeframe) => {
          const limit = plan.candleLimits?.[timeframe] ?? CANDLE_LIMITS[timeframe];
          return fetchValidated(
            "Binance",
            `${API}/fapi/v1/klines?symbol=${symbol}&interval=${intervalMap[timeframe]}&limit=${limit}`,
            klineSchema,
            { signal, timeoutMs: 4_500 },
          );
        })
      : [];

    const [coreResults, candleResults] = await Promise.all([
      Promise.allSettled(coreRequests.map((req) => (req ? req : Promise.resolve(null)))),
      Promise.allSettled(candleRequests),
    ]);

    const [oiResult, historyResult, topResult, globalResult] = coreResults;
    const ticker = tickerMap.get(symbol);
    const premium = premiumMap.get(symbol);

    const oiHistory =
      historyResult.status === "fulfilled" && historyResult.value
        ? (historyResult.value as { data: z.infer<typeof oiHistorySchema> }).data
        : [];
    const currentOi =
      oiResult.status === "fulfilled" && oiResult.value
        ? (oiResult.value as { data: z.infer<typeof oiSchema> }).data.openInterest
        : (oiHistory.at(-1)?.sumOpenInterest ?? null);
    const oiChange1h =
      oiHistory.length >= 2 && oiHistory[0].sumOpenInterest
        ? ((oiHistory.at(-1)!.sumOpenInterest - oiHistory[0].sumOpenInterest) / oiHistory[0].sumOpenInterest) * 100
        : null;

    let candlesByTimeframe = emptyCandleMap();
    if (wantCandles) {
      candlesByTimeframe = Object.fromEntries(
        TIMEFRAMES.map((timeframe, index) => {
          const response = candleResults[index];
          return [
            timeframe,
            response?.status === "fulfilled"
              ? toCandles((response.value as { data: Array<Array<string | number>> }).data)
              : [],
          ];
        }),
      ) as CandleMap;
    }

    const errors = [
      ...coreResults.flatMap((result, index) =>
        result.status === "rejected"
          ? [`${symbol} ${["OI", "OI history", "Top ratio", "Global ratio"][index]}: ${message(result.reason)}`]
          : [],
      ),
      ...candleResults.flatMap((result, index) =>
        result.status === "rejected" ? [`${symbol} ${TIMEFRAMES[index]}: ${message(result.reason)}`] : [],
      ),
    ];

    return {
      symbol,
      base: symbol.replace("USDT", ""),
      price: ticker?.lastPrice ?? null,
      change24h: ticker?.priceChangePercent ?? null,
      quoteVolume: ticker?.quoteVolume ?? null,
      quoteVolumeUnit: ticker?.quoteVolume !== undefined ? "USDT" : null,
      quoteVolumeMethod: "Binance ticker quoteVolume（USDT 報價成交額）",
      funding: premium?.lastFundingRate ?? null,
      openInterest: wantOi ? currentOi : null,
      oiChange1h: wantOi ? oiChange1h : null,
      topRatios:
        wantPositioning && topResult.status === "fulfilled" && topResult.value
          ? (topResult.value as { data: z.infer<typeof ratioSchema> }).data.map((item) => item.longShortRatio)
          : [],
      globalRatios:
        wantPositioning && globalResult.status === "fulfilled" && globalResult.value
          ? (globalResult.value as { data: z.infer<typeof ratioSchema> }).data.map((item) => item.longShortRatio)
          : [],
      candlesByTimeframe,
      latencyMs: Date.now() - startedAt,
      errors,
    };
  });

  return finalize(assets, startedAt);
}

function finalize(assets: RawAsset[], startedAt: number) {
  const healthState = circuitHealth("Binance");
  const errors = assets.flatMap((asset) => asset.errors).slice(0, 12);
  const health: ProviderHealth = {
    name: "Binance",
    state: errors.length ? "fallback" : "live",
    latencyMs: Date.now() - startedAt,
    lastSuccessAt: healthState.lastSuccessAt,
    lastFailureAt: healthState.lastFailureAt,
    consecutiveFailures: healthState.consecutiveFailures,
    circuitOpen: healthState.circuitOpen,
    coverage: {
      ticker: assets.filter((item) => item.price !== null).length,
      funding: assets.filter((item) => item.funding !== null).length,
      oi: assets.filter((item) => item.openInterest !== null).length,
      positioning: assets.filter((item) => item.topRatios.length && item.globalRatios.length).length,
      candles: assets.reduce(
        (sum, item) => sum + TIMEFRAMES.filter((timeframe) => item.candlesByTimeframe[timeframe].length).length,
        0,
      ),
    },
    errors,
  };
  return { assets, health };
}

export function failedBinanceHealth(error?: unknown): ProviderHealth {
  const state = circuitHealth("Binance");
  return {
    name: "Binance",
    state: "missing",
    latencyMs: null,
    lastSuccessAt: state.lastSuccessAt,
    lastFailureAt: state.lastFailureAt,
    consecutiveFailures: state.consecutiveFailures,
    circuitOpen: state.circuitOpen,
    coverage: { ticker: 0, funding: 0, oi: 0, positioning: 0, candles: 0 },
    errors: error ? [message(error)] : [],
  };
}
