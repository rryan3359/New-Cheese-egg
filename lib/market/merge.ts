import { adxApprox, atr, bollinger, changeOver, ema, positioningScore, rollingBounds, rsi, swingLevels, volumeStats } from "./indicators";
import { evaluateStrategies } from "./strategies";
import { TIMEFRAMES, type AssetSnapshot, type DataState, type MarketHubPayload, type Metric, type ProviderPayload, type StrategyResult, type Timeframe, type TimeframeSnapshot } from "./types";

const NAMES: Record<string, string> = { BTC: "Bitcoin", ETH: "Ethereum", SOL: "Solana", BNB: "BNB", XRP: "XRP", DOGE: "Dogecoin", ADA: "Cardano", AVAX: "Avalanche" };

export function metric<T>(value: T | null, source: Metric<T>["source"], state: DataState, latencyMs: number | null, reason: string | null = null, now = new Date().toISOString()): Metric<T> {
  return { value, source, state, updatedAt: now, latencyMs, reason };
}

export function chooseMetric<T>(primary: T | null | undefined, fallback: T | null | undefined, primaryLatency: number | null, fallbackLatency: number | null, missingReason: string, now: string): Metric<T> {
  if (primary !== null && primary !== undefined) return metric(primary, "Binance", "live", primaryLatency, null, now);
  if (fallback !== null && fallback !== undefined) return metric(fallback, "OKX", "fallback", fallbackLatency, "Binance 欄位缺少，已由 OKX 接手", now);
  return metric<T>(null, "Calculated", "missing", null, missingReason, now);
}

function calculated<T>(value: T | null, source: "Binance" | "OKX" | "Calculated", state: DataState, latency: number | null, reason: string, now: string) {
  return metric(value, source, value === null ? "missing" : state, latency, value === null ? reason : null, now);
}

function buildTimeframe(timeframe: Timeframe, candles: TimeframeSnapshot["candles"], source: "Binance" | "OKX" | "Calculated", state: DataState, latency: number | null, now: string): TimeframeSnapshot {
  const closes = candles.map((candle) => candle.close);
  const currentAtr = atr(candles);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const bands = bollinger(closes);
  const volume = volumeStats(candles);
  const bounds = rollingBounds(candles, 20, true);
  const swings = swingLevels(candles.slice(0, -1));
  const trend = ema20 !== null && ema50 !== null && closes.length
    ? closes.at(-1)! > ema20 && ema20 > ema50 ? "Trend Up" : closes.at(-1)! < ema20 && ema20 < ema50 ? "Trend Down" : "Range"
    : null;
  const ratio = currentAtr !== null && closes.at(-1) ? currentAtr / closes.at(-1)! : null;
  const volatility = ratio === null ? null : ratio > .025 ? "High" : ratio < .008 ? "Low" : "Normal";
  const reason = `${timeframe} K 線不足`;
  return {
    timeframe, candles,
    change: calculated(changeOver(candles, 1), source, state, latency, reason, now),
    ema20: calculated(ema20, source, state, latency, "EMA20 資料不足", now),
    ema50: calculated(ema50, source, state, latency, "EMA50 資料不足", now),
    rsi: calculated(rsi(closes), source, state, latency, "RSI 資料不足", now),
    atr: calculated(currentAtr, source, state, latency, "ATR 資料不足", now),
    adx: calculated(adxApprox(candles), source, state, latency, "ADX proxy 資料不足", now),
    bollingerUpper: calculated(bands?.upper ?? null, source, state, latency, "Bollinger 資料不足", now),
    bollingerMiddle: calculated(bands?.middle ?? null, source, state, latency, "Bollinger 資料不足", now),
    bollingerLower: calculated(bands?.lower ?? null, source, state, latency, "Bollinger 資料不足", now),
    bollingerWidth: calculated(bands?.width ?? null, source, state, latency, "BB Width 資料不足", now),
    volumeMean: calculated(volume?.mean ?? null, source, state, latency, "成交量均值資料不足", now),
    volumeZScore: calculated(volume?.zScore ?? null, source, state, latency, "成交量 z-score 資料不足", now),
    rollingHigh: calculated(bounds?.high ?? null, source, state, latency, "Rolling high 資料不足", now),
    rollingLow: calculated(bounds?.low ?? null, source, state, latency, "Rolling low 資料不足", now),
    swingHigh: calculated(swings?.high ?? null, source, state, latency, "Swing high 資料不足", now),
    swingLow: calculated(swings?.low ?? null, source, state, latency, "Swing low 資料不足", now),
    trend: calculated(trend, source, state, latency, "趨勢資料不足", now),
    volatility: calculated(volatility, source, state, latency, "波動資料不足", now),
  };
}

function preferredSetup(strategies: StrategyResult[]) {
  return strategies.filter((strategy) => strategy.status === "eligible" || strategy.status === "waiting")
    .sort((a, b) => a.status === b.status ? b.confidence - a.confidence : a.status === "eligible" ? -1 : 1)[0] ?? null;
}

export function mergeProviderPayloads(input: { binance: ProviderPayload | null; okx: ProviderPayload | null; fearGreed: MarketHubPayload["fearGreed"]; fearHealth: MarketHubPayload["health"][number]; now?: string; staleTtlMs?: number; pipeline?: MarketHubPayload["pipeline"] }): MarketHubPayload {
  const now = input.now ?? new Date().toISOString();
  const primaryMap = new Map((input.binance?.assets ?? []).map((asset) => [asset.symbol, asset]));
  const fallbackMap = new Map((input.okx?.assets ?? []).map((asset) => [asset.symbol, asset]));
  const symbols = Array.from(new Set([...primaryMap.keys(), ...fallbackMap.keys()]));
  const assets = symbols.map((symbol): AssetSnapshot => {
    const primary = primaryMap.get(symbol);
    const fallback = fallbackMap.get(symbol);
    const funding = chooseMetric(primary?.funding, fallback?.funding, primary?.latencyMs ?? null, fallback?.latencyMs ?? null, "Funding 在 Binance／OKX 皆缺少", now);
    const oiChange = chooseMetric(primary?.oiChange1h, fallback?.oiChange1h, primary?.latencyMs ?? null, fallback?.latencyMs ?? null, "OI change 在兩個來源皆缺少", now);
    const quoteVolume = chooseMetric(primary?.quoteVolume, fallback?.quoteVolume, primary?.latencyMs ?? null, fallback?.latencyMs ?? null, "Quote volume unavailable", now);
    const volumeSource = primary?.quoteVolume !== null && primary?.quoteVolume !== undefined ? primary : fallback?.quoteVolume !== null && fallback?.quoteVolume !== undefined ? fallback : null;
    const position = positioningScore(primary?.topRatios ?? [], primary?.globalRatios ?? []);
    const timeframes = Object.fromEntries(TIMEFRAMES.map((timeframe) => {
      const primaryCandles = primary?.candlesByTimeframe[timeframe] ?? [];
      const fallbackCandles = fallback?.candlesByTimeframe[timeframe] ?? [];
      const candles = primaryCandles.length ? primaryCandles : fallbackCandles;
      const source = primaryCandles.length ? "Binance" : fallbackCandles.length ? "OKX" : "Calculated";
      const state: DataState = primaryCandles.length ? "live" : fallbackCandles.length ? "fallback" : "missing";
      return [timeframe, buildTimeframe(timeframe, candles, source, state, primary?.latencyMs ?? fallback?.latencyMs ?? null, now)];
    })) as Record<Timeframe, TimeframeSnapshot>;
    const strategies = TIMEFRAMES.flatMap((timeframe) => evaluateStrategies({ symbol, timeframe, candles: timeframes[timeframe].candles, funding: funding.value, oiChange1h: oiChange.value, topRatios: primary?.topRatios ?? [], globalRatios: primary?.globalRatios ?? [], now }));
    return {
      symbol, name: NAMES[symbol.replace("USDT", "")] ?? symbol,
      price: chooseMetric(primary?.price, fallback?.price, primary?.latencyMs ?? null, fallback?.latencyMs ?? null, "Price unavailable", now),
      change15m: timeframes["15m"].change, change1h: timeframes["1h"].change, change4h: timeframes["4h"].change,
      change24h: chooseMetric(primary?.change24h, fallback?.change24h, primary?.latencyMs ?? null, fallback?.latencyMs ?? null, "24h change unavailable", now),
      quoteVolume,
      quoteVolumeUnit: volumeSource?.quoteVolumeUnit ?? null,
      quoteVolumeMethod: volumeSource?.quoteVolumeMethod ?? "成交量單位無法確認，不參與跨來源排序",
      openInterest: chooseMetric(primary?.openInterest, fallback?.openInterest, primary?.latencyMs ?? null, fallback?.latencyMs ?? null, "OI unavailable", now),
      oiChange1h: oiChange, funding,
      globalRatio: chooseMetric(primary?.globalRatios.at(-1), null, primary?.latencyMs ?? null, null, "Global ratio 無對應 OKX 備援", now),
      topRatio: chooseMetric(primary?.topRatios.at(-1), null, primary?.latencyMs ?? null, null, "Top Trader ratio 無對應 OKX 備援", now),
      positioning: metric(position, "Calculated", position === null ? "missing" : "live", primary?.latencyMs ?? null, position === null ? "Positioning 需要 Top／Global ratio 歷史" : "交易所帳戶多空傾向，非真實持倉集中度", now),
      timeframes, strategies, setup: preferredSetup(strategies),
    };
  }).filter((asset) => asset.price.value !== null || TIMEFRAMES.some((timeframe) => asset.timeframes[timeframe].candles.length));
  if (!assets.length) throw new Error("No market records from Binance or OKX");
  const advancing = assets.filter((asset) => (asset.change24h.value ?? 0) > 0).length;
  const trendingUp = assets.filter((asset) => asset.timeframes["4h"].trend.value === "Trend Up").length;
  const highVol = assets.filter((asset) => asset.timeframes["1h"].volatility.value === "High").length;
  const regime = highVol >= Math.ceil(assets.length / 2) ? "High Volatility" : trendingUp >= Math.ceil(assets.length * .6) ? "Trend Up" : advancing <= assets.length * .3 ? "Risk-Off" : "Range";
  const riskAlerts = assets.flatMap((asset) => {
    const alerts: string[] = [];
    if (asset.funding.value !== null && Math.abs(asset.funding.value) > .0005) alerts.push(`${asset.symbol.replace("USDT", "")} Funding 過熱`);
    if (asset.oiChange1h.value !== null && Math.abs(asset.oiChange1h.value) > 4) alerts.push(`${asset.symbol.replace("USDT", "")} OI 1h 異常變化`);
    if (asset.change1h.value !== null && asset.oiChange1h.value !== null && asset.change1h.value > 1 && asset.oiChange1h.value < -1) alerts.push(`${asset.symbol.replace("USDT", "")} 價格上漲但 OI 下降`);
    return alerts;
  }).slice(0, 8);
  const health = [input.binance?.health, input.okx?.health, input.fearHealth].filter((item): item is MarketHubPayload["health"][number] => Boolean(item));
  const recentErrors = health.flatMap((provider) => provider.errors.map((error) => `${provider.name}: ${error}`)).slice(0, 15);
  return { success: true, updatedAt: now, cacheAgeMs: 0, staleExpiresAt: new Date(new Date(now).getTime() + (input.staleTtlMs ?? 10 * 60_000)).toISOString(), assets, fearGreed: input.fearGreed, breadth: { advancing, declining: assets.length - advancing, total: assets.length }, regime, riskAlerts, health, recentErrors, pipeline: input.pipeline ?? { stage: input.okx && !input.binance ? "using-okx-fallback" : input.okx ? "filling-from-okx" : "using-binance", mode: "normal", marketApiDurationMs: 0, binanceDurationMs: input.binance?.health.latencyMs ?? null, okxDurationMs: input.okx?.health.latencyMs ?? null, okxFetchedFields: [] } };
}

export function markPayloadStale(payload: MarketHubPayload, storedAt: number, now = Date.now(), ttlMs = 10 * 60_000) {
  if (now - storedAt > ttlMs) return null;
  const stale = structuredClone(payload);
  stale.cacheAgeMs = now - storedAt; stale.updatedAt = new Date(now).toISOString(); stale.staleExpiresAt = new Date(storedAt + ttlMs).toISOString();
  stale.pipeline = { ...stale.pipeline, stage: "showing-stale" };
  for (const asset of stale.assets) {
    const mark = (candidate: unknown) => { if (candidate && typeof candidate === "object" && "state" in candidate) { const value = candidate as Metric<unknown>; if (value.state !== "missing") { value.state = "stale"; value.reason = "顯示最後成功資料；主要與備援來源正在重試"; } } };
    Object.values(asset).forEach(mark);
    TIMEFRAMES.forEach((timeframe) => Object.values(asset.timeframes[timeframe]).forEach(mark));
  }
  if (stale.fearGreed.state !== "missing") { stale.fearGreed.state = "stale"; stale.fearGreed.reason = "顯示最後成功資料"; }
  return stale;
}

