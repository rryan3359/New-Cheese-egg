export const TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h", "1d"] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];
export type DataState = "live" | "stale" | "missing";
export type MetricSource = "OKX" | "Alternative.me" | "Calculated";
export type FetchTier = "l1" | "l2" | "l3";

export type Metric<T> = {
  value: T | null;
  source: MetricSource;
  state: DataState;
  updatedAt: string;
  latencyMs: number | null;
  reason: string | null;
};

export type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };
export type CandleMap = Record<Timeframe, Candle[]>;

export type RawAsset = {
  symbol: string;
  base: string;
  price: number | null;
  change24h: number | null;
  quoteVolume: number | null;
  quoteVolumeUnit: "USDT" | "BASE" | "CONTRACTS" | null;
  quoteVolumeMethod: string;
  funding: number | null;
  openInterest: number | null;
  oiChange1h: number | null;
  topRatios: number[];
  globalRatios: number[];
  candlesByTimeframe: CandleMap;
  latencyMs: number;
  errors: string[];
};

export type StrategyName = "EMA Trend" | "Bollinger Breakout" | "ICT / SMC";
export const STRATEGY_NAMES: StrategyName[] = ["EMA Trend", "Bollinger Breakout", "ICT / SMC"];
export type LegacyStrategyName = "Trend Pullback" | "Breakout" | "Volatility Squeeze" | "Funding Mean Reversion" | "Positioning Divergence" | "ICT Liquidity Sweep" | "Range Mean Reversion";
export type StrategyReference = StrategyName | LegacyStrategyName;
export const LEGACY_STRATEGY_MAP: Record<LegacyStrategyName, StrategyName | null> = {
  "Trend Pullback": "EMA Trend",
  Breakout: "Bollinger Breakout",
  "Volatility Squeeze": "Bollinger Breakout",
  "Funding Mean Reversion": null,
  "Positioning Divergence": null,
  "ICT Liquidity Sweep": "ICT / SMC",
  "Range Mean Reversion": null,
};

export function resolveActiveStrategy(value: StrategyReference | null): StrategyName | null {
  if (value === null) return null;
  if ((STRATEGY_NAMES as string[]).includes(value)) return value as StrategyName;
  return LEGACY_STRATEGY_MAP[value as LegacyStrategyName] ?? null;
}

export type StrategyStatus = "eligible" | "waiting" | "applicable" | "invalid" | "missing";
export type TradeCosts = { feeRate: number; slippageRate: number };
export const DEFAULT_TRADE_COSTS: TradeCosts = { feeRate: 0.0005, slippageRate: 0.0003 };

export type StrategyResult = {
  id: string;
  symbol: string;
  timeframe: Timeframe;
  strategy: StrategyName;
  direction: "Long" | "Short" | "Neutral";
  status: StrategyStatus;
  confidence: number;
  entryLow: number | null;
  entryHigh: number | null;
  stop: number | null;
  tp1: number | null;
  tp2: number | null;
  tp3: number | null;
  /** Backward-compatible alias; always the primary net RR in v13. */
  riskReward: number | null;
  riskRewardTp1: number | null;
  riskRewardTp2: number | null;
  riskRewardTp3: number | null;
  primaryRiskReward: number | null;
  grossRiskRewardTp1: number | null;
  grossRiskRewardTp2: number | null;
  grossRiskRewardTp3: number | null;
  primaryTarget: "TP1" | "TP2" | "TP3" | null;
  entryBasis: "conservative-boundary" | null;
  feeRate: number;
  slippageRate: number;
  roundTripCostRate: number;
  eligibleForScanner: boolean;
  trigger: string;
  invalidation: string;
  targetBasis: string;
  reasons: string[];
  missingConditions: string[];
  requiredData: string[];
  source: string;
  updatedAt: string;
  conditionsMet: number;
  conditionsTotal: number;
};

export type TimeframeSnapshot = {
  timeframe: Timeframe;
  candles: Candle[];
  change: Metric<number>;
  ema20: Metric<number>;
  ema50: Metric<number>;
  rsi: Metric<number>;
  atr: Metric<number>;
  adx: Metric<number>;
  bollingerUpper: Metric<number>;
  bollingerMiddle: Metric<number>;
  bollingerLower: Metric<number>;
  bollingerWidth: Metric<number>;
  volumeMean: Metric<number>;
  volumeZScore: Metric<number>;
  rollingHigh: Metric<number>;
  rollingLow: Metric<number>;
  swingHigh: Metric<number>;
  swingLow: Metric<number>;
  trend: Metric<"Trend Up" | "Trend Down" | "Range">;
  volatility: Metric<"High" | "Normal" | "Low">;
};

export type SessionLevel = {
  id: string;
  label: string;
  kind: "PDH" | "PDL" | "PWH" | "PWL" | "ASIA_HIGH" | "ASIA_LOW" | "LONDON_HIGH" | "LONDON_LOW" | "NEW_YORK_HIGH" | "NEW_YORK_LOW" | "EQH" | "EQL" | "SWING_HIGH" | "SWING_LOW";
  price: number;
  startedAt: string;
  endedAt: string;
  sourceTimeframe: Timeframe;
};

export type MarketEvent = {
  id: string;
  symbol: string;
  kind: "liquidity_sweep" | "mss" | "bos" | "bb_expansion" | "funding_anomaly" | "oi_anomaly";
  direction: "Long" | "Short" | "Neutral";
  headline: string;
  detail: string;
  occurredAt: string;
  source: "OKX" | "Calculated";
  confidence: "high" | "medium" | "low";
};

export type SessionContext = {
  name: "Asia" | "London" | "New York AM" | "New York Midday" | "New York PM" | "Off-session";
  label: string;
  timezone: string;
  localTime: string;
  opensAt: string | null;
  closesAt: string | null;
};

export type AssetSnapshot = {
  symbol: string;
  name: string;
  price: Metric<number>;
  change15m: Metric<number>;
  change1h: Metric<number>;
  change4h: Metric<number>;
  change24h: Metric<number>;
  quoteVolume: Metric<number>;
  quoteVolumeUnit: "USDT" | "BASE" | "CONTRACTS" | null;
  quoteVolumeMethod: string;
  openInterest: Metric<number>;
  oiChange1h: Metric<number>;
  funding: Metric<number>;
  globalRatio: Metric<number>;
  topRatio: Metric<number>;
  positioning: Metric<number>;
  timeframes: Record<Timeframe, TimeframeSnapshot>;
  sessionLevels: SessionLevel[];
  events: MarketEvent[];
  strategies: StrategyResult[];
  setup: StrategyResult | null;
};

export type ProviderHealth = {
  name: "OKX" | "Alternative.me";
  state: DataState;
  latencyMs: number | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  consecutiveFailures: number;
  circuitOpen: boolean;
  coverage: { ticker: number; funding: number; oi: number; positioning: number; candles: number };
  errors: string[];
};

export type PipelineStage = "using-okx" | "showing-stale";
export type MarketHubPayload = {
  success: boolean;
  updatedAt: string;
  cacheAgeMs: number;
  staleExpiresAt: string | null;
  assets: AssetSnapshot[];
  fearGreed: Metric<{ value: number; label: string }>;
  breadth: { advancing: number; declining: number; total: number };
  regime: "Trend Up" | "Trend Down" | "Compression" | "Liquidity Sweep" | "High Volatility" | "No Trade" | "N/A";
  session: SessionContext;
  recentEvents: MarketEvent[];
  riskAlerts: string[];
  health: ProviderHealth[];
  recentErrors: string[];
  pipeline: {
    stage: PipelineStage;
    mode: "normal";
    tier: FetchTier;
    marketApiDurationMs: number;
    binanceDurationMs: null;
    okxDurationMs: number | null;
    okxFetchedFields: string[];
  };
};

export type ProviderPayload = { assets: RawAsset[]; health: ProviderHealth };
export type OkxFetchPlan = {
  full: boolean;
  symbols: string[];
  tickerSymbols: string[];
  fundingSymbols: string[];
  openInterestSymbols: string[];
  candleTimeframes: Partial<Record<string, Timeframe[]>>;
};

export const CANDLE_LIMITS: Record<Timeframe, number> = {
  "1m": 240,
  "5m": 240,
  "15m": 240,
  "1h": 240,
  "4h": 160,
  "1d": 120,
};

export function emptyCandleMap(): CandleMap {
  return { "1m": [], "5m": [], "15m": [], "1h": [], "4h": [], "1d": [] };
}
