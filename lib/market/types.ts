export const TIMEFRAMES = ["15m", "1h", "4h", "1d"] as const;
export type Timeframe = typeof TIMEFRAMES[number];
export type DataState = "live" | "fallback" | "stale" | "missing";
export type MetricSource = "Binance" | "OKX" | "Alternative.me" | "Calculated";

export type Metric<T> = {
  value: T | null;
  source: MetricSource;
  state: DataState;
  updatedAt: string;
  latencyMs: number | null;
  reason: string | null;
};

export type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

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

export type StrategyName =
  | "Trend Pullback"
  | "Breakout"
  | "Volatility Squeeze"
  | "Funding Mean Reversion"
  | "Positioning Divergence"
  | "ICT Liquidity Sweep"
  | "Range Mean Reversion";

export type StrategyStatus = "eligible" | "waiting" | "invalid" | "missing";

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
  riskReward: number | null;
  riskRewardTp1: number | null;
  riskRewardTp2: number | null;
  riskRewardTp3: number | null;
  primaryRiskReward: number | null;
  primaryTarget: "TP1" | "TP2" | "TP3" | null;
  entryBasis: "conservative-boundary" | null;
  trigger: string;
  invalidation: string;
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
  strategies: StrategyResult[];
  setup: StrategyResult | null;
};

export type ProviderHealth = {
  name: "Binance" | "OKX" | "Alternative.me";
  state: DataState;
  latencyMs: number | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  consecutiveFailures: number;
  circuitOpen: boolean;
  coverage: { ticker: number; funding: number; oi: number; positioning: number; candles: number };
  errors: string[];
};

export type MarketHubPayload = {
  success: boolean;
  updatedAt: string;
  cacheAgeMs: number;
  staleExpiresAt: string | null;
  assets: AssetSnapshot[];
  fearGreed: Metric<{ value: number; label: string }>;
  breadth: { advancing: number; declining: number; total: number };
  regime: string;
  riskAlerts: string[];
  health: ProviderHealth[];
  recentErrors: string[];
  pipeline: {
    stage: "using-binance" | "filling-from-okx" | "using-okx-fallback" | "showing-stale";
    mode: "normal" | "force-okx";
    marketApiDurationMs: number;
    binanceDurationMs: number | null;
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

