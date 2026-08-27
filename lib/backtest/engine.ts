import { atr, bollinger, ema } from "../market/indicators";
import { buildSessionLevels, currentSession } from "../market/sessions";
import { evaluateStrategies } from "../market/strategies";
import { DEFAULT_TRADE_COSTS, STRATEGY_NAMES, TIMEFRAMES, type Candle, type CandleMap, type StrategyName, type Timeframe, type TradeCosts } from "../market/types";

export type BacktestDataset = { symbol: string; candlesByTimeframe: CandleMap };
export type RrThreshold = 1.5 | 2;
export type BacktestTrade = {
  symbol: string;
  strategy: StrategyName;
  timeframe: Timeframe;
  session: string;
  regime: string;
  threshold: RrThreshold;
  signalAt: string;
  entryAt: string;
  exitAt: string;
  direction: "Long" | "Short";
  entry: number;
  stop: number;
  target: number;
  exit: number;
  plannedNetRr: number;
  realizedR: number;
  outcome: "target" | "stop" | "timeout";
};

export type BacktestMetrics = {
  trades: number;
  wins: number;
  winRate: number | null;
  averageR: number | null;
  expectancy: number | null;
  profitFactor: number | null;
  maxDrawdownR: number | null;
  sampleSufficient: boolean;
  sampleNote: string;
};

export type BacktestReport = {
  generatedAt: string;
  assumptions: string[];
  comparisons: Array<{
    strategy: StrategyName;
    minimumNetRr: RrThreshold;
    metrics: BacktestMetrics;
    breakdown: {
      bySymbol: Array<{ key: string; metrics: BacktestMetrics }>;
      byTimeframe: Array<{ key: string; metrics: BacktestMetrics }>;
      bySession: Array<{ key: string; metrics: BacktestMetrics }>;
      byRegime: Array<{ key: string; metrics: BacktestMetrics }>;
    };
  }>;
  trades: BacktestTrade[];
};

const durationMs: Record<Timeframe, number> = { "1m": 60_000, "5m": 300_000, "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000 };
const executionTimeframe: Record<StrategyName, Timeframe> = { "EMA Trend": "15m", "Bollinger Breakout": "15m", "ICT / SMC": "5m" };

function sliceClosed(map: CandleMap, decisionClose: number): CandleMap {
  return Object.fromEntries(TIMEFRAMES.map((timeframe) => [
    timeframe,
    map[timeframe].filter((candle) => candle.time + durationMs[timeframe] <= decisionClose),
  ])) as CandleMap;
}

function marketRegime(map: CandleMap) {
  const oneHour = map["1h"];
  const fifteen = map["15m"];
  if (oneHour.length < 50 || fifteen.length < 30) return "Insufficient";
  const oneCloses = oneHour.map((candle) => candle.close);
  const fast = ema(oneCloses, 20);
  const slow = ema(oneCloses, 50);
  const currentAtr = atr(fifteen);
  const price = fifteen.at(-1)?.close ?? null;
  const bands = bollinger(fifteen.map((candle) => candle.close));
  if (bands?.width !== null && bands?.width !== undefined && bands.width < 0.01) return "Compression";
  if (currentAtr !== null && price && currentAtr / price > 0.012) return "High Volatility";
  if (fast !== null && slow !== null) return fast > slow ? "Trend Up" : fast < slow ? "Trend Down" : "Range";
  return "Range";
}

function primaryTarget(setup: ReturnType<typeof evaluateStrategies>[number]) {
  if (setup.primaryTarget === "TP1") return setup.tp1;
  if (setup.primaryTarget === "TP2") return setup.tp2;
  if (setup.primaryTarget === "TP3") return setup.tp3;
  return null;
}

function findFill(candles: Candle[], signalIndex: number, price: number) {
  for (let index = signalIndex + 1; index <= Math.min(signalIndex + 3, candles.length - 1); index += 1) {
    const candle = candles[index];
    if (candle.low <= price && candle.high >= price) return index;
  }
  return -1;
}

function simulateExit(candles: Candle[], fillIndex: number, direction: "Long" | "Short", stop: number, target: number) {
  const end = Math.min(candles.length - 1, fillIndex + 96);
  for (let index = fillIndex; index <= end; index += 1) {
    const candle = candles[index];
    const stopHit = direction === "Long" ? candle.low <= stop : candle.high >= stop;
    const targetHit = direction === "Long" ? candle.high >= target : candle.low <= target;
    // Conservative ambiguity rule: if both are touched in one bar, stop wins.
    if (stopHit) return { index, price: stop, outcome: "stop" as const };
    if (targetHit) return { index, price: target, outcome: "target" as const };
  }
  return { index: end, price: candles[end].close, outcome: "timeout" as const };
}

function realizedR(direction: "Long" | "Short", entry: number, stop: number, exit: number, roundTripCostRate: number) {
  const oneWayCostRate = roundTripCostRate / 2;
  const initialRisk = Math.abs(entry - stop) + (entry + stop) * oneWayCostRate;
  const gross = direction === "Long" ? exit - entry : entry - exit;
  return initialRisk > 0 ? (gross - (entry + exit) * oneWayCostRate) / initialRisk : 0;
}

function groupMetrics(trades: BacktestTrade[], selector: (trade: BacktestTrade) => string) {
  const groups = new Map<string, BacktestTrade[]>();
  for (const trade of trades) groups.set(selector(trade), [...(groups.get(selector(trade)) ?? []), trade]);
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, rows]) => ({ key, metrics: summarizeTrades(rows) }));
}

export function summarizeTrades(trades: BacktestTrade[]): BacktestMetrics {
  if (!trades.length) return { trades: 0, wins: 0, winRate: null, averageR: null, expectancy: null, profitFactor: null, maxDrawdownR: null, sampleSufficient: false, sampleNote: "0 筆交易；樣本不足，不得宣稱有效。" };
  const wins = trades.filter((trade) => trade.realizedR > 0).length;
  const total = trades.reduce((sum, trade) => sum + trade.realizedR, 0);
  const gains = trades.reduce((sum, trade) => sum + Math.max(0, trade.realizedR), 0);
  const losses = Math.abs(trades.reduce((sum, trade) => sum + Math.min(0, trade.realizedR), 0));
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const trade of trades) {
    equity += trade.realizedR;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.min(maxDrawdown, equity - peak);
  }
  const sampleSufficient = trades.length >= 30;
  return {
    trades: trades.length, wins, winRate: wins / trades.length * 100, averageR: total / trades.length,
    expectancy: total / trades.length, profitFactor: losses > 0 ? gains / losses : null,
    maxDrawdownR: maxDrawdown, sampleSufficient,
    sampleNote: sampleSufficient ? "樣本達 30 筆基本門檻；仍需樣本外與 walk-forward 驗證。" : `${trades.length} 筆交易；少於 30 筆，樣本不足，不得宣稱有效。`,
  };
}

export function runBacktest(datasets: BacktestDataset[], costs: TradeCosts = DEFAULT_TRADE_COSTS): BacktestReport {
  const trades: BacktestTrade[] = [];
  for (const dataset of datasets) {
    for (const strategyName of STRATEGY_NAMES) {
      const timeframe = executionTimeframe[strategyName];
      const execution = dataset.candlesByTimeframe[timeframe];
      for (const threshold of [1.5, 2] as const) {
        let unavailableUntil = -1;
        const warmup = strategyName === "Bollinger Breakout" ? 105 : 60;
        for (let signalIndex = warmup; signalIndex < execution.length - 2; signalIndex += 1) {
          if (signalIndex <= unavailableUntil) continue;
          const decisionClose = execution[signalIndex].time + durationMs[timeframe];
          const closed = sliceClosed(dataset.candlesByTimeframe, decisionClose);
          const levels = buildSessionLevels(closed, new Date(decisionClose));
          const setup = evaluateStrategies({ symbol: dataset.symbol, candlesByTimeframe: closed, sessionLevels: levels, funding: null, oiChange1h: null, topRatios: [], globalRatios: [], costs, now: new Date(decisionClose).toISOString() }).find((item) => item.strategy === strategyName)!;
          const entryLow = setup.entryLow;
          const entryHigh = setup.entryHigh;
          const stop = setup.stop;
          const plannedNetRr = setup.primaryRiskReward;
          const ready = setup.status === "executable" && setup.direction !== "Neutral" && entryLow !== null && entryHigh !== null && stop !== null && plannedNetRr !== null;
          if (!ready || entryLow === null || entryHigh === null || stop === null || plannedNetRr === null || plannedNetRr < threshold) continue;
          const target = primaryTarget(setup);
          if (target === null) continue;
          const direction = setup.direction as "Long" | "Short";
          const entry = direction === "Long" ? entryHigh : entryLow;
          const fillIndex = findFill(execution, signalIndex, entry);
          if (fillIndex < 0) continue;
          const resolved = simulateExit(execution, fillIndex, direction, stop, target);
          const closedAtEntry = sliceClosed(dataset.candlesByTimeframe, execution[fillIndex].time);
          trades.push({
            symbol: dataset.symbol, strategy: strategyName, timeframe, session: currentSession(new Date(execution[fillIndex].time)).label,
            regime: marketRegime(closedAtEntry), threshold, signalAt: new Date(decisionClose).toISOString(),
            entryAt: new Date(execution[fillIndex].time).toISOString(), exitAt: new Date(execution[resolved.index].time).toISOString(),
            direction, entry, stop, target, exit: resolved.price, plannedNetRr,
            realizedR: realizedR(direction, entry, stop, resolved.price, setup.roundTripCostRate), outcome: resolved.outcome,
          });
          unavailableUntil = resolved.index;
        }
      }
    }
  }
  const comparisons = STRATEGY_NAMES.flatMap((strategy) => ([1.5, 2] as const).map((minimumNetRr) => {
    const rows = trades.filter((trade) => trade.strategy === strategy && trade.threshold === minimumNetRr);
    return {
      strategy, minimumNetRr, metrics: summarizeTrades(rows),
      breakdown: {
        bySymbol: groupMetrics(rows, (trade) => trade.symbol),
        byTimeframe: groupMetrics(rows, (trade) => trade.timeframe),
        bySession: groupMetrics(rows, (trade) => trade.session),
        byRegime: groupMetrics(rows, (trade) => trade.regime),
      },
    };
  }));
  return {
    generatedAt: new Date().toISOString(),
    assumptions: [
      "Signal bar and every higher-timeframe bar must be closed before evaluation; no look-ahead.",
      "Entry is eligible from the next bar only and must touch the worst entry-zone boundary within three bars.",
      "Round-trip fees and slippage are deducted; a bar touching stop and target is counted as stop-first.",
      "Targets are the strategy's observed structural/liquidity levels; no target is extended to manufacture R.",
      "Fewer than 30 trades in any slice is labelled insufficient and is not evidence of effectiveness.",
    ],
    comparisons,
    trades,
  };
}
