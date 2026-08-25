import { adxApprox, atr, bollinger, changeOver, ema, positioningScore, rollingBounds, rsi, swingLevels, volumeStats } from "./indicators";
import { evaluateStrategies } from "./strategies";
import { TIMEFRAMES, type AssetSnapshot, type DataState, type MarketHubPayload, type Metric, type ProviderPayload, type StrategyResult, type Timeframe, type TimeframeSnapshot } from "./types";

import { ASSET_NAMES as NAMES } from "./symbols";

export function metric<T>(value: T | null, source: Metric<T>["source"], state: DataState, latencyMs: number | null, reason: string | null = null, now = new Date().toISOString()): Metric<T> {
  return { value, source, state, updatedAt: now, latencyMs, reason };
}

/** OKX is the sole market provider. Missing fields stay missing. */
export function okxMetric<T>(value: T | null | undefined, latency: number | null, missingReason: string, now: string): Metric<T> {
  if (value !== null && value !== undefined) return metric(value, "OKX", "live", latency, null, now);
  return metric<T>(null, "Calculated", "missing", null, missingReason, now);
}

function calculated<T>(value: T | null, source: "OKX" | "Calculated", state: DataState, latency: number | null, reason: string, now: string) {
  return metric(value, source, value === null ? "missing" : state, latency, value === null ? reason : null, now);
}

function buildTimeframe(timeframe: Timeframe, candles: TimeframeSnapshot["candles"], source: "OKX" | "Calculated", state: DataState, latency: number | null, now: string): TimeframeSnapshot {
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

export function mergeProviderPayloads(input: {
  okx: ProviderPayload | null;
  fearGreed: MarketHubPayload["fearGreed"];
  fearHealth: MarketHubPayload["health"][number];
  now?: string;
  staleTtlMs?: number;
  pipeline?: MarketHubPayload["pipeline"];
}): MarketHubPayload {
  const now = input.now ?? new Date().toISOString();
  const okxMap = new Map((input.okx?.assets ?? []).map((asset) => [asset.symbol, asset]));
  const symbols = Array.from(okxMap.keys());
  const assets = symbols.map((symbol): AssetSnapshot => {
    const okx = okxMap.get(symbol);
    const latency = okx?.latencyMs ?? null;
    const funding = okxMetric(okx?.funding, latency, "Funding 在 OKX 缺少", now);
    const oiChange = okxMetric(okx?.oiChange1h, latency, "OI change 在 OKX 缺少", now);
    const quoteVolume = okxMetric(okx?.quoteVolume, latency, "Quote volume 在 OKX 缺少", now);
    const topRatios = okx?.topRatios ?? [];
    const globalRatios = okx?.globalRatios ?? [];
    const ratioSource: "OKX" | "Calculated" = topRatios.length || globalRatios.length ? "OKX" : "Calculated";
    // OKX: global account ratio + top-trader account ratio (when available)
    let position: number | null = null;
    let positionReason: string | null = "Positioning 需要 OKX Global／大戶多空比歷史";
    if (topRatios.length >= 5 && globalRatios.length >= 5) {
      position = positioningScore(topRatios, globalRatios);
      positionReason = null;
    } else if (globalRatios.length >= 5) {
      const logs = globalRatios.map((r) => Math.log(r));
      const avg = logs.reduce((s, v) => s + v, 0) / logs.length;
      const variance = logs.reduce((s, v) => s + (v - avg) ** 2, 0) / logs.length;
      const std = Math.sqrt(variance) || 0;
      const z = std ? (logs.at(-1)! - avg) / std : 0;
      position = Math.max(-100, Math.min(100, Math.round(z * 34)));
      positionReason = "僅有 Global 多空比（大戶比不足），傾向分數為簡化估算";
    }
    const timeframes = Object.fromEntries(TIMEFRAMES.map((timeframe) => {
      const candles = okx?.candlesByTimeframe[timeframe] ?? [];
      const source = candles.length ? "OKX" : "Calculated";
      const state: DataState = candles.length ? "live" : "missing";
      return [timeframe, buildTimeframe(timeframe, candles, source, state, latency, now)];
    })) as Record<Timeframe, TimeframeSnapshot>;
    // Only evaluate strategies when at least one timeframe has candles (L3); otherwise empty + honest missing downstream
    const hasAnyCandles = TIMEFRAMES.some((tf) => timeframes[tf].candles.length > 0);
    const strategies = hasAnyCandles
      ? TIMEFRAMES.flatMap((timeframe) =>
          evaluateStrategies({
            symbol,
            timeframe,
            candles: timeframes[timeframe].candles,
            funding: funding.value,
            oiChange1h: oiChange.value,
            topRatios,
            globalRatios,
            now,
          }),
        )
      : [];
    return {
      symbol, name: NAMES[symbol.replace("USDT", "")] ?? symbol,
      price: okxMetric(okx?.price, latency, "Price 在 OKX 缺少", now),
      change15m: timeframes["15m"].change, change1h: timeframes["1h"].change, change4h: timeframes["4h"].change,
      change24h: okxMetric(okx?.change24h, latency, "24h change 在 OKX 缺少", now),
      quoteVolume,
      quoteVolumeUnit: okx?.quoteVolume !== null && okx?.quoteVolume !== undefined ? okx.quoteVolumeUnit : null,
      quoteVolumeMethod: okx?.quoteVolume !== null && okx?.quoteVolume !== undefined ? okx.quoteVolumeMethod : "成交量單位無法確認，不參與排序",
      openInterest: okxMetric(okx?.openInterest, latency, "OI 在 OKX 缺少", now),
      oiChange1h: oiChange, funding,
      globalRatio: okxMetric(okx?.globalRatios.at(-1), latency, "Global 多空比在 OKX 缺少", now),
      topRatio: okxMetric(okx?.topRatios.at(-1), latency, "大戶多空比資料不足（OKX top trader）", now),
      positioning: metric(position, ratioSource, position === null ? "missing" : "live", latency, position === null ? positionReason : (positionReason ?? "交易所帳戶多空傾向，非真實持倉集中度"), now),
      timeframes, strategies, setup: preferredSetup(strategies),
    };
  }).filter((asset) => asset.price.value !== null || TIMEFRAMES.some((timeframe) => asset.timeframes[timeframe].candles.length));
  if (!assets.length) throw new Error("No market records from OKX");
  const knownChanges = assets.filter((asset) => asset.change24h.value !== null);
  const knownTrends = assets.filter((asset) => asset.timeframes["4h"].trend.value !== null);
  const knownVolatility = assets.filter((asset) => asset.timeframes["1h"].volatility.value !== null);
  const advancing = knownChanges.filter((asset) => asset.change24h.value! > 0).length;
  const declining = knownChanges.filter((asset) => asset.change24h.value! < 0).length;
  const trendingUp = knownTrends.filter((asset) => asset.timeframes["4h"].trend.value === "Trend Up").length;
  const highVol = knownVolatility.filter((asset) => asset.timeframes["1h"].volatility.value === "High").length;
  const regime = knownVolatility.length && highVol >= Math.ceil(knownVolatility.length / 2)
    ? "High Volatility"
    : knownTrends.length && trendingUp >= Math.ceil(knownTrends.length * .6)
      ? "Trend Up"
      : knownChanges.length && advancing <= knownChanges.length * .3
        ? "Risk-Off"
        : knownChanges.length
          ? "Range"
          : "N/A";
  const riskAlerts = assets.flatMap((asset) => {
    const alerts: string[] = [];
    if (asset.funding.value !== null && Math.abs(asset.funding.value) > .0005) alerts.push(`${asset.symbol.replace("USDT", "")} Funding 過熱`);
    if (asset.oiChange1h.value !== null && Math.abs(asset.oiChange1h.value) > 4) alerts.push(`${asset.symbol.replace("USDT", "")} OI 1h 異常變化`);
    if (asset.change1h.value !== null && asset.oiChange1h.value !== null && asset.change1h.value > 1 && asset.oiChange1h.value < -1) alerts.push(`${asset.symbol.replace("USDT", "")} 價格上漲但 OI 下降`);
    return alerts;
  }).slice(0, 8);
  const health = [input.okx?.health, input.fearHealth].filter((item): item is MarketHubPayload["health"][number] => Boolean(item));
  const recentErrors = health.flatMap((provider) => provider.errors.map((error) => `${provider.name}: ${error}`)).slice(0, 15);
  return {
    success: true,
    updatedAt: now,
    cacheAgeMs: 0,
    staleExpiresAt: new Date(new Date(now).getTime() + (input.staleTtlMs ?? 10 * 60_000)).toISOString(),
    assets,
    fearGreed: input.fearGreed,
    breadth: { advancing, declining, total: knownChanges.length },
    regime,
    riskAlerts,
    health,
    recentErrors,
    pipeline: input.pipeline ?? {
      stage: "using-okx",
      mode: "normal",
      tier: "l2",
      marketApiDurationMs: 0,
      binanceDurationMs: null,
      okxDurationMs: input.okx?.health.latencyMs ?? null,
      okxFetchedFields: [],
    },
  };
}

export function markPayloadStale(payload: MarketHubPayload, storedAt: number, now = Date.now(), ttlMs = 10 * 60_000) {
  if (now - storedAt > ttlMs) return null;
  const stale = structuredClone(payload);
  stale.cacheAgeMs = now - storedAt;
  stale.staleExpiresAt = new Date(storedAt + ttlMs).toISOString();
  stale.pipeline = { ...stale.pipeline, stage: "showing-stale" };
  for (const asset of stale.assets) {
    const mark = (candidate: unknown) => {
      if (candidate && typeof candidate === "object" && "state" in candidate) {
        const value = candidate as Metric<unknown>;
        if (value.state !== "missing") {
          value.state = "stale";
          value.reason = "行情服務暫時不可用；顯示最後成功資料";
        }
      }
    };
    Object.values(asset).forEach(mark);
    TIMEFRAMES.forEach((timeframe) => Object.values(asset.timeframes[timeframe]).forEach(mark));
  }
  if (stale.fearGreed.state !== "missing") {
    stale.fearGreed.state = "stale";
    stale.fearGreed.reason = "顯示最後成功資料";
  }
  stale.health = stale.health.map((provider) => ({
    ...provider,
    state: provider.state === "missing" ? "missing" : "stale",
  }));
  return stale;
}

/**
 * Prefer richer payload when merging L1 → L2 progressive updates on the client.
 * Rule: keep non-missing field values from `next` when present; otherwise retain `prev`.
 */
export function mergeSnapshotsProgressive(prev: MarketHubPayload | null, next: MarketHubPayload): MarketHubPayload {
  if (!prev) return next;
  const prevMap = new Map(prev.assets.map((a) => [a.symbol, a]));
  const nextMap = new Map(next.assets.map((a) => [a.symbol, a]));
  const symbols = Array.from(new Set([...prevMap.keys(), ...nextMap.keys()]));

  const pickMetric = <T,>(a: Metric<T> | undefined, b: Metric<T> | undefined): Metric<T> => {
    if (b && b.state !== "missing" && b.value !== null && b.value !== undefined) return b;
    if (a) return a;
    return b as Metric<T>;
  };

  const assets = symbols.map((symbol) => {
    const a = prevMap.get(symbol);
    const b = nextMap.get(symbol);
    if (!a) return b!;
    if (!b) return a;
    const timeframes = Object.fromEntries(
      TIMEFRAMES.map((tf) => {
        const ta = a.timeframes[tf];
        const tb = b.timeframes[tf];
        const candles = tb.candles.length ? tb.candles : ta.candles;
        return [tf, candles === tb.candles ? tb : ta];
      }),
    ) as AssetSnapshot["timeframes"];
    const strategies = b.strategies.length ? b.strategies : a.strategies;
    return {
      ...b,
      price: pickMetric(a.price, b.price),
      change15m: pickMetric(a.change15m, b.change15m),
      change1h: pickMetric(a.change1h, b.change1h),
      change4h: pickMetric(a.change4h, b.change4h),
      change24h: pickMetric(a.change24h, b.change24h),
      quoteVolume: pickMetric(a.quoteVolume, b.quoteVolume),
      openInterest: pickMetric(a.openInterest, b.openInterest),
      oiChange1h: pickMetric(a.oiChange1h, b.oiChange1h),
      funding: pickMetric(a.funding, b.funding),
      globalRatio: pickMetric(a.globalRatio, b.globalRatio),
      topRatio: pickMetric(a.topRatio, b.topRatio),
      positioning: pickMetric(a.positioning, b.positioning),
      timeframes,
      strategies,
      setup: b.setup ?? a.setup,
    };
  });

  return {
    ...next,
    assets,
    fearGreed: pickMetric(prev.fearGreed, next.fearGreed),
    breadth: next.breadth.total >= prev.breadth.total ? next.breadth : prev.breadth,
  };
}
