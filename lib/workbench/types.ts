import type { StrategyName, Timeframe } from "../market/types";

export type AlertType = "price_target" | "price_range" | "breakout" | "funding" | "oi_change" | "positioning_reversal" | "strategy_eligible" | "liquidity_sweep" | "risk_reward" | "provider_health";
export type AlertStatus = "watching" | "triggered" | "cooldown" | "missing" | "disabled";

export type AlertRule = {
  id: string;
  symbol: string;
  type: AlertType;
  timeframe: Timeframe;
  strategy: StrategyName | null;
  operator: "above" | "below" | "inside";
  threshold: number;
  thresholdUpper: number | null;
  referenceValue: number | null;
  enabled: boolean;
  cooldownMinutes: number;
  dedupeKey: string | null;
  lastEvaluatedAt: string | null;
  lastTriggeredAt: string | null;
  triggerCount: number;
  currentStatus: AlertStatus;
  lastReason: string;
  createdAt: string;
};

export type AlertEvent = {
  id: string;
  alertId: string;
  dedupeKey: string;
  symbol: string;
  reason: string;
  value: number | null;
  triggeredAt: string;
  channel: "in_app" | "browser" | "telegram";
  deliveryStatus: "delivered" | "pending" | "failed" | "not_configured";
};

export type JournalEntry = {
  id: string;
  symbol: string;
  side: "Long" | "Short";
  strategy: StrategyName;
  timeframe: Timeframe;
  reason: string;
  entry: number;
  stop: number;
  target: number;
  exit: number;
  quantity: number;
  fees: number;
  fundingCost: number;
  actualPnl: number;
  rMultiple: number;
  followed: boolean;
  mistake: string;
  notes: string;
  chartNote: string;
  tradeDate: string;
  entryTime: string;
  exitTime: string;
  createdAt: string;
};

export type WorkbenchSettings = {
  refreshSeconds: number;
  watchlist: string[];
  dailyLossLimit: number;
  defaultRiskPercent: number;
  defaultFeeRate: number;
};

export type UserDataPayload = {
  persistence: "d1" | "device";
  alerts: AlertRule[];
  alertEvents: AlertEvent[];
  journal: JournalEntry[];
  settings: WorkbenchSettings;
};

