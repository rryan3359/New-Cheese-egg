import { atr, bollinger, bollingerWidthPercentile, ema, emaSeries, rollingBounds, swingLevels, volumeStats } from "./indicators";
import { currentSession } from "./sessions";
import {
  DEFAULT_TRADE_COSTS,
  type Candle,
  type CandleMap,
  type SessionLevel,
  type StrategyCondition,
  type StrategyGrade,
  type StrategyName,
  type StrategyResult,
  type StrategyStatus,
  type StrategySubmodel,
  type Timeframe,
  type TradeCosts,
} from "./types";

export type StrategyContext = {
  symbol: string;
  candlesByTimeframe: CandleMap;
  sessionLevels: SessionLevel[];
  funding: number | null;
  oiChange1h: number | null;
  topRatios: number[];
  globalRatios: number[];
  costs?: TradeCosts;
  now?: string;
};

type Direction = StrategyResult["direction"];
type TargetName = "TP1" | "TP2" | "TP3";
type Condition = { id: string; label: string; kind: "hard" | "bonus"; met: boolean | null; weight: number; detail?: string | null };
type Plan = Pick<StrategyResult,
  "entryLow" | "entryHigh" | "stop" | "tp1" | "tp2" | "tp3" | "riskReward" |
  "riskRewardTp1" | "riskRewardTp2" | "riskRewardTp3" | "primaryRiskReward" |
  "grossRiskRewardTp1" | "grossRiskRewardTp2" | "grossRiskRewardTp3" |
  "primaryTarget" | "entryBasis" | "feeRate" | "slippageRate" | "roundTripCostRate"
>;
type TrendBias = { direction: Direction; tangled: boolean } | null;
type Gap = { low: number; high: number; index: number };

const HIGH_LIQUIDITY = new Set(["PDH", "PWH", "ASIA_HIGH", "LONDON_HIGH", "NEW_YORK_HIGH", "EQH", "SWING_HIGH"]);
const LOW_LIQUIDITY = new Set(["PDL", "PWL", "ASIA_LOW", "LONDON_LOW", "NEW_YORK_LOW", "EQL", "SWING_LOW"]);

function blankPlan(costs: TradeCosts = DEFAULT_TRADE_COSTS): Plan {
  return {
    entryLow: null, entryHigh: null, stop: null, tp1: null, tp2: null, tp3: null,
    riskReward: null, riskRewardTp1: null, riskRewardTp2: null, riskRewardTp3: null,
    primaryRiskReward: null, grossRiskRewardTp1: null, grossRiskRewardTp2: null,
    grossRiskRewardTp3: null, primaryTarget: null, entryBasis: null,
    feeRate: costs.feeRate, slippageRate: costs.slippageRate,
    roundTripCostRate: 2 * (costs.feeRate + costs.slippageRate),
  };
}

function finiteOrNull(value: number | null | undefined) {
  return value !== null && value !== undefined && Number.isFinite(value) ? value : null;
}

export function gradeForNetRr(value: number | null): StrategyGrade {
  if (value === null || value < 1.5) return null;
  return value >= 2 ? "A" : "B";
}

/** Worst entry boundary, structural targets, then round-trip fees and slippage. */
export function calculateRiskRewards(input: {
  direction: Direction;
  entryLow: number | null;
  entryHigh: number | null;
  stop: number | null;
  tp1: number | null;
  tp2: number | null;
  tp3: number | null;
  primaryTarget?: TargetName;
  feeRate?: number;
  slippageRate?: number;
}): Plan {
  const costs = {
    feeRate: Math.max(0, input.feeRate ?? DEFAULT_TRADE_COSTS.feeRate),
    slippageRate: Math.max(0, input.slippageRate ?? DEFAULT_TRADE_COSTS.slippageRate),
  };
  const empty = blankPlan(costs);
  const levels = {
    entryLow: finiteOrNull(input.entryLow), entryHigh: finiteOrNull(input.entryHigh), stop: finiteOrNull(input.stop),
    tp1: finiteOrNull(input.tp1), tp2: finiteOrNull(input.tp2), tp3: finiteOrNull(input.tp3),
  };
  const entry = input.direction === "Long" ? levels.entryHigh : input.direction === "Short" ? levels.entryLow : null;
  if (entry === null || levels.stop === null || input.direction === "Neutral") return { ...empty, ...levels };
  const grossRisk = input.direction === "Long" ? entry - levels.stop : levels.stop - entry;
  if (!Number.isFinite(grossRisk) || grossRisk <= 0) return { ...empty, ...levels };
  const roundTripCostRate = 2 * (costs.feeRate + costs.slippageRate);
  const oneWayCostRate = costs.feeRate + costs.slippageRate;
  const entryCost = entry * oneWayCostRate;
  const netRisk = grossRisk + entryCost + levels.stop * oneWayCostRate;
  const reward = (target: number | null) => {
    if (target === null) return { gross: null, net: null };
    const grossReward = input.direction === "Long" ? target - entry : entry - target;
    if (!Number.isFinite(grossReward) || grossReward <= 0) return { gross: null, net: null };
    const netReward = grossReward - entryCost - target * oneWayCostRate;
    return { gross: grossReward / grossRisk, net: netReward > 0 ? netReward / netRisk : null };
  };
  const rewards = { TP1: reward(levels.tp1), TP2: reward(levels.tp2), TP3: reward(levels.tp3) };
  const requested = input.primaryTarget ?? (["TP1", "TP2", "TP3"] as TargetName[]).find((name) => (rewards[name].net ?? -Infinity) >= 1.5)
    ?? (["TP3", "TP2", "TP1"] as TargetName[]).find((name) => rewards[name].net !== null);
  const primaryRiskReward = requested ? rewards[requested].net : null;
  return {
    ...levels,
    riskReward: primaryRiskReward,
    riskRewardTp1: rewards.TP1.net,
    riskRewardTp2: rewards.TP2.net,
    riskRewardTp3: rewards.TP3.net,
    primaryRiskReward,
    grossRiskRewardTp1: rewards.TP1.gross,
    grossRiskRewardTp2: rewards.TP2.gross,
    grossRiskRewardTp3: rewards.TP3.gross,
    primaryTarget: primaryRiskReward === null ? null : requested ?? null,
    entryBasis: "conservative-boundary",
    feeRate: costs.feeRate,
    slippageRate: costs.slippageRate,
    roundTripCostRate,
  };
}

function closes(candles: Candle[]) { return candles.map((candle) => candle.close); }

/** Reject flat/tangled EMAs and repeated crossings instead of assigning a trend. */
function trendBias(candles: Candle[]): TrendBias {
  if (candles.length < 55) return null;
  const values = closes(candles);
  const currentAtr = atr(candles);
  const fast = ema(values, 20);
  const slow = ema(values, 50);
  const priorFast = ema(values.slice(0, -3), 20);
  const priorSlow = ema(values.slice(0, -3), 50);
  if ([currentAtr, fast, slow, priorFast, priorSlow].some((value) => value === null)) return null;
  const fastSeries = emaSeries(values, 20);
  const slowSeries = emaSeries(values, 50);
  let crossings = 0;
  for (let index = Math.max(1, values.length - 12); index < values.length; index += 1) {
    const beforeFast = fastSeries[index - 1];
    const beforeSlow = slowSeries[index - 1];
    const afterFast = fastSeries[index];
    const afterSlow = slowSeries[index];
    if (beforeFast !== null && beforeSlow !== null && afterFast !== null && afterSlow !== null && Math.sign(beforeFast - beforeSlow) !== Math.sign(afterFast - afterSlow)) crossings += 1;
  }
  const separation = Math.abs(fast! - slow!) / currentAtr!;
  const fastSlope = (fast! - priorFast!) / currentAtr!;
  const slowSlope = (slow! - priorSlow!) / currentAtr!;
  const tangled = separation < 0.18 || crossings >= 2 || Math.abs(fastSlope) < 0.04 || Math.abs(slowSlope) < 0.015;
  if (tangled) return { direction: "Neutral", tangled: true };
  if (fast! > slow! && fastSlope > 0 && slowSlope >= 0) return { direction: "Long", tangled: false };
  if (fast! < slow! && fastSlope < 0 && slowSlope <= 0) return { direction: "Short", tangled: false };
  return { direction: "Neutral", tangled: false };
}

function pivotPrices(candles: Candle[], side: "high" | "low") {
  const result: number[] = [];
  for (let index = 2; index < candles.length - 2; index += 1) {
    const row = candles[index];
    const window = candles.slice(index - 2, index + 3);
    if (side === "high" && row.high === Math.max(...window.map((item) => item.high))) result.push(row.high);
    if (side === "low" && row.low === Math.min(...window.map((item) => item.low))) result.push(row.low);
  }
  return result;
}

function realTargets(context: StrategyContext, direction: Direction, entry: number, liquidityOnly = false) {
  if (direction === "Neutral") return [null, null, null] as const;
  const sessionCandidates = context.sessionLevels
    .filter((level) => direction === "Long" ? HIGH_LIQUIDITY.has(level.kind) : LOW_LIQUIDITY.has(level.kind))
    .map((level) => level.price);
  const structure = liquidityOnly ? [] : (["5m", "15m", "1h", "4h"] as Timeframe[]).flatMap((timeframe) =>
    pivotPrices(context.candlesByTimeframe[timeframe], direction === "Long" ? "high" : "low"),
  );
  const candidates = [...sessionCandidates, ...structure]
    .filter((price) => direction === "Long" ? price > entry : price < entry)
    .sort((a, b) => direction === "Long" ? a - b : b - a)
    .filter((price, index, all) => index === 0 || Math.abs(price - all[index - 1]) / entry > 0.0005);
  return [candidates[0] ?? null, candidates[1] ?? null, candidates[2] ?? null] as const;
}

function planFromStructure(input: {
  context: StrategyContext;
  direction: Direction;
  entryLow: number | null;
  entryHigh: number | null;
  stop: number | null;
  liquidityOnly?: boolean;
}): Plan {
  if (input.direction === "Neutral" || input.entryLow === null || input.entryHigh === null || input.stop === null) return blankPlan(input.context.costs);
  const adverseEntry = input.direction === "Long" ? input.entryHigh : input.entryLow;
  const [tp1, tp2, tp3] = realTargets(input.context, input.direction, adverseEntry, input.liquidityOnly);
  return calculateRiskRewards({
    direction: input.direction,
    entryLow: Math.min(input.entryLow, input.entryHigh), entryHigh: Math.max(input.entryLow, input.entryHigh),
    stop: input.stop, tp1, tp2, tp3,
    feeRate: input.context.costs?.feeRate, slippageRate: input.context.costs?.slippageRate,
  });
}

function toPublicCondition(condition: Condition): StrategyCondition {
  return {
    id: condition.id,
    label: condition.label,
    kind: condition.kind,
    state: condition.met === null ? "missing" : condition.met ? "met" : "failed",
    detail: condition.detail ?? null,
  };
}

function result(input: {
  context: StrategyContext;
  strategy: StrategyName;
  submodel?: StrategySubmodel;
  timeframe: Timeframe;
  direction: Direction;
  baseStatus: StrategyStatus;
  conditions: Condition[];
  tradePlan: Plan;
  trigger: string;
  invalidation: string;
  targetBasis: string;
  reasons?: string[];
  extraMissingData?: string[];
  requiredData: string[];
}): StrategyResult {
  const hard = input.conditions.filter((condition) => condition.kind === "hard");
  const bonus = input.conditions.filter((condition) => condition.kind === "bonus");
  const hardMet = hard.filter((condition) => condition.met === true).length;
  const bonusMet = bonus.filter((condition) => condition.met === true).length;
  const missingHard = hard.filter((condition) => condition.met === null);
  const failedHard = hard.filter((condition) => condition.met === false);
  let status: StrategyStatus = missingHard.length ? "not_applicable" : input.baseStatus;
  const gateMessages: string[] = [];
  if (status === "executable" && failedHard.length) status = "waiting_trigger";
  const netRr = input.tradePlan.primaryRiskReward;
  const hasTradeStructure = input.tradePlan.entryLow !== null && input.tradePlan.entryHigh !== null && input.tradePlan.stop !== null;
  if (hasTradeStructure && ["forming", "waiting_trigger", "executable"].includes(status) && (netRr === null || netRr < 1.5)) {
    status = "invalidated";
    gateMessages.push(netRr === null ? "沒有可驗證的真實結構／流動性目標" : `淨 RR ${netRr.toFixed(2)} 低於 1.5，已淘汰`);
  }
  const pendingConditions = hard.filter((condition) => condition.met === false).map((condition) => condition.label);
  const missingData = [
    ...input.conditions.filter((condition) => condition.met === null).map((condition) => condition.label),
    ...(input.extraMissingData ?? []),
  ];
  const hardWeight = hard.reduce((sum, condition) => sum + condition.weight, 0) || 1;
  const hardScore = hard.reduce((sum, condition) => sum + (condition.met === true ? condition.weight : 0), 0) / hardWeight * 60;
  const knownBonus = bonus.filter((condition) => condition.met !== null);
  const bonusWeight = knownBonus.reduce((sum, condition) => sum + condition.weight, 0) || 1;
  const bonusScore = knownBonus.reduce((sum, condition) => sum + (condition.met === true ? condition.weight : 0), 0) / bonusWeight * 25;
  const coverage = input.conditions.length ? input.conditions.filter((condition) => condition.met !== null).length / input.conditions.length * 15 : 0;
  const confidence = Math.min(95, Math.max(0, Math.round(hardScore + bonusScore + coverage)));
  const grade = status === "executable" ? gradeForNetRr(netRr) : null;
  const publicHard = hard.map(toPublicCondition);
  const publicBonus = bonus.map(toPublicCondition);
  const plan = missingHard.length ? blankPlan(input.context.costs) : input.tradePlan;
  return {
    id: `${input.context.symbol}-${input.timeframe}-${input.strategy.toLowerCase().replaceAll(" ", "-").replaceAll("/", "-")}`,
    symbol: input.context.symbol,
    timeframe: input.timeframe,
    strategy: input.strategy,
    submodel: input.submodel ?? null,
    direction: missingHard.length ? "Neutral" : input.direction,
    status,
    dataState: missingHard.length ? "missing" : "live",
    grade,
    confidence,
    ...plan,
    eligibleForScanner: status === "executable" && grade !== null,
    trigger: input.trigger,
    invalidation: input.invalidation,
    targetBasis: input.targetBasis,
    reasons: [...(input.reasons ?? []), ...input.conditions.filter((condition) => condition.met === true).map((condition) => condition.label)],
    pendingConditions: [...pendingConditions, ...gateMessages],
    missingConditions: [...pendingConditions, ...missingData, ...gateMessages],
    missingData,
    hardConditions: publicHard,
    bonusConditions: publicBonus,
    requiredData: input.requiredData,
    source: "OKX 永續 · 已收盤 K 線 · deterministic · no look-ahead",
    updatedAt: input.context.now ?? new Date().toISOString(),
    conditionsMet: hardMet,
    conditionsTotal: hard.length,
    hardConditionsMet: hardMet,
    hardConditionsTotal: hard.length,
    bonusConditionsMet: bonusMet,
    bonusConditionsTotal: bonus.length,
  };
}

function missingResult(context: StrategyContext, strategy: StrategyName, timeframe: Timeframe, requiredData: string[], minimum: string, submodel: StrategySubmodel = null) {
  return result({
    context, strategy, submodel, timeframe, direction: "Neutral", baseStatus: "not_applicable", tradePlan: blankPlan(context.costs),
    conditions: [{ id: "required-data", label: minimum, kind: "hard", met: null, weight: 100 }],
    trigger: "等待必要的已收盤 K 線", invalidation: "資料缺失，不建立交易計畫",
    targetBasis: "資料缺失", requiredData,
  });
}

function ratioSupports(context: StrategyContext, direction: Direction) {
  const ratios = [context.topRatios.at(-1), context.globalRatios.at(-1)].filter((value): value is number => value !== undefined && Number.isFinite(value));
  if (!ratios.length || direction === "Neutral") return null;
  const average = ratios.reduce((sum, value) => sum + value, 0) / ratios.length;
  return direction === "Long" ? average >= 1 : average <= 1;
}

function fundingSupports(context: StrategyContext, direction: Direction) {
  if (context.funding === null || direction === "Neutral") return null;
  return direction === "Long" ? context.funding >= -0.0001 && context.funding < 0.0008 : context.funding <= 0.0001 && context.funding > -0.0008;
}

function detectFvg(candles: Candle[], direction: Direction, startIndex = 2, endIndex = candles.length - 1): Gap | null {
  let detected: Gap | null = null;
  for (let index = Math.max(2, startIndex); index <= Math.min(endIndex, candles.length - 1); index += 1) {
    if (direction === "Long" && candles[index].low > candles[index - 2].high) detected = { low: candles[index - 2].high, high: candles[index].low, index };
    if (direction === "Short" && candles[index].high < candles[index - 2].low) detected = { low: candles[index].high, high: candles[index - 2].low, index };
  }
  return detected;
}

function recentOrderBlock(candles: Candle[], direction: Direction, endIndex = candles.length - 1) {
  return [...candles.slice(Math.max(0, endIndex - 8), endIndex + 1)].reverse().find((row) => direction === "Long" ? row.close < row.open : direction === "Short" ? row.close > row.open : false) ?? null;
}

function decisionZoneBonus(candles: Candle[], direction: Direction, entryLow: number | null, entryHigh: number | null) {
  if (direction === "Neutral" || entryLow === null || entryHigh === null || candles.length < 30) return null;
  const gap = detectFvg(candles.slice(-30), direction);
  const block = recentOrderBlock(candles, direction);
  const overlaps = (low: number, high: number) => entryLow <= high && entryHigh >= low;
  const fvgOrOb = (gap && overlaps(gap.low, gap.high)) || (block && overlaps(block.low, block.high));
  const bounds = rollingBounds(candles, 30);
  const midpoint = bounds ? (bounds.high + bounds.low) / 2 : null;
  const location = midpoint === null ? false : direction === "Long" ? entryHigh <= midpoint : entryLow >= midpoint;
  return Boolean(fvgOrOb || location);
}

export function emaTrend(context: StrategyContext): StrategyResult {
  const oneHour = context.candlesByTimeframe["1h"];
  const fourHour = context.candlesByTimeframe["4h"];
  const fifteen = context.candlesByTimeframe["15m"];
  const five = context.candlesByTimeframe["5m"];
  if (oneHour.length < 55 || fourHour.length < 55 || fifteen.length < 55 || five.length < 55) {
    return missingResult(context, "EMA Trend", "15m", ["1h/4h EMA20/50", "5m/15m pullback", "confirmed structure"], "1H／4H、5m／15m 各至少 55 根已收盤 K 線");
  }
  const bias1h = trendBias(oneHour);
  const bias4h = trendBias(fourHour);
  const direction: Direction = bias1h && bias4h && !bias1h.tangled && !bias4h.tangled && bias1h.direction === bias4h.direction ? bias1h.direction : "Neutral";
  const fifteenFast = ema(closes(fifteen), 20)!;
  const fiveFast = ema(closes(five), 20)!;
  const currentAtr = atr(fifteen)!;
  const last = fifteen.at(-1)!;
  const lastFive = five.at(-1)!;
  const touched15 = direction === "Long"
    ? fifteen.slice(-3).some((row) => row.low <= fifteenFast + currentAtr * 0.18)
    : direction === "Short" ? fifteen.slice(-3).some((row) => row.high >= fifteenFast - currentAtr * 0.18) : false;
  const fiveAtr = atr(five)!;
  const touched5 = direction === "Long"
    ? five.slice(-4).some((row) => row.low <= fiveFast + fiveAtr * 0.18)
    : direction === "Short" ? five.slice(-4).some((row) => row.high >= fiveFast - fiveAtr * 0.18) : false;
  const pulledBack = touched15 || touched5;
  const swing = swingLevels(fifteen.slice(-50, -2));
  const structureIntact = swing ? (direction === "Long" ? last.close > swing.low : direction === "Short" ? last.close < swing.high : false) : null;
  const reclaimed15 = direction === "Long" ? touched15 && last.close > fifteenFast && last.close > last.open : direction === "Short" ? touched15 && last.close < fifteenFast && last.close < last.open : false;
  const reclaimed5 = direction === "Long" ? touched5 && lastFive.close > fiveFast && lastFive.close > lastFive.open : direction === "Short" ? touched5 && lastFive.close < fiveFast && lastFive.close < lastFive.open : false;
  const reclaimed = reclaimed15 || reclaimed5;
  const microBos = direction === "Long"
    ? lastFive.close > Math.max(...five.slice(-7, -1).map((row) => row.high))
    : direction === "Short" ? lastFive.close < Math.min(...five.slice(-7, -1).map((row) => row.low)) : false;
  const triggerMet = reclaimed || microBos;
  const executionFast = touched15 ? fifteenFast : fiveFast;
  const executionAtr = touched15 ? currentAtr : fiveAtr;
  const entryLow = direction === "Neutral" ? null : executionFast - executionAtr * 0.08;
  const entryHigh = direction === "Neutral" ? null : executionFast + executionAtr * 0.08;
  const stop = !swing || direction === "Neutral" ? null : direction === "Long" ? swing.low - currentAtr * 0.05 : swing.high + currentAtr * 0.05;
  const tradePlan = planFromStructure({ context, direction, entryLow, entryHigh, stop });
  const rrValid = stop === null ? null : tradePlan.primaryRiskReward !== null && tradePlan.primaryRiskReward >= 1.5;
  const volume = volumeStats(fifteen);
  const volumeBonus = volume ? volume.zScore >= 0.5 : null;
  const oiBonus = context.oiChange1h === null || direction === "Neutral" ? null : context.oiChange1h > 0;
  const zoneBonus = decisionZoneBonus(fifteen, direction, entryLow, entryHigh);
  const baseStatus: StrategyStatus = direction === "Neutral" ? "not_applicable"
    : structureIntact === false ? "invalidated"
      : pulledBack && triggerMet && structureIntact === true ? "executable"
        : pulledBack ? "waiting_trigger" : "forming";
  return result({
    context, strategy: "EMA Trend", timeframe: "15m", direction, baseStatus, tradePlan,
    conditions: [
      { id: "ema-bias", label: "1H／4H EMA20、EMA50 同向且斜率有效，無糾纏", kind: "hard", met: direction !== "Neutral", weight: 28 },
      { id: "ema-pullback", label: "5m／15m 回踩 EMA 決策區", kind: "hard", met: pulledBack, weight: 20 },
      { id: "ema-structure", label: "回踩未破壞主要趨勢結構", kind: "hard", met: structureIntact, weight: 18 },
      { id: "ema-trigger", label: "收盤重新站回 EMA 或微型 BOS（二擇一）", kind: "hard", met: triggerMet, weight: 20 },
      { id: "ema-rr", label: "結構 Stop 與真實目標提供淨 RR ≥ 1.5", kind: "hard", met: rrValid, weight: 14 },
      { id: "ema-volume", label: "成交量增加", kind: "bonus", met: volumeBonus, weight: 25 },
      { id: "ema-oi", label: "OI 變化配合方向", kind: "bonus", met: oiBonus, weight: 20 },
      { id: "ema-funding", label: "Funding 支持且未過熱", kind: "bonus", met: fundingSupports(context, direction), weight: 15 },
      { id: "ema-positioning", label: "Positioning 支持方向", kind: "bonus", met: ratioSupports(context, direction), weight: 15 },
      { id: "ema-zone", label: "FVG／OB 或 Premium／Discount 位置合理", kind: "bonus", met: zoneBonus, weight: 25 },
    ],
    trigger: "1H／4H 同向後，等待 5m／15m 回踩；收盤重新站回 EMA 或微型 BOS 任一成立即可。",
    invalidation: direction === "Long" ? "15m 收盤跌破回踩 swing low；Stop 位於該結構外。" : direction === "Short" ? "15m 收盤突破回踩 swing high；Stop 位於該結構外。" : "EMA 糾纏、斜率平坦或高週期 Bias 不一致。",
    targetBasis: "已確認前高低、PDH/PDL、session 或 swing liquidity；ATR 僅作結構外緩衝。",
    requiredData: ["1h candles", "4h candles", "15m candles", "5m candles", "EMA20/50 slope", "confirmed swings"],
  });
}

type BollingerSignal = { index: number; direction: Exclude<Direction, "Neutral">; boundary: number; percentile: number; expanding: boolean };

function recentBollingerSignal(candles: Candle[]): BollingerSignal | null {
  let signal: BollingerSignal | null = null;
  for (let index = Math.max(100, candles.length - 5); index < candles.length; index += 1) {
    const before = candles.slice(0, index);
    const throughSignal = candles.slice(0, index + 1);
    const percentile = bollingerWidthPercentile(before, 20, 100);
    const previousBand = bollinger(closes(before));
    const currentBand = bollinger(closes(throughSignal));
    const bounds = rollingBounds(before, 20);
    if (percentile === null || !previousBand || !currentBand || !bounds || previousBand.width === null || currentBand.width === null) continue;
    const expanding = currentBand.width > previousBand.width * 1.05;
    const row = candles[index];
    const direction = row.close > bounds.high || row.close > currentBand.upper ? "Long" : row.close < bounds.low || row.close < currentBand.lower ? "Short" : null;
    if (percentile <= 20 && expanding && direction) signal = { index, direction, boundary: direction === "Long" ? bounds.high : bounds.low, percentile, expanding };
  }
  return signal;
}

export function bollingerBreakout(context: StrategyContext): StrategyResult {
  const fifteen = context.candlesByTimeframe["15m"];
  if (fifteen.length < 105) return missingResult(context, "Bollinger Breakout", "15m", ["15m candles", "BB Width history", "structure targets"], "15m 至少 105 根已收盤 K 線");
  const signal = recentBollingerSignal(fifteen);
  const currentBand = bollinger(closes(fifteen));
  const previousBand = bollinger(closes(fifteen.slice(0, -1)));
  const currentPercentile = bollingerWidthPercentile(fifteen.slice(0, -1), 20, 100);
  const currentAtr = atr(fifteen);
  if (!currentBand || !previousBand || currentPercentile === null || currentAtr === null) return missingResult(context, "Bollinger Breakout", "15m", ["BB Width", "ATR", "compression range"], "完整 BB Width／ATR 歷史");
  const direction: Direction = signal?.direction ?? "Neutral";
  const compressed = signal ? signal.percentile <= 20 : currentPercentile <= 20;
  const expanding = signal?.expanding ?? (currentBand.width !== null && previousBand.width !== null && currentBand.width > previousBand.width * 1.05);
  const boundary = signal?.boundary ?? null;
  const postBreak = signal ? fifteen.slice(signal.index + 1) : [];
  const retest = boundary !== null && postBreak.some((row) => direction === "Long" ? row.low <= boundary && row.close > boundary : row.high >= boundary && row.close < boundary);
  const reentered = boundary !== null && postBreak.some((row) => direction === "Long" ? row.close < boundary : row.close > boundary);
  const last = fifteen.at(-1)!;
  const overextended = boundary === null ? false : Math.abs(last.close - boundary) > currentAtr * 1.25;
  const entryLow = boundary === null ? null : retest ? boundary - currentAtr * 0.08 : Math.min(boundary, last.close);
  const entryHigh = boundary === null ? null : retest ? boundary + currentAtr * 0.08 : Math.max(boundary, last.close);
  const structureRows = signal ? fifteen.slice(signal.index) : [];
  const stop = direction === "Long" && structureRows.length ? Math.min(...structureRows.map((row) => row.low)) - currentAtr * 0.05
    : direction === "Short" && structureRows.length ? Math.max(...structureRows.map((row) => row.high)) + currentAtr * 0.05 : null;
  const tradePlan = planFromStructure({ context, direction, entryLow, entryHigh, stop });
  const rrValid = stop === null ? null : tradePlan.primaryRiskReward !== null && tradePlan.primaryRiskReward >= 1.5;
  const signalVolume = signal ? volumeStats(fifteen.slice(0, signal.index + 1)) : volumeStats(fifteen);
  const bias1h = trendBias(context.candlesByTimeframe["1h"]);
  const bias4h = trendBias(context.candlesByTimeframe["4h"]);
  const emaAligned = !bias1h || !bias4h || direction === "Neutral" ? null : bias1h.direction === direction && bias4h.direction === direction;
  const oiBonus = context.oiChange1h === null || direction === "Neutral" ? null : context.oiChange1h > 0;
  const baseStatus: StrategyStatus = reentered || overextended ? "invalidated"
    : signal ? "executable"
      : compressed && expanding ? "waiting_trigger"
        : compressed ? "forming" : "not_applicable";
  return result({
    context, strategy: "Bollinger Breakout", timeframe: "15m", direction, baseStatus, tradePlan,
    conditions: [
      { id: "bb-compression", label: `BB Width 位於近 100 根歷史低 20%${signal ? `（${signal.percentile.toFixed(0)} 百分位）` : ""}`, kind: "hard", met: compressed, weight: 25 },
      { id: "bb-expansion", label: "Band Width 已開始擴張", kind: "hard", met: expanding, weight: 20 },
      { id: "bb-breakout", label: "已收盤突破壓縮區間或 Bollinger Band", kind: "hard", met: signal !== null, weight: 30 },
      { id: "bb-rr", label: "結構 Stop 與真實目標提供淨 RR ≥ 1.5", kind: "hard", met: rrValid, weight: 25 },
      { id: "bb-volume", label: "成交量放大", kind: "bonus", met: signalVolume ? signalVolume.zScore >= 1 : null, weight: 30 },
      { id: "bb-retest", label: "突破後回測成功", kind: "bonus", met: signal ? retest : false, weight: 30 },
      { id: "bb-ema", label: "EMA 趨勢方向一致", kind: "bonus", met: emaAligned, weight: 20 },
      { id: "bb-oi", label: "OI 增加", kind: "bonus", met: oiBonus, weight: 20 },
    ],
    trigger: "低 BB Width 開始擴張後，15m 必須有效收盤突破壓縮區間或 Band；回測加分但不是必要條件。",
    invalidation: reentered ? "突破後已收盤重回壓縮區，設定失效。" : overextended ? "價格距突破位超過 1.25 ATR，已過度延伸，不追價。" : "15m 收盤重新進入壓縮區，或越過突破結構 Stop。",
    targetBasis: "下一個已確認 swing、前高低或 session liquidity；ATR 僅作 Stop 緩衝。",
    extraMissingData: signalVolume ? [] : ["成交量統計"],
    requiredData: ["15m candles", "Bollinger Bands", "BB Width percentile", "compression range", "structure targets"],
  });
}

function oneMinuteBonus(context: StrategyContext, direction: Direction) {
  const one = context.candlesByTimeframe["1m"];
  if (one.length < 30 || direction === "Neutral") return null;
  const swing = swingLevels(one.slice(-25, -1));
  if (!swing) return null;
  return direction === "Long" ? one.at(-1)!.close > swing.high : one.at(-1)!.close < swing.low;
}

function premiumDiscountBonus(candles: Candle[], direction: Direction, entryLow: number | null, entryHigh: number | null) {
  if (candles.length < 20 || direction === "Neutral" || entryLow === null || entryHigh === null) return null;
  const bounds = rollingBounds(candles, 20);
  if (!bounds) return null;
  const midpoint = (bounds.high + bounds.low) / 2;
  return direction === "Long" ? entryHigh <= midpoint : entryLow >= midpoint;
}

function ictBonusConditions(context: StrategyContext, direction: Direction, entryLow: number | null, entryHigh: number | null): Condition[] {
  const bias1h = trendBias(context.candlesByTimeframe["1h"]);
  const bias4h = trendBias(context.candlesByTimeframe["4h"]);
  const emaAligned = !bias1h || !bias4h || direction === "Neutral" ? null : bias1h.direction === direction && bias4h.direction === direction;
  const oiBonus = context.oiChange1h === null || direction === "Neutral" ? null : context.oiChange1h > 0;
  return [
    { id: "ict-killzone", label: "Killzone／主要交易時段", kind: "bonus", met: currentSession(context.now ? new Date(context.now) : new Date()).name !== "Off-session", weight: 18 },
    { id: "ict-ema", label: "EMA 方向一致", kind: "bonus", met: emaAligned, weight: 18 },
    { id: "ict-oi", label: "OI 配合", kind: "bonus", met: oiBonus, weight: 14 },
    { id: "ict-funding", label: "Funding 支持且未過熱", kind: "bonus", met: fundingSupports(context, direction), weight: 12 },
    { id: "ict-positioning", label: "Positioning 配合", kind: "bonus", met: ratioSupports(context, direction), weight: 12 },
    { id: "ict-location", label: "Premium／Discount 位置合理", kind: "bonus", met: premiumDiscountBonus(context.candlesByTimeframe["15m"], direction, entryLow, entryHigh), weight: 16 },
    { id: "ict-1m", label: "1m 精細進場確認（只加分）", kind: "bonus", met: oneMinuteBonus(context, direction), weight: 10 },
  ];
}

export function ictReversal(context: StrategyContext): StrategyResult {
  const five = context.candlesByTimeframe["5m"];
  if (five.length < 60 || context.sessionLevels.length < 1) return missingResult(context, "ICT / SMC", "5m", ["5m candles", "PDH/PDL", "session/swing liquidity"], "5m 至少 60 根已收盤 K 線及有效 liquidity levels", "Reversal");
  const currentAtr = atr(five)!;
  let sweepIndex = -1;
  let sweptLevel: SessionLevel | null = null;
  let direction: Direction = "Neutral";
  for (let index = five.length - 1; index >= Math.max(0, five.length - 20); index -= 1) {
    const row = five[index];
    const low = context.sessionLevels.find((level) => LOW_LIQUIDITY.has(level.kind) && row.low < level.price && row.close > level.price);
    const high = context.sessionLevels.find((level) => HIGH_LIQUIDITY.has(level.kind) && row.high > level.price && row.close < level.price);
    if (low) { sweepIndex = index; sweptLevel = low; direction = "Long"; break; }
    if (high) { sweepIndex = index; sweptLevel = high; direction = "Short"; break; }
  }
  const preSweep = sweepIndex >= 0 ? swingLevels(five.slice(Math.max(0, sweepIndex - 40), sweepIndex)) : null;
  let displacementIndex = -1;
  for (let index = sweepIndex + 1; sweepIndex >= 0 && index < five.length; index += 1) {
    const row = five[index];
    const local = five.slice(Math.max(0, index - 4), index);
    const broke = direction === "Long" ? row.close > Math.max(...local.map((item) => item.high)) : row.close < Math.min(...local.map((item) => item.low));
    if (Math.abs(row.close - row.open) >= currentAtr * 0.7 && broke) { displacementIndex = index; break; }
  }
  const displacement = displacementIndex >= 0;
  const mss = displacement && preSweep ? (direction === "Long" ? five[displacementIndex].close > preSweep.high : five[displacementIndex].close < preSweep.low) : false;
  const fvg = displacement ? detectFvg(five, direction, displacementIndex, displacementIndex + 4) : null;
  const orderBlock = displacement ? recentOrderBlock(five, direction, displacementIndex) : null;
  const touchesZone = (row: Candle, low: number, high: number) => row.low <= high && row.high >= low && (direction === "Long" ? row.close > low : row.close < high);
  const fvgRetrace = fvg !== null && five.slice(fvg.index + 1).some((row) => touchesZone(row, fvg.low, fvg.high));
  const obRetrace = orderBlock !== null && five.slice(displacementIndex + 1).some((row) => touchesZone(row, orderBlock.low, orderBlock.high));
  const retrace = fvgRetrace || obRetrace;
  const selectedZone = fvgRetrace ? fvg : obRetrace ? orderBlock : fvg ?? orderBlock;
  const zoneLow = selectedZone?.low ?? null;
  const zoneHigh = selectedZone?.high ?? null;
  const sweptExtreme = sweepIndex >= 0 ? (direction === "Long" ? five[sweepIndex].low : five[sweepIndex].high) : null;
  const stop = sweptExtreme === null ? null : direction === "Long" ? sweptExtreme - currentAtr * 0.05 : sweptExtreme + currentAtr * 0.05;
  const tradePlan = planFromStructure({ context, direction, entryLow: zoneLow, entryHigh: zoneHigh, stop, liquidityOnly: true });
  const rrValid = stop === null ? null : tradePlan.primaryRiskReward !== null && tradePlan.primaryRiskReward >= 1.5;
  const invalidated = stop !== null && (direction === "Long" ? five.at(-1)!.close <= stop : direction === "Short" ? five.at(-1)!.close >= stop : false);
  const structuralComplete = sweptLevel !== null && displacement && mss && (fvg !== null || orderBlock !== null);
  const baseStatus: StrategyStatus = invalidated ? "invalidated" : !sweptLevel ? "not_applicable" : structuralComplete ? (retrace ? "executable" : "waiting_trigger") : "forming";
  return result({
    context, strategy: "ICT / SMC", submodel: "Reversal", timeframe: "5m", direction, baseStatus, tradePlan,
    conditions: [
      { id: "ict-reversal-sweep", label: sweptLevel ? `Sweep ${sweptLevel.label} 並以收盤收回` : "Sweep PDH/PDL、PWH/PWL、session、EQH/EQL 或 swing liquidity", kind: "hard", met: sweptLevel !== null, weight: 24 },
      { id: "ict-reversal-displacement", label: "Sweep 後出現明確 Displacement", kind: "hard", met: displacement, weight: 20 },
      { id: "ict-reversal-mss", label: "MSS／CHOCH 已由收盤確認", kind: "hard", met: mss, weight: 20 },
      { id: "ict-reversal-zone", label: "FVG 或 OB 任一成立", kind: "hard", met: fvg !== null || orderBlock !== null, weight: 18 },
      { id: "ict-reversal-rr", label: "Stop 位於被掃極值外且淨 RR ≥ 1.5", kind: "hard", met: rrValid, weight: 18 },
      ...ictBonusConditions(context, direction, zoneLow, zoneHigh),
    ],
    trigger: retrace ? "反轉模型已回到 FVG／OB 決策區。" : "Sweep → Displacement → 收盤 MSS/CHOCH 後，等待 FVG 或 OB 決策區觸發。",
    invalidation: sweptLevel ? `Stop 位於被掃極值 ${sweptExtreme} 外；5m 收盤再次越過即失效。` : "尚未出現有效 liquidity sweep。",
    targetBasis: "對側 PDH/PDL、PWH/PWL、session、EQH/EQL 或 swing liquidity。",
    reasons: ["ICT 子模型：反轉"],
    requiredData: ["5m candles", "PDH/PDL", "PWH/PWL", "session highs/lows", "EQH/EQL", "confirmed swings"],
  });
}

export function ictContinuation(context: StrategyContext): StrategyResult {
  const oneHour = context.candlesByTimeframe["1h"];
  const fourHour = context.candlesByTimeframe["4h"];
  const five = context.candlesByTimeframe["5m"];
  if (oneHour.length < 55 || fourHour.length < 55 || five.length < 60) return missingResult(context, "ICT / SMC", "5m", ["1h/4h bias", "5m BOS/displacement", "FVG/OB"], "1H／4H 至少 55 根、5m 至少 60 根已收盤 K 線", "Continuation");
  const bias1h = trendBias(oneHour);
  const bias4h = trendBias(fourHour);
  const direction: Direction = bias1h && bias4h && bias1h.direction === bias4h.direction ? bias1h.direction : "Neutral";
  const currentAtr = atr(five)!;
  let displacementIndex = -1;
  for (let index = Math.max(40, five.length - 20); direction !== "Neutral" && index < five.length; index += 1) {
    const prior = swingLevels(five.slice(Math.max(0, index - 40), index));
    const row = five[index];
    if (!prior) continue;
    const bos = direction === "Long" ? row.close > prior.high : row.close < prior.low;
    if (bos && Math.abs(row.close - row.open) >= currentAtr * 0.7) { displacementIndex = index; break; }
  }
  const bosDisplacement = displacementIndex >= 0;
  const fvg = bosDisplacement ? detectFvg(five, direction, displacementIndex, displacementIndex + 4) : null;
  const orderBlock = bosDisplacement ? recentOrderBlock(five, direction, displacementIndex) : null;
  const touchesZone = (row: Candle, low: number, high: number) => row.low <= high && row.high >= low && (direction === "Long" ? row.close > low : row.close < high);
  const fvgRetrace = fvg !== null && five.slice(fvg.index + 1).some((row) => touchesZone(row, fvg.low, fvg.high));
  const obRetrace = orderBlock !== null && five.slice(displacementIndex + 1).some((row) => touchesZone(row, orderBlock.low, orderBlock.high));
  const retrace = fvgRetrace || obRetrace;
  const selectedZone = fvgRetrace ? fvg : obRetrace ? orderBlock : fvg ?? orderBlock;
  const zoneLow = selectedZone?.low ?? null;
  const zoneHigh = selectedZone?.high ?? null;
  const structure = bosDisplacement ? swingLevels(five.slice(Math.max(0, displacementIndex - 40), displacementIndex + 1)) : null;
  const stop = !structure || direction === "Neutral" ? null : direction === "Long" ? structure.low - currentAtr * 0.05 : structure.high + currentAtr * 0.05;
  const tradePlan = planFromStructure({ context, direction, entryLow: zoneLow, entryHigh: zoneHigh, stop, liquidityOnly: true });
  const rrValid = stop === null ? null : tradePlan.primaryRiskReward !== null && tradePlan.primaryRiskReward >= 1.5;
  const invalidated = stop !== null && (direction === "Long" ? five.at(-1)!.close <= stop : direction === "Short" ? five.at(-1)!.close >= stop : false);
  const baseStatus: StrategyStatus = invalidated ? "invalidated" : direction === "Neutral" ? "not_applicable" : bosDisplacement ? (retrace ? "executable" : "waiting_trigger") : "forming";
  return result({
    context, strategy: "ICT / SMC", submodel: "Continuation", timeframe: "5m", direction, baseStatus, tradePlan,
    conditions: [
      { id: "ict-continuation-bias", label: "1H／4H 高週期 Bias 明確且同向", kind: "hard", met: direction !== "Neutral", weight: 25 },
      { id: "ict-continuation-bos", label: "BOS 與有效 Displacement 已由收盤確認", kind: "hard", met: bosDisplacement, weight: 25 },
      { id: "ict-continuation-retrace", label: "已回踩 FVG 或 OB 任一決策區", kind: "hard", met: retrace, weight: 25 },
      { id: "ict-continuation-rr", label: "結構失效 Stop、下一流動性目標與淨 RR ≥ 1.5", kind: "hard", met: rrValid, weight: 25 },
      ...ictBonusConditions(context, direction, zoneLow, zoneHigh),
    ],
    trigger: "高週期 Bias 明確後，等待 5m BOS＋Displacement，再回踩 FVG 或 OB；延續模型不要求先 Sweep。",
    invalidation: direction === "Long" ? "5m 收盤跌破 BOS 前結構 low。" : direction === "Short" ? "5m 收盤突破 BOS 前結構 high。" : "高週期 Bias 不明確。",
    targetBasis: "下一個 PDH/PDL、session、EQH/EQL 或已確認 swing liquidity。",
    reasons: ["ICT 子模型：延續"],
    requiredData: ["1h candles", "4h candles", "5m candles", "confirmed BOS", "FVG or OB", "next liquidity"],
  });
}

const ICT_STATUS_RANK: Record<StrategyStatus, number> = { executable: 5, waiting_trigger: 4, forming: 3, invalidated: 2, not_applicable: 1 };

export function ictSmc(context: StrategyContext): StrategyResult {
  return [ictReversal(context), ictContinuation(context)].sort((a, b) => ICT_STATUS_RANK[b.status] - ICT_STATUS_RANK[a.status] || (b.primaryRiskReward ?? -1) - (a.primaryRiskReward ?? -1) || b.confidence - a.confidence)[0];
}

export const STRATEGY_EVALUATORS = {
  "EMA Trend": emaTrend,
  "Bollinger Breakout": bollingerBreakout,
  "ICT / SMC": ictSmc,
} satisfies Record<StrategyName, (context: StrategyContext) => StrategyResult>;

export function evaluateStrategies(context: StrategyContext) {
  return Object.values(STRATEGY_EVALUATORS).map((evaluate) => evaluate(context));
}
