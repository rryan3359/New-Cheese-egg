import { z } from "zod";
import { circuitHealth, delayWithSignal, fetchValidated, mapWithConcurrency } from "../http";
import { CORE_BASES, CORE_SYMBOLS } from "../symbols";
import { TIMEFRAMES, type Candle, type CandleMap, type OkxFetchPlan, type ProviderHealth, type RawAsset, type Timeframe } from "../types";

const BASES = [...CORE_BASES];
const SYMBOLS = [...CORE_SYMBOLS];
const API = "https://www.okx.com";
const envelope = <T extends z.ZodTypeAny>(data: T) => z.object({ code: z.string(), data: z.array(data) }).passthrough();
const tickerSchema = envelope(z.object({ instId: z.string(), last: z.string().transform(Number), open24h: z.string().transform(Number), volCcy24h: z.string().transform(Number), ts: z.string() }).passthrough());
const fundingSchema = envelope(z.object({ fundingRate: z.string().transform(Number), ts: z.string() }).passthrough());
const oiSchema = envelope(z.object({ oi: z.string().transform(Number), ts: z.string() }).passthrough());
const candleSchema = envelope(z.array(z.string()));
/** OKX rubik long-short account ratio: data is [[ts, ratio], ...] */
const longShortSchema = z.object({ code: z.string(), data: z.array(z.tuple([z.string(), z.string()])) }).passthrough();
/** OKX open interest history: data is [[ts, oi, oiCcy, oiUsd], ...] */
const oiHistSchema = z.object({
  code: z.string(),
  data: z.array(z.tuple([z.string(), z.string(), z.string().optional(), z.string().optional()]).rest(z.string())),
}).passthrough();
const barMap: Record<Timeframe, string> = { "15m": "15m", "1h": "1H", "4h": "4H", "1d": "1Dutc" };

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
    const intervalMs = path.endsWith("/candles") ? 750 : 180;
    const scheduledAt = Math.max(Date.now(), nextRequestAt.get(path) ?? 0);
    nextRequestAt.set(path, scheduledAt + intervalMs);
    const waitMs = scheduledAt - Date.now();
    if (waitMs > 0) await delayWithSignal(waitMs, signal);
  };
}

async function fetchOkx<T extends z.ZodTypeAny>(url: string, schema: T, schedule: (url: string) => Promise<void>, signal?: AbortSignal) {
  await schedule(url);
  try {
    return await fetchValidated("OKX", url, schema, { signal, timeoutMs: 5_500 });
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("HTTP 429")) throw error;
    await schedule(url);
    await delayWithSignal(1_000, signal);
    return fetchValidated("OKX", url, schema, { signal, timeoutMs: 5_500 });
  }
}

function toCandles(rows: string[][]): Candle[] {
  return rows.map((row) => ({
    time: Number(row[0]), open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]),
    volume: Number(row[7] ?? 0),
  })).reverse();
}

function message(reason: unknown) { return reason instanceof Error ? reason.message : String(reason); }
function requested(plan: OkxFetchPlan, field: "tickerSymbols" | "fundingSymbols" | "openInterestSymbols", symbol: string) { return plan.full || plan[field].includes(symbol); }

export async function getOkxData(plan: OkxFetchPlan = fullOkxFetchPlan(), options: { signal?: AbortSignal } = {}) {
  const startedAt = Date.now();
  const schedule = createOkxScheduler(options.signal);
  const symbols = (plan.full ? SYMBOLS : plan.symbols).filter((symbol) => SYMBOLS.includes(symbol));
  const needsTickers = plan.full || plan.tickerSymbols.some((symbol) => symbols.includes(symbol));
  const tickerResult = needsTickers ? await fetchOkx(`${API}/api/v5/market/tickers?instType=SWAP`, tickerSchema, schedule, options.signal) : null;
  const tickerMap = new Map((tickerResult?.data.data ?? []).map((item) => [item.instId, item]));

  const assets = await mapWithConcurrency(symbols, 2, async (symbol): Promise<RawAsset> => {
    const base = symbol.replace("USDT", "");
    const instId = `${base}-USDT-SWAP`;
    const timeframePlan = plan.full ? [...TIMEFRAMES] : plan.candleTimeframes[symbol] ?? [];
    const needsOi = requested(plan, "openInterestSymbols", symbol);
    const fundingPromise = requested(plan, "fundingSymbols", symbol) ? fetchOkx(`${API}/api/v5/public/funding-rate?instId=${instId}`, fundingSchema, schedule, options.signal) : null;
    const oiPromise = needsOi ? fetchOkx(`${API}/api/v5/public/open-interest?instType=SWAP&instId=${instId}`, oiSchema, schedule, options.signal) : null;
    // OI history for 1h change (period 1H, limit 2)
    const oiHistPromise = needsOi
      ? fetchOkx(`${API}/api/v5/rubik/stat/contracts/open-interest-history?instId=${instId}&period=1H&limit=2`, oiHistSchema, schedule, options.signal).catch(() => null)
      : null;
    // Global long-short account ratio (ccy-based)
    const lsPromise = needsOi
      ? fetchOkx(`${API}/api/v5/rubik/stat/contracts/long-short-account-ratio?ccy=${base}&period=1H`, longShortSchema, schedule, options.signal).catch(() => null)
      : null;

    const [fundingResult, oiResult, oiHistResult, lsResult, candleResults] = await Promise.all([
      fundingPromise ? fundingPromise.then((value) => ({ status: "fulfilled" as const, value })).catch((reason) => ({ status: "rejected" as const, reason })) : Promise.resolve(null),
      oiPromise ? oiPromise.then((value) => ({ status: "fulfilled" as const, value })).catch((reason) => ({ status: "rejected" as const, reason })) : Promise.resolve(null),
      oiHistPromise ? oiHistPromise.then((value) => value ? { status: "fulfilled" as const, value } : { status: "rejected" as const, reason: new Error("OI hist unavailable") }).catch((reason) => ({ status: "rejected" as const, reason })) : Promise.resolve(null),
      lsPromise ? lsPromise.then((value) => value ? { status: "fulfilled" as const, value } : { status: "rejected" as const, reason: new Error("LS ratio unavailable") }).catch((reason) => ({ status: "rejected" as const, reason })) : Promise.resolve(null),
      Promise.allSettled(timeframePlan.map((timeframe) => fetchOkx(`${API}/api/v5/market/candles?instId=${instId}&bar=${barMap[timeframe]}&limit=${timeframe === "1d" ? 180 : 240}`, candleSchema, schedule, options.signal))),
    ]);

    const candleMap = new Map(timeframePlan.map((timeframe, index) => [timeframe, candleResults[index]]));
    const candlesByTimeframe = Object.fromEntries(TIMEFRAMES.map((timeframe) => {
      const response = candleMap.get(timeframe);
      return [timeframe, response?.status === "fulfilled" ? toCandles(response.value.data.data) : []];
    })) as CandleMap;

    let oiChange1h: number | null = null;
    if (oiHistResult?.status === "fulfilled") {
      const rows = oiHistResult.value.data.data;
      if (rows.length >= 2) {
        // API returns newest first: [ts, oi, oiCcy, oiUsd]
        const newer = Number(rows[0][1]);
        const older = Number(rows[rows.length - 1][1]);
        if (Number.isFinite(newer) && Number.isFinite(older) && older !== 0) {
          oiChange1h = ((newer - older) / older) * 100;
        }
      }
    }

    const globalRatios: number[] = [];
    if (lsResult?.status === "fulfilled") {
      const rows = lsResult.value.data.data;
      // [[ts, ratio], ...] — take last ~30
      for (const row of rows.slice(0, 30).reverse()) {
        const ratio = Number(row[1]);
        if (Number.isFinite(ratio) && ratio > 0) globalRatios.push(ratio);
      }
    }

    const errors = [
      ...(fundingResult?.status === "rejected" ? [`${base} Funding: ${message(fundingResult.reason)}`] : []),
      ...(oiResult?.status === "rejected" ? [`${base} OI: ${message(oiResult.reason)}`] : []),
      ...(oiHistResult?.status === "rejected" ? [`${base} OI hist: ${message(oiHistResult.reason)}`] : []),
      ...(lsResult?.status === "rejected" ? [`${base} LS ratio: ${message(lsResult.reason)}`] : []),
      ...timeframePlan.flatMap((timeframe, index) => candleResults[index]?.status === "rejected" ? [`${base} ${timeframe}: ${message((candleResults[index] as PromiseRejectedResult).reason)}`] : []),
    ];
    const ticker = requested(plan, "tickerSymbols", symbol) ? tickerMap.get(instId) : undefined;
    const funding = fundingResult?.status === "fulfilled" ? fundingResult.value.data.data[0]?.fundingRate ?? null : null;
    const openInterest = oiResult?.status === "fulfilled" ? oiResult.value.data.data[0]?.oi ?? null : null;
    const change24h = ticker?.open24h ? ((ticker.last - ticker.open24h) / ticker.open24h) * 100 : null;
    const quoteVolume = ticker ? ticker.volCcy24h * ticker.last : null;
    return {
      symbol, base, price: ticker?.last ?? null, change24h, quoteVolume,
      quoteVolumeUnit: quoteVolume === null ? null : "USDT",
      quoteVolumeMethod: "OKX volCcy24h（基礎幣量）× last，正規化為估算 USDT 名目量",
      funding, openInterest, oiChange1h,
      // OKX provides account long-short ratio (global-like); no separate top-trader endpoint used here
      topRatios: [],
      globalRatios,
      candlesByTimeframe,
      latencyMs: Date.now() - startedAt, errors,
    };
  });
  const state = circuitHealth("OKX");
  const errors = assets.flatMap((asset) => asset.errors).slice(0, 12);
  const health: ProviderHealth = {
    name: "OKX", state: errors.length ? "fallback" : "live", latencyMs: Date.now() - startedAt,
    lastSuccessAt: state.lastSuccessAt, lastFailureAt: state.lastFailureAt, consecutiveFailures: state.consecutiveFailures, circuitOpen: state.circuitOpen,
    coverage: {
      ticker: assets.filter((item) => item.price !== null).length,
      funding: assets.filter((item) => item.funding !== null).length,
      oi: assets.filter((item) => item.openInterest !== null).length,
      positioning: assets.filter((item) => item.globalRatios.length >= 5).length,
      candles: assets.reduce((sum, item) => sum + TIMEFRAMES.filter((timeframe) => item.candlesByTimeframe[timeframe].length).length, 0),
    },
    errors,
  };
  return { assets, health };
}

export function failedOkxHealth(error?: unknown): ProviderHealth {
  const state = circuitHealth("OKX");
  return { name: "OKX", state: "missing", latencyMs: null, lastSuccessAt: state.lastSuccessAt, lastFailureAt: state.lastFailureAt, consecutiveFailures: state.consecutiveFailures, circuitOpen: state.circuitOpen, coverage: { ticker: 0, funding: 0, oi: 0, positioning: 0, candles: 0 }, errors: error ? [message(error)] : [] };
}
