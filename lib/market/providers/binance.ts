import { z } from "zod";
import { circuitHealth, fetchValidated, mapWithConcurrency } from "../http";
import { TIMEFRAMES, type Candle, type CandleMap, type ProviderHealth, type RawAsset, type Timeframe } from "../types";

const DESIRED = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT", "ADAUSDT", "AVAXUSDT"];
const API = "https://fapi.binance.com";
const numberString = z.string().transform(Number);
const tickerSchema = z.array(z.object({ symbol: z.string(), lastPrice: numberString, priceChangePercent: numberString, quoteVolume: numberString }).passthrough());
const premiumSchema = z.array(z.object({ symbol: z.string(), lastFundingRate: numberString }).passthrough());
const exchangeSchema = z.object({ symbols: z.array(z.object({ symbol: z.string(), status: z.string(), contractType: z.string(), quoteAsset: z.string(), underlyingType: z.string().optional() }).passthrough()) }).passthrough();
const oiSchema = z.object({ openInterest: numberString }).passthrough();
const oiHistorySchema = z.array(z.object({ sumOpenInterest: numberString, timestamp: z.number() }).passthrough());
const ratioSchema = z.array(z.object({ longShortRatio: numberString, timestamp: z.number() }).passthrough());
const klineSchema = z.array(z.array(z.union([z.string(), z.number()])));

const intervalMap: Record<Timeframe, string> = { "15m": "15m", "1h": "1h", "4h": "4h", "1d": "1d" };

function toCandles(rows: Array<Array<string | number>>): Candle[] {
  return rows.map((row) => ({ time: Number(row[0]), open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]), volume: Number(row[5]) }));
}

function message(reason: unknown) { return reason instanceof Error ? reason.message : String(reason); }

export async function getBinanceData() {
  const startedAt = Date.now();
  const [exchange, tickers, premiums] = await Promise.all([
    fetchValidated("Binance", `${API}/fapi/v1/exchangeInfo`, exchangeSchema),
    fetchValidated("Binance", `${API}/fapi/v1/ticker/24hr`, tickerSchema),
    fetchValidated("Binance", `${API}/fapi/v1/premiumIndex`, premiumSchema),
  ]);
  const eligible = new Set(exchange.data.symbols.filter((item) => item.status === "TRADING" && item.contractType === "PERPETUAL" && item.quoteAsset === "USDT" && (item.underlyingType ?? "COIN") === "COIN").map((item) => item.symbol));
  const symbols = DESIRED.filter((symbol) => eligible.has(symbol));
  const tickerMap = new Map(tickers.data.map((item) => [item.symbol, item]));
  const premiumMap = new Map(premiums.data.map((item) => [item.symbol, item]));

  const assets = await mapWithConcurrency(symbols, 2, async (symbol): Promise<RawAsset> => {
    const coreRequests = [
      fetchValidated("Binance", `${API}/fapi/v1/openInterest?symbol=${symbol}`, oiSchema),
      fetchValidated("Binance", `${API}/futures/data/openInterestHist?symbol=${symbol}&period=1h&limit=2`, oiHistorySchema),
      fetchValidated("Binance", `${API}/futures/data/topLongShortPositionRatio?symbol=${symbol}&period=1h&limit=30`, ratioSchema),
      fetchValidated("Binance", `${API}/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=1h&limit=30`, ratioSchema),
    ] as const;
    const [coreResults, candleResults] = await Promise.all([
      Promise.allSettled(coreRequests),
      Promise.allSettled(TIMEFRAMES.map((timeframe) => fetchValidated("Binance", `${API}/fapi/v1/klines?symbol=${symbol}&interval=${intervalMap[timeframe]}&limit=${timeframe === "1d" ? 180 : 240}`, klineSchema))),
    ]);
    const [oiResult, historyResult, topResult, globalResult] = coreResults;
    const ticker = tickerMap.get(symbol);
    const premium = premiumMap.get(symbol);
    const oiHistory = historyResult.status === "fulfilled" ? historyResult.value.data : [];
    const currentOi = oiResult.status === "fulfilled" ? oiResult.value.data.openInterest : oiHistory.at(-1)?.sumOpenInterest ?? null;
    const oiChange1h = oiHistory.length >= 2 && oiHistory[0].sumOpenInterest
      ? ((oiHistory.at(-1)!.sumOpenInterest - oiHistory[0].sumOpenInterest) / oiHistory[0].sumOpenInterest) * 100
      : null;
    const candlesByTimeframe = Object.fromEntries(TIMEFRAMES.map((timeframe, index) => {
      const response = candleResults[index];
      return [timeframe, response.status === "fulfilled" ? toCandles(response.value.data) : []];
    })) as CandleMap;
    const errors = [
      ...coreResults.flatMap((result, index) => result.status === "rejected" ? [`${symbol} ${["OI", "OI history", "Top ratio", "Global ratio"][index]}: ${message(result.reason)}`] : []),
      ...candleResults.flatMap((result, index) => result.status === "rejected" ? [`${symbol} ${TIMEFRAMES[index]}: ${message(result.reason)}`] : []),
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
      openInterest: currentOi,
      oiChange1h,
      topRatios: topResult.status === "fulfilled" ? topResult.value.data.map((item) => item.longShortRatio) : [],
      globalRatios: globalResult.status === "fulfilled" ? globalResult.value.data.map((item) => item.longShortRatio) : [],
      candlesByTimeframe,
      latencyMs: Date.now() - startedAt,
      errors,
    };
  });

  const healthState = circuitHealth("Binance");
  const errors = assets.flatMap((asset) => asset.errors).slice(0, 12);
  const health: ProviderHealth = {
    name: "Binance", state: errors.length ? "fallback" : "live", latencyMs: Date.now() - startedAt,
    lastSuccessAt: healthState.lastSuccessAt, lastFailureAt: healthState.lastFailureAt,
    consecutiveFailures: healthState.consecutiveFailures, circuitOpen: healthState.circuitOpen,
    coverage: { ticker: assets.filter((item) => item.price !== null).length, funding: assets.filter((item) => item.funding !== null).length, oi: assets.filter((item) => item.openInterest !== null).length, positioning: assets.filter((item) => item.topRatios.length && item.globalRatios.length).length, candles: assets.reduce((sum, item) => sum + TIMEFRAMES.filter((timeframe) => item.candlesByTimeframe[timeframe].length).length, 0) },
    errors,
  };
  return { assets, health };
}

export function failedBinanceHealth(error?: unknown): ProviderHealth {
  const state = circuitHealth("Binance");
  return { name: "Binance", state: "missing", latencyMs: null, lastSuccessAt: state.lastSuccessAt, lastFailureAt: state.lastFailureAt, consecutiveFailures: state.consecutiveFailures, circuitOpen: state.circuitOpen, coverage: { ticker: 0, funding: 0, oi: 0, positioning: 0, candles: 0 }, errors: error ? [message(error)] : [] };
}

