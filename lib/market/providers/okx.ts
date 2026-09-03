import { z } from "zod";
import { circuitHealth, delayWithSignal, fetchValidated, mapWithConcurrency } from "../http";
import { CORE_SYMBOLS } from "../symbols";
import {
  CANDLE_LIMITS,
  TIMEFRAMES,
  emptyCandleMap,
  type Candle,
  type CandleMap,
  type LiquidationEvent,
  type OkxFetchPlan,
  type ProviderHealth,
  type RawAsset,
  type Timeframe,
} from "../types";

const SYMBOLS = [...CORE_SYMBOLS];
const API = (process.env.OKX_BASE_URL || "https://www.okx.com").replace(/\/+$/, "");
const envelope = <T extends z.ZodTypeAny>(data: T) =>
  z.object({ code: z.string(), data: z.array(data) }).passthrough();
const tickerSchema = envelope(
  z
    .object({
      instId: z.string(),
      last: z.string().transform(Number),
      open24h: z.string().transform(Number),
      volCcy24h: z.string().transform(Number),
      ts: z.string(),
    })
    .passthrough(),
);
const fundingSchema = envelope(
  z
    .object({
      fundingRate: z.string().transform(Number),
      ts: z.string(),
    })
    .passthrough(),
);
const oiSchema = envelope(
  z
    .object({
      oi: z.string().transform(Number),
      ts: z.string(),
    })
    .passthrough(),
);
const candleSchema = envelope(z.array(z.string()));
/** OKX rubik long-short account ratio: data is [[ts, ratio], ...] */
const longShortSchema = z
  .object({ code: z.string(), data: z.array(z.tuple([z.string(), z.string()])) })
  .passthrough();
/** OKX open interest history: data is [[ts, oi, oiCcy, oiUsd], ...] */
const oiHistSchema = z
  .object({
    code: z.string(),
    data: z.array(z.tuple([z.string(), z.string(), z.string().optional(), z.string().optional()]).rest(z.string())),
  })
  .passthrough();
const instrumentSchema = envelope(
  z.object({
    instId: z.string(),
    ctVal: z.string(),
    ctMult: z.string(),
    ctValCcy: z.string(),
  }).passthrough(),
);
const liquidationSchema = envelope(
  z.object({
    instFamily: z.string(),
    instId: z.string(),
    details: z.array(z.object({
      bkPx: z.string(),
      posSide: z.string(),
      side: z.string(),
      sz: z.string(),
      ts: z.string(),
    }).passthrough()),
  }).passthrough(),
);
const barMap: Record<Timeframe, string> = {
  "1m": "1m",
  "5m": "5m",
  "15m": "15m",
  "1h": "1H",
  "4h": "4H",
  "1d": "1Dutc",
};

export function fullOkxFetchPlan(): OkxFetchPlan {
  return {
    full: true,
    symbols: [...SYMBOLS],
    tickerSymbols: [...SYMBOLS],
    fundingSymbols: [...SYMBOLS],
    openInterestSymbols: [...SYMBOLS],
    candleTimeframes: Object.fromEntries(SYMBOLS.map((symbol) => [symbol, [...TIMEFRAMES]])),
  };
}

/** L1: ticker + funding only for given symbols (priority path) */
export function okxL1Plan(symbols: string[]): OkxFetchPlan {
  const list = symbols.filter((s) => SYMBOLS.includes(s));
  return {
    full: false,
    symbols: list,
    tickerSymbols: list,
    fundingSymbols: list,
    openInterestSymbols: [],
    candleTimeframes: {},
  };
}

/** L2: OI + positioning (+ ticker/funding gaps) — no candles */
export function okxL2Plan(symbols: string[]): OkxFetchPlan {
  const list = symbols.filter((s) => SYMBOLS.includes(s));
  return {
    full: false,
    symbols: list,
    tickerSymbols: list,
    fundingSymbols: list,
    openInterestSymbols: list,
    candleTimeframes: {},
  };
}

/** L3: short-depth candles for strategy; optional other fields */
export function okxL3CandlePlan(symbols: string[], timeframes: Timeframe[] = [...TIMEFRAMES]): OkxFetchPlan {
  const list = symbols.filter((s) => SYMBOLS.includes(s));
  return {
    full: false,
    symbols: list,
    tickerSymbols: [],
    fundingSymbols: [],
    openInterestSymbols: [],
    candleTimeframes: Object.fromEntries(list.map((symbol) => [symbol, timeframes])),
  };
}

function okxAbortError() {
  const error = new Error("OKX request deadline exceeded");
  error.name = "AbortError";
  return error;
}

function createOkxScheduler(signal?: AbortSignal) {
  const nextRequestAt = new Map<string, number>();
  return async (url: string) => {
    if (signal?.aborted) throw okxAbortError();
    const path = new URL(url).pathname;
    // OKX candles permit materially more throughput than the public account
    // endpoints. 75 ms keeps the full 30 × 6 L3 plan inside its 20 s server
    // deadline while remaining below the documented candles burst ceiling.
    const intervalMs = path.endsWith("/candles") ? 75 : path.endsWith("/liquidation-orders") ? 250 : 120;
    const scheduledAt = Math.max(Date.now(), nextRequestAt.get(path) ?? 0);
    nextRequestAt.set(path, scheduledAt + intervalMs);
    const waitMs = scheduledAt - Date.now();
    if (waitMs > 0) await delayWithSignal(waitMs, signal);
  };
}

async function fetchOkx<T extends z.ZodTypeAny>(
  url: string,
  schema: T,
  schedule: (url: string) => Promise<void>,
  signal?: AbortSignal,
) {
  await schedule(url);
  try {
    return await fetchValidated("OKX", url, schema, { signal, timeoutMs: 5_000 });
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("HTTP 429")) throw error;
    await schedule(url);
    await delayWithSignal(1_000, signal);
    return fetchValidated("OKX", url, schema, { signal, timeoutMs: 5_000 });
  }
}

function toCandles(rows: string[][]): Candle[] {
  return rows
    // OKX index 8 is the confirmation flag. Never let the live, unfinished bar
    // enter strategy, level, or backtest calculations.
    .filter((row) => row[8] === undefined || row[8] === "1")
    .map((row) => ({
      time: Number(row[0]),
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[7] ?? 0),
    }))
    .reverse();
}

function message(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason);
}

type ContractSpec = { ctVal: number; ctMult: number; ctValCcy: string };

export function contractNotionalUsd(contracts: number, price: number, spec: ContractSpec | undefined, base: string) {
  if (!spec || !Number.isFinite(contracts) || !Number.isFinite(price) || contracts <= 0 || price <= 0) return null;
  const contractSize = spec.ctVal * spec.ctMult;
  if (!Number.isFinite(contractSize) || contractSize <= 0) return null;
  if (spec.ctValCcy === base) return contracts * contractSize * price;
  if (spec.ctValCcy === "USDT" || spec.ctValCcy === "USD") return contracts * contractSize;
  return null;
}

function requested(
  plan: OkxFetchPlan,
  field: "tickerSymbols" | "fundingSymbols" | "openInterestSymbols",
  symbol: string,
) {
  return plan.full || plan[field].includes(symbol);
}

export async function getOkxData(plan: OkxFetchPlan = fullOkxFetchPlan(), options: { signal?: AbortSignal } = {}) {
  const startedAt = Date.now();
  const schedule = createOkxScheduler(options.signal);
  const symbols = (plan.full ? SYMBOLS : plan.symbols).filter((symbol) => SYMBOLS.includes(symbol));
  const needsTickers = plan.full || plan.tickerSymbols.some((symbol) => symbols.includes(symbol));
  const tickerResult = needsTickers
    ? await fetchOkx(`${API}/api/v5/market/tickers?instType=SWAP`, tickerSchema, schedule, options.signal)
    : null;
  const tickerMap = new Map((tickerResult?.data.data ?? []).map((item) => [item.instId, item]));
  const needsDerivatives = plan.full || plan.openInterestSymbols.some((symbol) => symbols.includes(symbol));
  const instrumentResult = needsDerivatives
    ? await fetchOkx(`${API}/api/v5/public/instruments?instType=SWAP`, instrumentSchema, schedule, options.signal).catch(() => null)
    : null;
  const instrumentMap = new Map((instrumentResult?.data.data ?? []).map((item) => [item.instId, {
    ctVal: Number(item.ctVal),
    ctMult: Number(item.ctMult),
    ctValCcy: item.ctValCcy,
  }]));

  const concurrency = Object.keys(plan.candleTimeframes).length || plan.full ? 3 : 5;
  const assets = await mapWithConcurrency(symbols, concurrency, async (symbol): Promise<RawAsset> => {
    const base = symbol.replace("USDT", "");
    const instId = `${base}-USDT-SWAP`;
    const timeframePlan = plan.full ? [...TIMEFRAMES] : (plan.candleTimeframes[symbol] ?? []);
    const needsOi = requested(plan, "openInterestSymbols", symbol);
    const fundingPromise = requested(plan, "fundingSymbols", symbol)
      ? fetchOkx(`${API}/api/v5/public/funding-rate?instId=${instId}`, fundingSchema, schedule, options.signal)
      : null;
    const oiPromise = needsOi
      ? fetchOkx(`${API}/api/v5/public/open-interest?instType=SWAP&instId=${instId}`, oiSchema, schedule, options.signal)
      : null;
    const oiHistPromise = needsOi
      ? fetchOkx(
          `${API}/api/v5/rubik/stat/contracts/open-interest-history?instId=${instId}&period=1H&limit=2`,
          oiHistSchema,
          schedule,
          options.signal,
        ).catch(() => null)
      : null;
    const lsPromise = needsOi
      ? fetchOkx(
          `${API}/api/v5/rubik/stat/contracts/long-short-account-ratio?ccy=${base}&period=1H`,
          longShortSchema,
          schedule,
          options.signal,
        ).catch(() => null)
      : null;
    // Top traders (top ~5% by position value) — OKX equivalent of Binance top long/short ratio
    const topLsPromise = needsOi
      ? fetchOkx(
          `${API}/api/v5/rubik/stat/contracts/long-short-account-ratio-contract-top-trader?instId=${instId}&period=1H`,
          longShortSchema,
          schedule,
          options.signal,
        ).catch(() => null)
      : null;
    const topPositionPromise = needsOi
      ? fetchOkx(
          `${API}/api/v5/rubik/stat/contracts/long-short-position-ratio-contract-top-trader?instId=${instId}&period=1H`,
          longShortSchema,
          schedule,
          options.signal,
        ).catch(() => null)
      : null;
    const liquidationPromise = needsOi
      ? fetchOkx(
          `${API}/api/v5/public/liquidation-orders?instType=SWAP&instFamily=${base}-USDT&state=filled&limit=100`,
          liquidationSchema,
          schedule,
          options.signal,
        ).catch(() => null)
      : null;

    const candleLimit = (tf: Timeframe) => CANDLE_LIMITS[tf];

    const [fundingResult, oiResult, oiHistResult, lsResult, topLsResult, topPositionResult, liquidationResult, candleResults] = await Promise.all([
      fundingPromise
        ? fundingPromise
            .then((value) => ({ status: "fulfilled" as const, value }))
            .catch((reason) => ({ status: "rejected" as const, reason }))
        : Promise.resolve(null),
      oiPromise
        ? oiPromise
            .then((value) => ({ status: "fulfilled" as const, value }))
            .catch((reason) => ({ status: "rejected" as const, reason }))
        : Promise.resolve(null),
      oiHistPromise
        ? oiHistPromise
            .then((value) =>
              value
                ? { status: "fulfilled" as const, value }
                : { status: "rejected" as const, reason: new Error("OI hist unavailable") },
            )
            .catch((reason) => ({ status: "rejected" as const, reason }))
        : Promise.resolve(null),
      lsPromise
        ? lsPromise
            .then((value) =>
              value
                ? { status: "fulfilled" as const, value }
                : { status: "rejected" as const, reason: new Error("LS ratio unavailable") },
            )
            .catch((reason) => ({ status: "rejected" as const, reason }))
        : Promise.resolve(null),
      topLsPromise
        ? topLsPromise
            .then((value) =>
              value
                ? { status: "fulfilled" as const, value }
                : { status: "rejected" as const, reason: new Error("Top LS ratio unavailable") },
            )
            .catch((reason) => ({ status: "rejected" as const, reason }))
        : Promise.resolve(null),
      topPositionPromise
        ? topPositionPromise
            .then((value) => value
              ? { status: "fulfilled" as const, value }
              : { status: "rejected" as const, reason: new Error("Top position ratio unavailable") })
            .catch((reason) => ({ status: "rejected" as const, reason }))
        : Promise.resolve(null),
      liquidationPromise
        ? liquidationPromise
            .then((value) => value
              ? { status: "fulfilled" as const, value }
              : { status: "rejected" as const, reason: new Error("Liquidations unavailable") })
            .catch((reason) => ({ status: "rejected" as const, reason }))
        : Promise.resolve(null),
      Promise.allSettled(
        timeframePlan.map((timeframe) =>
          fetchOkx(
            `${API}/api/v5/market/candles?instId=${instId}&bar=${barMap[timeframe]}&limit=${candleLimit(timeframe)}`,
            candleSchema,
            schedule,
            options.signal,
          ),
        ),
      ),
    ]);

    const candleMap = new Map(timeframePlan.map((timeframe, index) => [timeframe, candleResults[index]]));
    const candlesByTimeframe = Object.fromEntries(
      TIMEFRAMES.map((timeframe) => {
        const response = candleMap.get(timeframe);
        return [
          timeframe,
          response?.status === "fulfilled" ? toCandles(response.value.data.data) : [],
        ];
      }),
    ) as CandleMap;

    let oiChange1h: number | null = null;
    if (oiHistResult?.status === "fulfilled") {
      const rows = oiHistResult.value.data.data;
      if (rows.length >= 2) {
        const newer = Number(rows[0][1]);
        const older = Number(rows[rows.length - 1][1]);
        if (Number.isFinite(newer) && Number.isFinite(older) && older !== 0) {
          oiChange1h = ((newer - older) / older) * 100;
        }
      }
    }

    const parseRatioSeries = (rows: [string, string][] | undefined): number[] => {
      const out: number[] = [];
      if (!rows?.length) return out;
      for (const row of rows.slice(0, 30).reverse()) {
        const ratio = Number(row[1]);
        if (Number.isFinite(ratio) && ratio > 0) out.push(ratio);
      }
      return out;
    };

    const globalRatios =
      lsResult?.status === "fulfilled" ? parseRatioSeries(lsResult.value.data.data as [string, string][]) : [];
    const topRatios =
      topLsResult?.status === "fulfilled" ? parseRatioSeries(topLsResult.value.data.data as [string, string][]) : [];
    const topPositionRatios =
      topPositionResult?.status === "fulfilled" ? parseRatioSeries(topPositionResult.value.data.data as [string, string][]) : [];
    const contractSpec = instrumentMap.get(instId);
    const liquidationEvents: LiquidationEvent[] = liquidationResult?.status === "fulfilled"
      ? liquidationResult.value.data.data.flatMap((group) => group.details).flatMap((detail, index) => {
          const bankruptcyPrice = Number(detail.bkPx);
          const contracts = Number(detail.sz);
          const occurredMs = Number(detail.ts);
          if (!Number.isFinite(bankruptcyPrice) || bankruptcyPrice <= 0 || !Number.isFinite(contracts) || contracts <= 0 || !Number.isFinite(occurredMs)) return [];
          const positionSide: LiquidationEvent["positionSide"] = detail.posSide === "long" || (detail.posSide !== "short" && detail.side === "sell") ? "Long" : "Short";
          return [{
            id: `${symbol}-${detail.ts}-${index}-${detail.sz}`,
            symbol,
            positionSide,
            bankruptcyPrice,
            contracts,
            notionalUsd: contractNotionalUsd(contracts, bankruptcyPrice, contractSpec, base),
            occurredAt: new Date(occurredMs).toISOString(),
            source: "OKX" as const,
          }];
        }).sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
      : [];

    const errors = [
      ...(fundingResult?.status === "rejected" ? [`${base} Funding: ${message(fundingResult.reason)}`] : []),
      ...(oiResult?.status === "rejected" ? [`${base} OI: ${message(oiResult.reason)}`] : []),
      ...(oiHistResult?.status === "rejected" ? [`${base} OI hist: ${message(oiHistResult.reason)}`] : []),
      ...(lsResult?.status === "rejected" ? [`${base} LS ratio: ${message(lsResult.reason)}`] : []),
      ...(topLsResult?.status === "rejected" ? [`${base} Top LS: ${message(topLsResult.reason)}`] : []),
      ...(topPositionResult?.status === "rejected" ? [`${base} Top position: ${message(topPositionResult.reason)}`] : []),
      ...(liquidationResult?.status === "rejected" ? [`${base} liquidations: ${message(liquidationResult.reason)}`] : []),
      ...timeframePlan.flatMap((timeframe, index) =>
        candleResults[index]?.status === "rejected"
          ? [`${base} ${timeframe}: ${message((candleResults[index] as PromiseRejectedResult).reason)}`]
          : [],
      ),
    ];
    const ticker = requested(plan, "tickerSymbols", symbol) ? tickerMap.get(instId) : undefined;
    const funding =
      fundingResult?.status === "fulfilled" ? (fundingResult.value.data.data[0]?.fundingRate ?? null) : null;
    const openInterest =
      oiResult?.status === "fulfilled" ? (oiResult.value.data.data[0]?.oi ?? null) : null;
    const change24h = ticker?.open24h ? ((ticker.last - ticker.open24h) / ticker.open24h) * 100 : null;
    const quoteVolume = ticker ? ticker.volCcy24h * ticker.last : null;
    return {
      symbol,
      base,
      price: ticker?.last ?? null,
      change24h,
      quoteVolume,
      quoteVolumeUnit: quoteVolume === null ? null : "USDT",
      quoteVolumeMethod: "OKX volCcy24h（幣幣量）× last，正規化為估算 USDT 名目量",
      funding,
      openInterest,
      oiChange1h,
      topRatios,
      topPositionRatios,
      globalRatios,
      liquidationEvents,
      liquidationAvailable: liquidationResult?.status === "fulfilled",
      candlesByTimeframe: timeframePlan.length ? candlesByTimeframe : emptyCandleMap(),
      latencyMs: Date.now() - startedAt,
      errors,
    };
  });

  const state = circuitHealth("OKX");
  const errors = assets.flatMap((asset) => asset.errors).slice(0, 12);
  const health: ProviderHealth = {
    name: "OKX",
    state: assets.some((asset) => asset.price !== null || TIMEFRAMES.some((timeframe) => asset.candlesByTimeframe[timeframe].length)) ? "live" : "missing",
    latencyMs: Date.now() - startedAt,
    lastSuccessAt: state.lastSuccessAt,
    lastFailureAt: state.lastFailureAt,
    consecutiveFailures: state.consecutiveFailures,
    circuitOpen: state.circuitOpen,
    coverage: {
      ticker: assets.filter((item) => item.price !== null).length,
      funding: assets.filter((item) => item.funding !== null).length,
      oi: assets.filter((item) => item.openInterest !== null).length,
      positioning: assets.filter((item) => item.globalRatios.length >= 5).length,
      candles: assets.reduce(
        (sum, item) => sum + TIMEFRAMES.filter((timeframe) => item.candlesByTimeframe[timeframe].length).length,
        0,
      ),
    },
    errors,
  };
  return { assets, health };
}

export function failedOkxHealth(error?: unknown): ProviderHealth {
  const state = circuitHealth("OKX");
  return {
    name: "OKX",
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
