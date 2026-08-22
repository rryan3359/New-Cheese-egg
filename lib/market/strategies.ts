import {
  adxApprox,
  atr,
  bollinger,
  bollingerWidthPercentile,
  changeOver,
  ema,
  positioningScore,
  rollingBounds,
  rsi,
  swingLevels,
  volumeStats,
} from "./indicators";
import type { Candle, StrategyName, StrategyResult, StrategyStatus, Timeframe } from "./types";

export type StrategyContext = {
  symbol: string;
  timeframe: Timeframe;
  candles: Candle[];
  funding: number | null;
  oiChange1h: number | null;
  topRatios: number[];
  globalRatios: number[];
  now?: string;
};

type Direction = StrategyResult["direction"];
type Condition = { label: string; met: boolean | null; weight: number; required?: boolean };
type Plan = Pick<StrategyResult, "entryLow" | "entryHigh" | "stop" | "tp1" | "tp2" | "tp3" | "riskReward" | "riskRewardTp1" | "riskRewardTp2" | "riskRewardTp3" | "primaryRiskReward" | "primaryTarget" | "entryBasis">;

const missingPlan: Plan = { entryLow: null, entryHigh: null, stop: null, tp1: null, tp2: null, tp3: null, riskReward: null, riskRewardTp1: null, riskRewardTp2: null, riskRewardTp3: null, primaryRiskReward: null, primaryTarget: null, entryBasis: null };

export function calculateRiskRewards(input: Pick<Plan, "entryLow" | "entryHigh" | "stop" | "tp1" | "tp2" | "tp3"> & { direction: Direction; primaryTarget?: "TP1" | "TP2" | "TP3" }): Plan {
  const primaryTarget = input.primaryTarget ?? "TP2";
  const levels = { entryLow: input.entryLow, entryHigh: input.entryHigh, stop: input.stop, tp1: input.tp1, tp2: input.tp2, tp3: input.tp3 };
  const entry = input.direction === "Long" ? input.entryHigh : input.direction === "Short" ? input.entryLow : null;
  if (entry === null || input.stop === null || input.direction === "Neutral") return { ...levels, riskReward: null, riskRewardTp1: null, riskRewardTp2: null, riskRewardTp3: null, primaryRiskReward: null, primaryTarget: null, entryBasis: null };
  const risk = input.direction === "Long" ? entry - input.stop : input.stop - entry;
  if (!Number.isFinite(risk) || risk <= 0) return { ...levels, riskReward: null, riskRewardTp1: null, riskRewardTp2: null, riskRewardTp3: null, primaryRiskReward: null, primaryTarget: null, entryBasis: null };
  const reward = (target: number | null) => {
    if (target === null) return null;
    const value = input.direction === "Long" ? target - entry : entry - target;
    return Number.isFinite(value) && value > 0 ? value / risk : null;
  };
  const riskRewardTp1 = reward(input.tp1);
  const riskRewardTp2 = reward(input.tp2);
  const riskRewardTp3 = reward(input.tp3);
  const primaryRiskReward = primaryTarget === "TP1" ? riskRewardTp1 : primaryTarget === "TP2" ? riskRewardTp2 : riskRewardTp3;
  return { ...levels, riskReward: primaryRiskReward, riskRewardTp1, riskRewardTp2, riskRewardTp3, primaryRiskReward, primaryTarget: primaryRiskReward === null ? null : primaryTarget, entryBasis: "conservative-boundary" };
}

function plan(direction: Direction, center: number | null, stopCandidate: number | null, currentAtr: number | null): Plan {
  if (direction === "Neutral" || center === null || stopCandidate === null || currentAtr === null || currentAtr <= 0) return missingPlan;
  const sign = direction === "Long" ? 1 : -1;
  const entryLow = center - currentAtr * .18;
  const entryHigh = center + currentAtr * .18;
  const edge = direction === "Long" ? entryLow : entryHigh;
  const stop = direction === "Long" ? Math.min(stopCandidate, edge - currentAtr * .65) : Math.max(stopCandidate, edge + currentAtr * .65);
  const risk = direction === "Long" ? entryHigh - stop : stop - entryLow;
  if (!Number.isFinite(risk) || risk <= 0) return missingPlan;
  const conservativeEntry = direction === "Long" ? entryHigh : entryLow;
  return calculateRiskRewards({
    direction,
    entryLow: Math.min(entryLow, entryHigh),
    entryHigh: Math.max(entryLow, entryHigh),
    stop,
    tp1: conservativeEntry + sign * currentAtr,
    tp2: conservativeEntry + sign * currentAtr * 2,
    tp3: conservativeEntry + sign * currentAtr * 3,
  });
}

function result(input: {
  context: StrategyContext;
  strategy: StrategyName;
  direction: Direction;
  status: StrategyStatus;
  conditions: Condition[];
  tradePlan: Plan;
  trigger: string;
  invalidation: string;
  reasons?: string[];
  extraMissing?: string[];
  requiredData: string[];
}): StrategyResult {
  const known = input.conditions.filter((condition) => condition.met !== null);
  const met = known.filter((condition) => condition.met);
  const score = Math.round(input.conditions.reduce((sum, condition) => sum + (condition.met ? condition.weight : 0), 0));
  const missingConditions = [
    ...input.conditions.filter((condition) => condition.met === false).map((condition) => condition.label),
    ...input.conditions.filter((condition) => condition.met === null).map((condition) => `${condition.label}（資料缺少）`),
    ...(input.extraMissing ?? []),
  ];
  const status = input.conditions.some((condition) => condition.required && condition.met === null) ? "missing" : input.status;
  return {
    id: `${input.context.symbol}-${input.context.timeframe}-${input.strategy.toLowerCase().replaceAll(" ", "-")}`,
    symbol: input.context.symbol,
    timeframe: input.context.timeframe,
    strategy: input.strategy,
    direction: status === "invalid" || status === "missing" ? "Neutral" : input.direction,
    status,
    confidence: status === "missing" ? Math.min(score, 35) : Math.min(95, score),
    ...(status === "missing" ? missingPlan : input.tradePlan),
    trigger: input.trigger,
    invalidation: input.invalidation,
    reasons: [...(input.reasons ?? []), ...met.map((condition) => condition.label)],
    missingConditions,
    requiredData: input.requiredData,
    source: "Exchange candles + derivatives · deterministic formula",
    updatedAt: input.context.now ?? new Date().toISOString(),
    conditionsMet: met.length,
    conditionsTotal: input.conditions.length,
  };
}

function features(context: StrategyContext) {
  const { candles } = context;
  const closes = candles.map((candle) => candle.close);
  const price = closes.at(-1) ?? null;
  const currentAtr = atr(candles);
  const currentEma20 = ema(closes, 20);
  const currentEma50 = ema(closes, 50);
  const previousEma20 = ema(closes.slice(0, -3), 20);
  const band = bollinger(closes);
  const volume = volumeStats(candles);
  const bounds = rollingBounds(candles, 20, true);
  const swings = swingLevels(candles.slice(0, -1));
  const currentRsi = rsi(closes);
  const currentAdx = adxApprox(candles);
  const position = positioningScore(context.topRatios, context.globalRatios);
  return { closes, price, currentAtr, currentEma20, currentEma50, previousEma20, band, volume, bounds, swings, currentRsi, currentAdx, position };
}

function missingResult(context: StrategyContext, strategy: StrategyName, requiredData: string[], minimumCandles: number) {
  return result({
    context, strategy, direction: "Neutral", status: "missing", tradePlan: missingPlan,
    conditions: [{ label: `至少 ${minimumCandles} 根 ${context.timeframe} K 線`, met: null, weight: 100, required: true }],
    trigger: "等待必要資料", invalidation: "資料不足，不建立交易計畫", requiredData,
  });
}

export function trendPullback(context: StrategyContext): StrategyResult {
  if (context.candles.length < 60) return missingResult(context, "Trend Pullback", ["candles", "EMA20", "EMA50", "RSI", "ATR", "volume"], 60);
  const f = features(context);
  if ([f.price, f.currentAtr, f.currentEma20, f.currentEma50, f.previousEma20, f.currentRsi].some((value) => value === null)) return missingResult(context, "Trend Pullback", ["candles", "EMA20", "EMA50", "RSI", "ATR", "volume"], 60);
  const bullish = f.currentEma20! > f.currentEma50! && f.currentEma20! > f.previousEma20!;
  const bearish = f.currentEma20! < f.currentEma50! && f.currentEma20! < f.previousEma20!;
  const direction: Direction = bullish ? "Long" : bearish ? "Short" : "Neutral";
  const pullback = Math.abs(f.price! - f.currentEma20!) <= f.currentAtr! * .75;
  const rsiOk = bullish ? f.currentRsi! >= 42 && f.currentRsi! <= 68 : bearish ? f.currentRsi! >= 32 && f.currentRsi! <= 58 : false;
  const last = context.candles.at(-1)!;
  const confirmation = bullish ? last.close > last.open : bearish ? last.close < last.open : false;
  const volumeOk = (f.volume?.zScore ?? -99) >= -.5;
  const conditions: Condition[] = [
    { label: "EMA20／EMA50 趨勢與斜率一致", met: bullish || bearish, weight: 28, required: true },
    { label: "價格進入 EMA20 回踩區", met: pullback, weight: 24 },
    { label: "RSI 位於趨勢支持區", met: rsiOk, weight: 18 },
    { label: "收盤方向確認", met: confirmation, weight: 17 },
    { label: "成交量沒有明顯萎縮", met: f.volume ? volumeOk : null, weight: 13, required: true },
  ];
  const status: StrategyStatus = !bullish && !bearish ? "invalid" : pullback && rsiOk && confirmation && volumeOk ? "eligible" : "waiting";
  const stopBase = f.bounds ? (direction === "Long" ? f.bounds.low : f.bounds.high) : null;
  return result({ context, strategy: "Trend Pullback", direction, status, conditions, tradePlan: plan(direction, f.currentEma20, stopBase, f.currentAtr), trigger: "回踩 EMA20 區域後，收盤重新朝趨勢方向並通過 RSI／成交量確認", invalidation: direction === "Long" ? "收盤跌破回踩結構低點" : "收盤突破回踩結構高點", requiredData: ["candles", "EMA20", "EMA50", "EMA20 slope", "RSI", "ATR", "volume z-score"] });
}

export function breakout(context: StrategyContext): StrategyResult {
  if (context.candles.length < 50) return missingResult(context, "Breakout", ["candles", "rolling high/low", "ATR", "volume"], 50);
  const f = features(context);
  if (!f.bounds || f.price === null || f.currentAtr === null) return missingResult(context, "Breakout", ["candles", "rolling high/low", "ATR", "volume"], 50);
  const last = context.candles.at(-1)!;
  const longBreak = last.close > f.bounds.high + f.currentAtr * .08;
  const shortBreak = last.close < f.bounds.low - f.currentAtr * .08;
  const direction: Direction = longBreak ? "Long" : shortBreak ? "Short" : "Neutral";
  const near = Math.min(Math.abs(f.price - f.bounds.high), Math.abs(f.price - f.bounds.low)) <= f.currentAtr * .35;
  const volumeOk = (f.volume?.zScore ?? -99) >= 1;
  const extension = direction === "Long" ? last.close - f.bounds.high : direction === "Short" ? f.bounds.low - last.close : 0;
  const atrFilter = direction !== "Neutral" && extension <= f.currentAtr * 1.5;
  const confirmed = longBreak || shortBreak;
  const conditions: Condition[] = [
    { label: "收盤突破近期 20 根區間", met: confirmed, weight: 34, required: true },
    { label: "成交量 z-score 至少 1", met: f.volume ? volumeOk : null, weight: 26, required: true },
    { label: "突破延伸不超過 1.5 ATR", met: confirmed ? atrFilter : false, weight: 22 },
    { label: "價格位於突破邊界附近", met: near || confirmed, weight: 18 },
  ];
  const status: StrategyStatus = confirmed && volumeOk && atrFilter ? "eligible" : near || confirmed ? "waiting" : "invalid";
  const center = direction === "Long" ? f.bounds.high : direction === "Short" ? f.bounds.low : f.price > (f.bounds.high + f.bounds.low) / 2 ? f.bounds.high : f.bounds.low;
  const pendingDirection: Direction = direction !== "Neutral" ? direction : f.price >= center ? "Long" : "Short";
  const stopBase = pendingDirection === "Long" ? f.bounds.low : f.bounds.high;
  return result({ context, strategy: "Breakout", direction: pendingDirection, status, conditions, tradePlan: plan(pendingDirection, center, stopBase, f.currentAtr), trigger: "區間外收盤、成交量放大，且突破距離通過 ATR 假突破過濾", invalidation: "收盤重新回到原區間並超過 0.5 ATR", requiredData: ["candles", "rolling high/low", "ATR", "volume z-score"] });
}

export function volatilitySqueeze(context: StrategyContext): StrategyResult {
  if (context.candles.length < 105) return missingResult(context, "Volatility Squeeze", ["candles", "Bollinger Band Width history", "volume"], 105);
  const f = features(context);
  const previousCandles = context.candles.slice(0, -1);
  const previousCloses = previousCandles.map((candle) => candle.close);
  const previousBand = bollinger(previousCloses);
  const previousPercentile = bollingerWidthPercentile(previousCandles);
  if (!f.band || !previousBand || f.price === null || f.currentAtr === null || previousPercentile === null) return missingResult(context, "Volatility Squeeze", ["candles", "Bollinger Band Width history", "ATR", "volume"], 105);
  const compressed = previousPercentile <= 20;
  const expanding = f.band.width !== null && previousBand.width !== null && f.band.width > previousBand.width * 1.1;
  const direction: Direction = f.price > f.band.upper ? "Long" : f.price < f.band.lower ? "Short" : "Neutral";
  const volumeOk = (f.volume?.zScore ?? -99) >= .5;
  const conditions: Condition[] = [
    { label: "前一根 BB Width 位於 20 百分位以下", met: compressed, weight: 32, required: true },
    { label: "波動寬度擴張至少 10%", met: expanding, weight: 25 },
    { label: "收盤離開 Bollinger Band", met: direction !== "Neutral", weight: 25 },
    { label: "成交量 z-score 至少 0.5", met: f.volume ? volumeOk : null, weight: 18, required: true },
  ];
  const status: StrategyStatus = compressed && expanding && direction !== "Neutral" && volumeOk ? "eligible" : compressed ? "waiting" : "invalid";
  const pendingDirection: Direction = direction !== "Neutral" ? direction : f.price >= f.band.middle ? "Long" : "Short";
  const stopBase = pendingDirection === "Long" ? f.band.lower : f.band.upper;
  return result({ context, strategy: "Volatility Squeeze", direction: pendingDirection, status, conditions, tradePlan: plan(pendingDirection, f.band.middle, stopBase, f.currentAtr), trigger: "低波動壓縮後，Band Width 擴張、價格離開區間並有成交量確認", invalidation: "波動重新收縮且收盤回到 Bollinger 中軌另一側", requiredData: ["candles", "Bollinger Bands", "BB Width percentile", "ATR", "volume z-score"] });
}

export function fundingMeanReversion(context: StrategyContext): StrategyResult {
  if (context.candles.length < 60 || context.funding === null || context.oiChange1h === null) return missingResult(context, "Funding Mean Reversion", ["candles", "funding", "OI change", "EMA20", "ATR"], 60);
  const f = features(context);
  if (f.price === null || f.currentAtr === null || f.currentEma20 === null) return missingResult(context, "Funding Mean Reversion", ["candles", "funding", "OI change", "EMA20", "ATR"], 60);
  const extreme = Math.abs(context.funding) >= .0005;
  const direction: Direction = context.funding > 0 ? "Short" : context.funding < 0 ? "Long" : "Neutral";
  const extended = Math.abs(f.price - f.currentEma20) >= f.currentAtr * 1.5;
  const oiBuild = context.oiChange1h > .25;
  const last = context.candles.at(-1)!;
  const reversal = direction === "Long" ? last.close > last.open : direction === "Short" ? last.close < last.open : false;
  const conditions: Condition[] = [
    { label: "Funding 絕對值至少 0.05%", met: extreme, weight: 28, required: true },
    { label: "價格偏離 EMA20 至少 1.5 ATR", met: extended, weight: 25 },
    { label: "OI 1h 增加至少 0.25%", met: oiBuild, weight: 20, required: true },
    { label: "出現與擁擠方向相反的收盤確認", met: reversal, weight: 27 },
  ];
  const status: StrategyStatus = extreme && extended && oiBuild && reversal ? "eligible" : extreme ? "waiting" : "invalid";
  const bounds = rollingBounds(context.candles, 20);
  const stopBase = direction === "Long" ? bounds?.low ?? null : bounds?.high ?? null;
  return result({ context, strategy: "Funding Mean Reversion", direction, status, conditions, tradePlan: plan(direction, f.price, stopBase, f.currentAtr), trigger: "Funding 極端、價格延伸與 OI 建倉同時成立後，再等反轉收盤；Funding 不單獨觸發", invalidation: "價格延伸持續擴大且沒有反轉結構", reasons: [`Funding ${(context.funding * 100).toFixed(4)}%`, `OI 1h ${context.oiChange1h.toFixed(2)}%`], requiredData: ["candles", "funding", "OI change", "EMA20", "ATR", "reversal candle"] });
}

export function positioningDivergence(context: StrategyContext): StrategyResult {
  if (context.candles.length < 40 || context.topRatios.length < 5 || context.globalRatios.length < 5 || context.oiChange1h === null) return missingResult(context, "Positioning Divergence", ["candles", "Top Trader ratio", "Global ratio", "OI change"], 40);
  const f = features(context);
  const priceChange = changeOver(context.candles, 5);
  if (f.position === null || priceChange === null || f.currentAtr === null || f.price === null) return missingResult(context, "Positioning Divergence", ["candles", "Positioning score", "OI change", "ATR"], 40);
  const longDivergence = priceChange > .4 && f.position < -35;
  const shortDivergence = priceChange < -.4 && f.position > 35;
  const direction: Direction = longDivergence ? "Long" : shortDivergence ? "Short" : "Neutral";
  const extreme = Math.abs(f.position) >= 35;
  const oiConfirm = context.oiChange1h > 0;
  const conditions: Condition[] = [
    { label: "Top／Global 帳戶傾向分數達 ±35", met: extreme, weight: 30, required: true },
    { label: "價格與 positioning 形成背離", met: longDivergence || shortDivergence, weight: 34 },
    { label: "OI 正向增加確認新部位", met: oiConfirm, weight: 22, required: true },
    { label: "至少五筆 ratio 歷史可標準化", met: context.topRatios.length >= 5 && context.globalRatios.length >= 5, weight: 14, required: true },
  ];
  const status: StrategyStatus = direction !== "Neutral" && oiConfirm ? "eligible" : extreme ? "waiting" : "invalid";
  const bounds = rollingBounds(context.candles, 20);
  const pendingDirection: Direction = direction !== "Neutral" ? direction : f.position < 0 ? "Long" : "Short";
  const stopBase = pendingDirection === "Long" ? bounds?.low ?? null : bounds?.high ?? null;
  return result({ context, strategy: "Positioning Divergence", direction: pendingDirection, status, conditions, tradePlan: plan(pendingDirection, f.price, stopBase, f.currentAtr), trigger: "價格、OI 與 Top／Global 帳戶多空傾向出現可量化背離", invalidation: "Positioning 回到中性或 OI 下降，背離不再成立", reasons: [`Positioning ${f.position}（交易所帳戶多空傾向，非真實持倉集中度）`, `價格 5 bars ${priceChange.toFixed(2)}%`], requiredData: ["candles", "Top Trader ratio", "Global ratio", "rolling Z-score", "OI change"] });
}

export function ictLiquiditySweep(context: StrategyContext): StrategyResult {
  if (context.candles.length < 45) return missingResult(context, "ICT Liquidity Sweep", ["candles", "swing high/low", "ATR"], 45);
  const f = features(context);
  if (!f.swings || f.currentAtr === null || f.price === null) return missingResult(context, "ICT Liquidity Sweep", ["candles", "swing high/low", "ATR"], 45);
  const last = context.candles.at(-1)!;
  const sweepLow = last.low < f.swings.low && last.close > f.swings.low;
  const sweepHigh = last.high > f.swings.high && last.close < f.swings.high;
  const wickCross = last.low < f.swings.low || last.high > f.swings.high;
  const direction: Direction = sweepLow ? "Long" : sweepHigh ? "Short" : "Neutral";
  const displacement = Math.abs(last.close - last.open) >= f.currentAtr * .7;
  const structure = direction === "Long" ? last.close > context.candles.at(-2)!.high : direction === "Short" ? last.close < context.candles.at(-2)!.low : false;
  const conditions: Condition[] = [
    { label: "掃過已確認 swing high／low", met: wickCross, weight: 24, required: true },
    { label: "收盤重新回到流動性區間", met: sweepLow || sweepHigh, weight: 31 },
    { label: "實體 displacement 至少 0.7 ATR", met: displacement, weight: 25 },
    { label: "收盤完成短期結構確認", met: structure, weight: 20 },
  ];
  const status: StrategyStatus = direction !== "Neutral" && displacement && structure ? "eligible" : wickCross ? "waiting" : "invalid";
  const pendingDirection: Direction = direction !== "Neutral" ? direction : last.low < f.swings.low ? "Long" : "Short";
  const center = pendingDirection === "Long" ? f.swings.low : f.swings.high;
  const stopBase = pendingDirection === "Long" ? last.low : last.high;
  return result({ context, strategy: "ICT Liquidity Sweep", direction: pendingDirection, status, conditions, tradePlan: plan(pendingDirection, center, stopBase, f.currentAtr), trigger: "掃過 swing 流動性後收回區間，並以 displacement 與結構收盤確認", invalidation: "再次收盤落在被掃 swing 外側", extraMissing: ["FVG：聚合 K 線不足以可靠辨識逐筆缺口，圖層標示 missing"], requiredData: ["candles", "swing high/low", "ATR", "close reclaim", "displacement"] });
}

export function rangeMeanReversion(context: StrategyContext): StrategyResult {
  if (context.candles.length < 60) return missingResult(context, "Range Mean Reversion", ["candles", "ADX", "Bollinger Bands", "RSI", "ATR"], 60);
  const f = features(context);
  if (!f.band || f.currentAdx === null || f.currentRsi === null || f.currentAtr === null || f.price === null) return missingResult(context, "Range Mean Reversion", ["candles", "ADX", "Bollinger Bands", "RSI", "ATR"], 60);
  const last = context.candles.at(-1)!;
  const lowTrend = f.currentAdx < 25;
  const bounceLow = last.low < f.band.lower && last.close > f.band.lower;
  const rejectHigh = last.high > f.band.upper && last.close < f.band.upper;
  const nearBoundary = last.low <= f.band.lower + f.currentAtr * .3 || last.high >= f.band.upper - f.currentAtr * .3;
  const direction: Direction = bounceLow ? "Long" : rejectHigh ? "Short" : "Neutral";
  const rsiTurn = direction === "Long" ? f.currentRsi <= 42 : direction === "Short" ? f.currentRsi >= 58 : false;
  const reversal = direction === "Long" ? last.close > last.open : direction === "Short" ? last.close < last.open : false;
  const conditions: Condition[] = [
    { label: "ADX proxy 低於 25", met: lowTrend, weight: 27, required: true },
    { label: "觸及 Bollinger／區間邊界後收回", met: bounceLow || rejectHigh, weight: 31 },
    { label: "RSI 出現極端後反轉", met: rsiTurn, weight: 22 },
    { label: "反轉 K 線方向確認", met: reversal, weight: 20 },
  ];
  const status: StrategyStatus = lowTrend && direction !== "Neutral" && rsiTurn && reversal ? "eligible" : lowTrend && nearBoundary ? "waiting" : "invalid";
  const pendingDirection: Direction = direction !== "Neutral" ? direction : f.price <= f.band.middle ? "Long" : "Short";
  const center = pendingDirection === "Long" ? f.band.lower : f.band.upper;
  const stopBase = pendingDirection === "Long" ? last.low : last.high;
  const generatedPlan = plan(pendingDirection, center, stopBase, f.currentAtr);
  const tradePlan = calculateRiskRewards({ direction: pendingDirection, entryLow: generatedPlan.entryLow, entryHigh: generatedPlan.entryHigh, stop: generatedPlan.stop, tp1: f.band.middle, tp2: generatedPlan.tp2, tp3: generatedPlan.tp3, primaryTarget: "TP1" });
  return result({ context, strategy: "Range Mean Reversion", direction: pendingDirection, status, conditions, tradePlan, trigger: "低趨勢環境中掃過 Bollinger／區間邊界並收回，RSI 與反轉 K 同時確認", invalidation: "ADX 升高或收盤持續停留在區間外", requiredData: ["candles", "ADX proxy", "Bollinger Bands", "RSI", "ATR"] });
}

export const STRATEGY_EVALUATORS = {
  "Trend Pullback": trendPullback,
  Breakout: breakout,
  "Volatility Squeeze": volatilitySqueeze,
  "Funding Mean Reversion": fundingMeanReversion,
  "Positioning Divergence": positioningDivergence,
  "ICT Liquidity Sweep": ictLiquiditySweep,
  "Range Mean Reversion": rangeMeanReversion,
} satisfies Record<StrategyName, (context: StrategyContext) => StrategyResult>;

export function evaluateStrategies(context: StrategyContext) {
  return Object.values(STRATEGY_EVALUATORS).map((evaluate) => evaluate(context));
}

