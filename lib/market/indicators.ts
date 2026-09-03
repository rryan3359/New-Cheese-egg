import type { Candle } from "./types";

export function mean(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

export function standardDeviation(values: number[]) {
  const average = mean(values);
  if (average === null || values.length < 2) return null;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length);
}

export function ema(values: number[], period: number) {
  if (values.length < period || period < 1) return null;
  const multiplier = 2 / (period + 1);
  const seed = mean(values.slice(0, period))!;
  return values.slice(period).reduce((average, value) => value * multiplier + average * (1 - multiplier), seed);
}

export function emaSeries(values: number[], period: number) {
  if (values.length < period || period < 1) return [];
  const multiplier = 2 / (period + 1);
  const seed = mean(values.slice(0, period))!;
  const result = Array<number | null>(period - 1).fill(null);
  result.push(seed);
  for (const value of values.slice(period)) result.push(value * multiplier + result.at(-1)! * (1 - multiplier));
  return result;
}

export function atr(candles: Candle[], period = 14) {
  if (candles.length <= period) return null;
  const ranges = candles.slice(1).map((candle, index) => {
    const previous = candles[index].close;
    return Math.max(candle.high - candle.low, Math.abs(candle.high - previous), Math.abs(candle.low - previous));
  });
  return mean(ranges.slice(-period));
}

export function rsi(values: number[], period = 14) {
  if (values.length <= period) return null;
  const changes = values.slice(1).map((value, index) => value - values[index]).slice(-period);
  const gain = changes.reduce((sum, value) => sum + Math.max(0, value), 0) / period;
  const loss = changes.reduce((sum, value) => sum + Math.max(0, -value), 0) / period;
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}

export function adxApprox(candles: Candle[], period = 14) {
  if (candles.length <= period) return null;
  const recent = candles.slice(-period);
  const movement = Math.abs(recent.at(-1)!.close - recent[0].open);
  const totalRange = recent.reduce((sum, candle) => sum + candle.high - candle.low, 0);
  return totalRange ? Math.min(100, (movement / totalRange) * 180) : 0;
}

export function changeOver(candles: Candle[], bars: number) {
  if (candles.length <= bars) return null;
  const current = candles.at(-1)!.close;
  const previous = candles.at(-(bars + 1))!.close;
  return previous ? ((current - previous) / previous) * 100 : null;
}

export function bollinger(values: number[], period = 20, multiplier = 2) {
  if (values.length < period) return null;
  const window = values.slice(-period);
  const middle = mean(window)!;
  const deviation = standardDeviation(window)!;
  const upper = middle + deviation * multiplier;
  const lower = middle - deviation * multiplier;
  return { upper, middle, lower, width: middle ? (upper - lower) / middle : null };
}

export function volumeStats(candles: Candle[], period = 20) {
  if (candles.length < period + 1) return null;
  const history = candles.slice(-(period + 1), -1).map((candle) => candle.volume);
  const average = mean(history)!;
  const deviation = standardDeviation(history) ?? 0;
  const current = candles.at(-1)!.volume;
  return { mean: average, zScore: deviation ? (current - average) / deviation : 0 };
}

export function rollingBounds(candles: Candle[], period = 20, excludeLatest = false) {
  const end = excludeLatest ? -1 : undefined;
  const available = excludeLatest ? candles.slice(0, -1) : candles;
  if (available.length < period) return null;
  const window = candles.slice(excludeLatest ? -(period + 1) : -period, end);
  return { high: Math.max(...window.map((candle) => candle.high)), low: Math.min(...window.map((candle) => candle.low)) };
}

export function swingLevels(candles: Candle[], left = 2, right = 2) {
  if (candles.length < left + right + 3) return null;
  let high: number | null = null;
  let low: number | null = null;
  for (let index = left; index < candles.length - right; index += 1) {
    const window = candles.slice(index - left, index + right + 1);
    const candle = candles[index];
    if (candle.high === Math.max(...window.map((item) => item.high))) high = candle.high;
    if (candle.low === Math.min(...window.map((item) => item.low))) low = candle.low;
  }
  return high !== null && low !== null ? { high, low } : null;
}

export function percentileRank(history: number[], value: number) {
  if (!history.length) return null;
  return history.filter((item) => item <= value).length / history.length * 100;
}

export function bollingerWidthPercentile(candles: Candle[], period = 20, lookback = 80) {
  if (candles.length < period + 20) return null;
  const closes = candles.map((candle) => candle.close);
  const widths: number[] = [];
  for (let index = period; index <= closes.length; index += 1) {
    const band = bollinger(closes.slice(0, index), period);
    if (band?.width !== null && band?.width !== undefined) widths.push(band.width);
  }
  const current = widths.at(-1);
  if (current === undefined) return null;
  return percentileRank(widths.slice(-lookback, -1), current);
}

function ratioSpreadZScore(leaderRatios: number[], globalRatios: number[]) {
  const size = Math.min(leaderRatios.length, globalRatios.length);
  if (size < 5) return null;
  const leader = leaderRatios.slice(-size);
  const global = globalRatios.slice(-size);
  const spreads = leader.map((ratio, index) => Math.log(ratio) - Math.log(global[index]));
  const average = mean(spreads)!;
  const deviation = standardDeviation(spreads) ?? 0;
  return deviation ? (spreads.at(-1)! - average) / deviation : 0;
}

/**
 * Relative positioning pressure, not holder concentration or wallet ownership.
 * Positive means OKX top-trader ratios are unusually long versus all accounts;
 * negative means unusually short. If the global series is unavailable, compare
 * top-trader position value with top-trader account count instead.
 */
export function positioningScore(topAccountRatios: number[], globalRatios: number[], topPositionRatios: number[] = []) {
  const versusMarket = [
    ratioSpreadZScore(topAccountRatios, globalRatios),
    ratioSpreadZScore(topPositionRatios, globalRatios),
  ].filter((value): value is number => value !== null);
  const components = versusMarket.length
    ? versusMarket
    : [ratioSpreadZScore(topPositionRatios, topAccountRatios)].filter((value): value is number => value !== null);
  if (!components.length) return null;
  const combined = components.reduce((sum, value) => sum + value, 0) / components.length;
  return Math.max(-100, Math.min(100, Math.round(combined * 34)));
}

