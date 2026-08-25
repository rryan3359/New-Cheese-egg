import { atr, bollinger, bollingerWidthPercentile, ema, rollingBounds, swingLevels, volumeStats } from "./indicators";
import {
  DEFAULT_TRADE_COSTS,
  type Candle,
  type CandleMap,
  type SessionLevel,
  type StrategyName,
  type StrategyResult,
  type StrategyStatus,
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
type Condition = { label: string; met: boolean | null; weight: number; required?: boolean };
type Plan = Pick<StrategyResult,
  "entryLow" | "entryHigh" | "stop" | "tp1" | "tp2" | "tp3" | "riskReward" |
  "riskRewardTp1" | "riskRewardTp2" | "riskRewardTp3" | "primaryRiskReward" |
  "grossRiskRewardTp1" | "grossRiskRewardTp2" | "grossRiskRewardTp3" |
  "primaryTarget" | "entryBasis" | "feeRate" | "slippageRate" | "roundTripCostRate"
>;

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

/**
 * v13 RR engine: worst entry boundary, structural stop/targets, then round-trip fees and slippage.
 * Targets are never moved to manufacture an RR threshold.
 */
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
  const costPerUnit = entry * roundTripCostRate;
  const netRisk = grossRisk + costPerUnit;
  const reward = (target: number | null) => {
    if (target === null) return { gross: null, net: null };
    const grossReward = input.direction === "Long" ? target - entry : entry - target;
    if (!Number.isFinite(grossReward) || grossReward <= 0) return { gross: null, net: null };
    const netReward = grossReward - costPerUnit;
    return { gross: grossReward / grossRisk, net: netReward > 0 ? netReward / netRisk : null };
  };
  const one = reward(levels.tp1);
  const two = reward(levels.tp2);
  const three = reward(levels.tp3);
  const requested = input.primaryTarget ?? (levels.tp2 !== null ? "TP2" : "TP1");
  const primaryRiskReward = requested === "TP1" ? one.net : requested === "TP2" ? two.net : three.net;
  return {
    ...levels,
    riskReward: primaryRiskReward,
    riskRewardTp1: one.net,
    riskRewardTp2: two.net,
    riskRewardTp3: three.net,
    primaryRiskReward,
    grossRiskRewardTp1: one.gross,
    grossRiskRewardTp2: two.gross,
    grossRiskRewardTp3: three.gross,
    primaryTarget: primaryRiskReward === null ? null : requested,
    entryBasis: "conservative-boundary",
    feeRate: costs.feeRate,
    slippageRate: costs.slippageRate,
    roundTripCostRate,
  };
}

function closes(candles: Candle[]) { return candles.map((candle) => candle.close); }

function trendBias(candles: Candle[]): Direction {
  if (candles.length < 55) return "Neutral";
  const values = closes(candles);
  const fast = ema(values, 20);
  const slow = ema(values, 50);
  const priorFast = ema(values.slice(0, -3), 20);
  const priorSlow = ema(values.slice(0, -3), 50);
  if ([fast, slow, priorFast, priorSlow].some((value) => value === null)) return "Neutral";
  if (fast! > slow! && fast! > priorFast! && slow! >= priorSlow!) return "Long";
  if (fast! < slow! && fast! < priorFast! && slow! <= priorSlow!) return "Short";
  return "Neutral";
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
  const highKinds = new Set(["PDH", "PWH", "ASIA_HIGH", "LONDON_HIGH", "NEW_YORK_HIGH", "EQH", "SWING_HIGH"]);
  const lowKinds = new Set(["PDL", "PWL", "ASIA_LOW", "LONDON_LOW", "NEW_YORK_LOW", "EQL", "SWING_LOW"]);
  const sessionCandidates = context.sessionLevels
    .filter((level) => direction === "Long" ? highKinds.has(level.kind) : lowKinds.has(level.kind))
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
    stop: input.stop, tp1, tp2, tp3, primaryTarget: tp2 === null ? "TP1" : "TP2",
    feeRate: input.context.costs?.feeRate, slippageRate: input.context.costs?.slippageRate,
  });
}

function result(input: {
  context: StrategyContext;
  strategy: StrategyName;
  timeframe: Timeframe;
  direction: Direction;
  baseStatus: StrategyStatus;
  conditions: Condition[];
  tradePlan: Plan;
  trigger: string;
  invalidation: string;
  targetBasis: string;
  reasons?: string[];
  extraMissing?: string[];
  requiredData: string[];
}): StrategyResult {
  const known = input.conditions.filter((condition) => condition.met !== null);
  const met = known.filter((condition) => condition.met === true);
  const score = Math.round(input.conditions.reduce((sum, condition) => sum + (condition.met ? condition.weight : 0), 0));
  let status: StrategyStatus = input.conditions.some((condition) => condition.required && condition.met === null) ? "missing" : input.baseStatus;
  const gateMessages: string[] = [];
  const netRr = input.tradePlan.primaryRiskReward;
  if (["eligible", "waiting"].includes(status)) {
    if (netRr === null || netRr < 1.5) {
      status = "invalid";
      gateMessages.push(netRr === null ? "沒有可驗證的真實結構／流動性目標" : `淨 RR ${netRr.toFixed(2)} 低於 1.5，已淘汰`);
    } else if (netRr < 2) {
      status = "waiting";
      gateMessages.push(`淨 RR ${netRr.toFixed(2)} 介於 1.5–2，僅列形成中／觀察`);
    } else if (status !== "eligible") {
      status = "waiting";
    }
  }
  const missingConditions = [
    ...input.conditions.filter((condition) => condition.met === false).map((condition) => condition.label),
    ...input.conditions.filter((condition) => condition.met === null).map((condition) => `${condition.label}（資料缺少）`),
    ...gateMessages,
    ...(input.extraMissing ?? []),
  ];
  const costs = input.context.costs ?? DEFAULT_TRADE_COSTS;
  const plan = status === "missing" ? blankPlan(costs) : input.tradePlan;
  return {
    id: `${input.context.symbol}-${input.timeframe}-${input.strategy.toLowerCase().replaceAll(" ", "-").replaceAll("/", "-")}`,
    symbol: input.context.symbol,
    timeframe: input.timeframe,
    strategy: input.strategy,
    direction: status === "missing" ? "Neutral" : input.direction,
    status,
    confidence: status === "missing" ? Math.min(score, 35) : Math.min(95, score),
    ...plan,
    eligibleForScanner: plan.primaryRiskReward !== null && plan.primaryRiskReward >= 1.5 && (status === "eligible" || status === "waiting"),
    trigger: input.trigger,
    invalidation: input.invalidation,
    targetBasis: input.targetBasis,
    reasons: [...(input.reasons ?? []), ...met.map((condition) => condition.label)],
    missingConditions,
    requiredData: input.requiredData,
    source: "OKX 已收盤 K 線 · deterministic · no look-ahead",
    updatedAt: input.context.now ?? new Date().toISOString(),
    conditionsMet: met.length,
    conditionsTotal: input.conditions.length,
  };
}

function missingResult(context: StrategyContext, strategy: StrategyName, timeframe: Timeframe, requiredData: string[], minimum: string) {
  return result({
    context, strategy, timeframe, direction: "Neutral", baseStatus: "missing", tradePlan: blankPlan(context.costs),
    conditions: [{ label: minimum, met: null, weight: 100, required: true }],
    trigger: "等待必要的已收盤 K 線", invalidation: "資料不足，不建立交易計畫",
    targetBasis: "資料不足", requiredData,
  });
}

export function emaTrend(context: StrategyContext): StrategyResult {
  const oneHour = context.candlesByTimeframe["1h"];
  const fourHour = context.candlesByTimeframe["4h"];
  const fifteen = context.candlesByTimeframe["15m"];
  const five = context.candlesByTimeframe["5m"];
  if (oneHour.length < 55 || fourHour.length < 55 || fifteen.length < 55 || five.length < 25) {
    return missingResult(context, "EMA Trend", "15m", ["1H/4H EMA20/50", "15m pullback", "5m structure", "volume"], "1H／4H 至少 55 根，15m 至少 55 根，5m 至少 25 根");
  }
  const bias1h = trendBias(oneHour);
  const bias4h = trendBias(fourHour);
  const direction: Direction = bias1h === bias4h ? bias1h : "Neutral";
  const values = closes(fifteen);
  const fast = ema(values, 20)!;
  const currentAtr = atr(fifteen)!;
  const volume = volumeStats(fifteen);
  const last = fifteen.at(-1)!;
  const previous = fifteen.at(-2)!;
  const touched = direction === "Long"
    ? Math.min(last.low, previous.low) <= fast + currentAtr * 0.18
    : direction === "Short" ? Math.max(last.high, previous.high) >= fast - currentAtr * 0.18 : false;
  const reclaimed = direction === "Long" ? last.close > fast && last.close > last.open : direction === "Short" ? last.close < fast && last.close < last.open : false;
  const structure = direction === "Long"
    ? last.close > Math.max(...fifteen.slice(-5, -1).map((row) => row.high))
    : direction === "Short" ? last.close < Math.min(...fifteen.slice(-5, -1).map((row) => row.low)) : false;
  const fiveSwing = swingLevels(five.slice(-35, -1));
  const fiveConfirm = fiveSwing ? (direction === "Long" ? five.at(-1)!.close > fiveSwing.high : direction === "Short" ? five.at(-1)!.close < fiveSwing.low : false) : null;
  const volumeOk = volume ? volume.zScore >= -0.5 : null;
  const swing = swingLevels(fifteen.slice(-50, -1));
  const entryLow = direction === "Neutral" ? null : fast - currentAtr * 0.08;
  const entryHigh = direction === "Neutral" ? null : fast + currentAtr * 0.08;
  const stop = !swing || direction === "Neutral" ? null : direction === "Long" ? swing.low - currentAtr * 0.05 : swing.high + currentAtr * 0.05;
  const tradePlan = planFromStructure({ context, direction, entryLow, entryHigh, stop });
  const complete = direction !== "Neutral" && touched && reclaimed && structure && fiveConfirm === true && volumeOk === true;
  const near = direction !== "Neutral" && Math.abs(last.close - fast) <= currentAtr;
  const baseStatus: StrategyStatus = direction === "Neutral" ? "invalid" : complete ? "eligible" : touched || near ? "waiting" : "applicable";
  return result({
    context, strategy: "EMA Trend", timeframe: "15m", direction, baseStatus, tradePlan,
    conditions: [
      { label: "1H／4H EMA20、EMA50 與斜率同向", met: direction !== "Neutral", weight: 28, required: true },
      { label: "15m 回踩 EMA20 決策區", met: touched, weight: 20 },
      { label: "15m 已收盤重新站穩並突破短期結構", met: reclaimed && structure, weight: 24 },
      { label: "5m 已收盤結構確認", met: fiveConfirm, weight: 18, required: true },
      { label: "成交量未明顯萎縮", met: volumeOk, weight: 10, required: true },
    ],
    trigger: "1H／4H 同向後，只在 15m 回踩 EMA20、重新站穩且 5m 結構確認時執行。",
    invalidation: direction === "Long" ? "15m 收盤跌破回踩 swing low；Stop 放在該 swing 外。" : direction === "Short" ? "15m 收盤突破回踩 swing high；Stop 放在該 swing 外。" : "1H／4H Bias 不一致。",
    targetBasis: "已確認前高低、PDH/PDL、session 或 swing liquidity；不使用固定 ATR 目標。",
    requiredData: ["1h candles", "4h candles", "15m candles", "5m candles", "EMA20/50 slope", "confirmed swings", "volume"],
  });
}

export function bollingerBreakout(context: StrategyContext): StrategyResult {
  const fifteen = context.candlesByTimeframe["15m"];
  if (fifteen.length < 105) return missingResult(context, "Bollinger Breakout", "15m", ["15m candles", "BB Width history", "volume", "structure targets"], "15m 至少 105 根已收盤 K 線");
  const currentBand = bollinger(closes(fifteen));
  const previousBand = bollinger(closes(fifteen.slice(0, -1)));
  const percentile = bollingerWidthPercentile(fifteen.slice(0, -1));
  const currentAtr = atr(fifteen);
  const bounds = rollingBounds(fifteen, 20, true);
  const volume = volumeStats(fifteen);
  if (!currentBand || !previousBand || percentile === null || currentAtr === null || !bounds || !volume) return missingResult(context, "Bollinger Breakout", "15m", ["BB Width", "ATR", "volume", "compression range"], "完整 BB Width／ATR／成交量歷史");
  const compressed = percentile <= 20;
  const expanding = currentBand.width !== null && previousBand.width !== null && currentBand.width > previousBand.width * 1.05;
  let breakoutIndex = -1;
  let direction: Direction = "Neutral";
  for (let index = Math.max(0, fifteen.length - 4); index < fifteen.length; index += 1) {
    const row = fifteen[index];
    if (row.close > bounds.high && row.close > currentBand.upper) { breakoutIndex = index; direction = "Long"; break; }
    if (row.close < bounds.low && row.close < currentBand.lower) { breakoutIndex = index; direction = "Short"; break; }
  }
  const boundary = direction === "Long" ? bounds.high : direction === "Short" ? bounds.low : null;
  const postBreak = breakoutIndex >= 0 ? fifteen.slice(breakoutIndex + 1) : [];
  const retest = boundary !== null && postBreak.some((row) => direction === "Long" ? row.low <= boundary && row.close > boundary : row.high >= boundary && row.close < boundary);
  const last = fifteen.at(-1)!;
  const overextended = boundary === null ? false : Math.abs(last.close - boundary) > currentAtr * 1.25;
  const volumeOk = volume.zScore >= 1;
  const entryLow = boundary === null ? null : boundary - currentAtr * 0.08;
  const entryHigh = boundary === null ? null : boundary + currentAtr * 0.08;
  const retestRows = breakoutIndex >= 0 ? fifteen.slice(breakoutIndex) : [];
  const stop = direction === "Long"
    ? (retestRows.length ? Math.min(...retestRows.map((row) => row.low), bounds.low) : null)
    : direction === "Short" ? (retestRows.length ? Math.max(...retestRows.map((row) => row.high), bounds.high) : null) : null;
  const tradePlan = planFromStructure({ context, direction, entryLow, entryHigh, stop });
  const complete = compressed && expanding && direction !== "Neutral" && volumeOk && retest && !overextended;
  const baseStatus: StrategyStatus = complete ? "eligible" : compressed && (direction !== "Neutral" || expanding) ? "waiting" : compressed ? "applicable" : "invalid";
  return result({
    context, strategy: "Bollinger Breakout", timeframe: "15m", direction, baseStatus, tradePlan,
    conditions: [
      { label: `前一根 BB Width 位於歷史低百分位（${percentile.toFixed(0)}）`, met: compressed, weight: 24, required: true },
      { label: "BB Width 已開始擴張", met: expanding, weight: 18 },
      { label: "已收盤突破 Band 與壓縮區間", met: direction !== "Neutral", weight: 22 },
      { label: "成交量 z-score 至少 1", met: volumeOk, weight: 16, required: true },
      { label: "突破後完成回測，不追延伸價格", met: retest && !overextended, weight: 20 },
    ],
    trigger: "低 BB Width 後擴張，15m 收盤突破壓縮區並放量；優先等突破位回測。",
    invalidation: "15m 收盤重新進入壓縮區，或跌破／突破回測結構；Stop 放在該結構失效位。",
    targetBasis: "下一個已確認 swing、前高低或 session liquidity；不以 ATR 倍數生成。",
    reasons: overextended ? [] : ["價格尚未超過突破位 1.25 ATR"],
    extraMissing: overextended ? ["價格已過度延伸，等待回測，不追價"] : [],
    requiredData: ["15m candles", "Bollinger Bands", "BB Width percentile", "volume z-score", "compression range", "structure targets"],
  });
}

type Gap = { low: number; high: number; index: number };

export function ictSmc(context: StrategyContext): StrategyResult {
  const oneHour = context.candlesByTimeframe["1h"];
  const fourHour = context.candlesByTimeframe["4h"];
  const five = context.candlesByTimeframe["5m"];
  const one = context.candlesByTimeframe["1m"];
  if (oneHour.length < 55 || fourHour.length < 55 || five.length < 60 || one.length < 30 || context.sessionLevels.length < 2) {
    return missingResult(context, "ICT / SMC", "5m", ["1m/5m/15m", "1h/4h bias", "PDH/PDL", "session levels", "confirmed swings"], "1H／4H 至少 55 根、5m 至少 60 根、1m 至少 30 根及 session levels");
  }
  const bias1h = trendBias(oneHour);
  const bias4h = trendBias(fourHour);
  const bias: Direction = bias1h === bias4h ? bias1h : "Neutral";
  const currentAtr = atr(five)!;
  const highKinds = new Set(["PDH", "PWH", "ASIA_HIGH", "LONDON_HIGH", "NEW_YORK_HIGH", "EQH", "SWING_HIGH"]);
  const lowKinds = new Set(["PDL", "PWL", "ASIA_LOW", "LONDON_LOW", "NEW_YORK_LOW", "EQL", "SWING_LOW"]);
  const startIndex = Math.max(0, five.length - 20);
  let sweepIndex = -1;
  let sweptLevel: SessionLevel | null = null;
  let direction: Direction = "Neutral";
  for (let index = five.length - 1; index >= startIndex; index -= 1) {
    const row = five[index];
    const low = context.sessionLevels.find((level) => lowKinds.has(level.kind) && row.low < level.price && row.close > level.price);
    const high = context.sessionLevels.find((level) => highKinds.has(level.kind) && row.high > level.price && row.close < level.price);
    if (low && (bias === "Long" || bias === "Neutral")) { sweepIndex = index; sweptLevel = low; direction = "Long"; break; }
    if (high && (bias === "Short" || bias === "Neutral")) { sweepIndex = index; sweptLevel = high; direction = "Short"; break; }
  }
  const preSweep = sweepIndex >= 0 ? swingLevels(five.slice(Math.max(0, sweepIndex - 40), sweepIndex + 1)) : null;
  let displacementIndex = -1;
  if (sweepIndex >= 0) {
    for (let index = sweepIndex + 1; index < five.length; index += 1) {
      const row = five[index];
      const body = Math.abs(row.close - row.open);
      const local = five.slice(Math.max(0, index - 4), index);
      const broke = direction === "Long" ? row.close > Math.max(...local.map((item) => item.high)) : row.close < Math.min(...local.map((item) => item.low));
      if (body >= currentAtr * 0.7 && broke) { displacementIndex = index; break; }
    }
  }
  const displacement = displacementIndex >= 0;
  const mss = displacement && preSweep ? (direction === "Long" ? five[displacementIndex].close > preSweep.high : five[displacementIndex].close < preSweep.low) : false;
  let fvg: Gap | null = null;
  if (displacement) {
    for (let index = Math.max(sweepIndex + 2, displacementIndex); index < five.length; index += 1) {
      if (direction === "Long" && five[index].low > five[index - 2].high) fvg = { low: five[index - 2].high, high: five[index].low, index };
      if (direction === "Short" && five[index].high < five[index - 2].low) fvg = { low: five[index].high, high: five[index - 2].low, index };
      if (fvg) break;
    }
  }
  const orderBlock = displacementIndex >= 0
    ? [...five.slice(sweepIndex, displacementIndex + 1)].reverse().find((row) => direction === "Long" ? row.close < row.open : row.close > row.open) ?? null
    : null;
  const zoneLow = fvg?.low ?? orderBlock?.low ?? null;
  const zoneHigh = fvg?.high ?? orderBlock?.high ?? null;
  const last = five.at(-1)!;
  const retrace = zoneLow !== null && zoneHigh !== null && last.low <= zoneHigh && last.high >= zoneLow && (direction === "Long" ? last.close > zoneLow : last.close < zoneHigh);
  const oneSwing = swingLevels(one.slice(-25, -1));
  const oneMinuteConfirm = oneSwing ? (direction === "Long" ? one.at(-1)!.close > oneSwing.high : direction === "Short" ? one.at(-1)!.close < oneSwing.low : false) : null;
  const sweptExtreme = sweepIndex >= 0 ? (direction === "Long" ? five[sweepIndex].low : five[sweepIndex].high) : null;
  const stop = sweptExtreme === null ? null : direction === "Long" ? sweptExtreme - currentAtr * 0.05 : sweptExtreme + currentAtr * 0.05;
  const tradePlan = planFromStructure({ context, direction, entryLow: zoneLow, entryHigh: zoneHigh, stop, liquidityOnly: true });
  const complete = bias !== "Neutral" && sweptLevel !== null && displacement && mss && fvg !== null && orderBlock !== null && retrace && oneMinuteConfirm === true;
  const baseStatus: StrategyStatus = bias === "Neutral" ? "invalid" : complete ? "eligible" : sweptLevel || displacement ? "waiting" : "applicable";
  const background = [
    ...(context.funding !== null && Math.abs(context.funding) >= 0.0005 ? [`Funding ${(context.funding * 100).toFixed(4)}%（僅背景）`] : []),
    ...(context.oiChange1h !== null && Math.abs(context.oiChange1h) >= 4 ? [`OI 1h ${context.oiChange1h.toFixed(2)}%（僅背景）`] : []),
  ];
  return result({
    context, strategy: "ICT / SMC", timeframe: "5m", direction, baseStatus, tradePlan,
    conditions: [
      { label: "1H／4H EMA Bias 同向", met: bias !== "Neutral", weight: 18, required: true },
      { label: sweptLevel ? `Sweep ${sweptLevel.label} 並以已收盤 K 線收回` : "Sweep PDH/PDL、session、EQH/EQL 或 swing liquidity", met: sweptLevel !== null, weight: 20 },
      { label: "Sweep 後出現至少 0.7 ATR displacement", met: displacement, weight: 16 },
      { label: "Displacement 收盤完成 MSS/BOS", met: mss, weight: 16 },
      { label: "形成三根 K 線 FVG 與有效 OB", met: fvg !== null && orderBlock !== null, weight: 14 },
      { label: "回踩 FVG/OB 並有 1m 結構確認", met: retrace && oneMinuteConfirm === true, weight: 16, required: true },
    ],
    trigger: "嚴格依序等待 Sweep → Displacement → MSS/BOS → FVG/OB 回踩；所有判斷只使用已收盤 K 線。",
    invalidation: sweptLevel ? `Stop 放在被掃極值 ${sweptExtreme} 外；5m 收盤再次越過即失效。` : "尚未出現符合高週期 Bias 的有效 liquidity sweep。",
    targetBasis: "只指向對側 PDH/PDL、PWH/PWL、session、EQH/EQL 或 swing liquidity。",
    reasons: background,
    requiredData: ["1m candles", "5m candles", "15m candles", "1h/4h bias", "PDH/PDL", "PWH/PWL", "session highs/lows", "EQH/EQL", "FVG", "OB"],
  });
}

export const STRATEGY_EVALUATORS = {
  "EMA Trend": emaTrend,
  "Bollinger Breakout": bollingerBreakout,
  "ICT / SMC": ictSmc,
} satisfies Record<StrategyName, (context: StrategyContext) => StrategyResult>;

export function evaluateStrategies(context: StrategyContext) {
  return Object.values(STRATEGY_EVALUATORS).map((evaluate) => evaluate(context));
}
