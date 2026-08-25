import { resolveActiveStrategy, type AssetSnapshot, type MarketHubPayload, type StrategyResult } from "../market/types";
import type { AlertEvent, AlertRule, AlertStatus } from "../workbench/types";

export type AlertEvaluation = {
  rule: AlertRule;
  event: AlertEvent | null;
  observedValue: number | null;
};

type Observation = {
  available: boolean;
  matched: boolean;
  value: number | null;
  reason: string;
  snapshotKey: string;
};

function compare(value: number, rule: AlertRule) {
  if (rule.operator === "above") return value >= rule.threshold;
  if (rule.operator === "below") return value <= rule.threshold;
  const upper = rule.thresholdUpper ?? rule.threshold;
  return value >= Math.min(rule.threshold, upper) && value <= Math.max(rule.threshold, upper);
}

function selectedStrategy(asset: AssetSnapshot, rule: AlertRule): StrategyResult | null {
  const active = resolveActiveStrategy(rule.strategy);
  if (rule.strategy && !active) return null;
  return asset.strategies.find((strategy) => active ? strategy.strategy === active : strategy.timeframe === rule.timeframe) ?? null;
}

function missing(reason: string): Observation {
  return { available: false, matched: false, value: null, reason, snapshotKey: "missing" };
}

function observe(rule: AlertRule, data: MarketHubPayload): Observation {
  if (rule.type === "provider_health") {
    const unhealthy = data.health.filter((provider) => provider.state !== "live");
    const reason = unhealthy.length
      ? `資料健康異常：${unhealthy.map((provider) => `${provider.name} ${provider.state}`).join("、")}`
      : "所有資料供應商目前正常";
    return { available: true, matched: unhealthy.length > 0, value: unhealthy.length, reason, snapshotKey: `${data.updatedAt}:${unhealthy.map((provider) => `${provider.name}-${provider.state}`).join("|")}` };
  }

  const asset = data.assets.find((item) => item.symbol === rule.symbol);
  if (!asset) return missing(`${rule.symbol} 不在目前市場資料中`);
  const timeframe = asset.timeframes[rule.timeframe];
  const lastCandle = timeframe?.candles.at(-1);
  const candleKey = lastCandle ? String(lastCandle.time) : data.updatedAt;
  const strategy = selectedStrategy(asset, rule);

  switch (rule.type) {
    case "price_target": {
      if (asset.price.value === null) return missing("價格資料缺失");
      const matched = compare(asset.price.value, rule);
      return { available: true, matched, value: asset.price.value, reason: `${asset.symbol} 價格 ${asset.price.value} ${matched ? "已" : "尚未"}${rule.operator === "above" ? "高於" : rule.operator === "below" ? "低於" : "進入"}門檻`, snapshotKey: `${asset.price.updatedAt}:${candleKey}` };
    }
    case "price_range": {
      if (asset.price.value === null || rule.thresholdUpper === null) return missing("價格或區間上限缺失");
      const low = Math.min(rule.threshold, rule.thresholdUpper);
      const high = Math.max(rule.threshold, rule.thresholdUpper);
      return { available: true, matched: asset.price.value >= low && asset.price.value <= high, value: asset.price.value, reason: `${asset.symbol} 現價 ${asset.price.value} ${asset.price.value >= low && asset.price.value <= high ? "進入" : "尚未進入"} ${low}–${high}`, snapshotKey: `${asset.price.updatedAt}:${candleKey}` };
    }
    case "funding": {
      if (asset.funding.value === null) return missing("Funding 資料缺失");
      const fundingPercent = asset.funding.value * 100;
      return { available: true, matched: compare(fundingPercent, rule), value: fundingPercent, reason: `${asset.symbol} Funding ${fundingPercent.toFixed(4)}%`, snapshotKey: asset.funding.updatedAt };
    }
    case "oi_change": {
      if (asset.oiChange1h.value === null) return missing("OI 1H 變化資料缺失");
      return { available: true, matched: compare(asset.oiChange1h.value, rule), value: asset.oiChange1h.value, reason: `${asset.symbol} OI 1H ${asset.oiChange1h.value.toFixed(2)}%`, snapshotKey: asset.oiChange1h.updatedAt };
    }
    case "positioning_reversal": {
      if (asset.positioning.value === null) return missing("Positioning score 資料缺失");
      const reference = rule.referenceValue;
      const reversed = reference !== null && Math.sign(reference) !== Math.sign(asset.positioning.value) && Math.abs(asset.positioning.value) >= Math.abs(rule.threshold);
      return { available: reference !== null, matched: reversed, value: asset.positioning.value, reason: reference === null ? "需要先記錄 Positioning 參考值" : `${asset.symbol} Positioning ${reference.toFixed(1)} → ${asset.positioning.value.toFixed(1)}`, snapshotKey: asset.positioning.updatedAt };
    }
    case "strategy_eligible": {
      if (!strategy) return missing(rule.strategy && !resolveActiveStrategy(rule.strategy) ? "此舊策略已標為 legacy，不再產生新方向或觸發" : "找不到指定策略或週期");
      return { available: strategy.status !== "missing", matched: strategy.status === "eligible" && strategy.eligibleForScanner, value: strategy.confidence, reason: `${strategy.strategy} ${strategy.timeframe} 為 ${strategy.status}，淨 RR ${strategy.primaryRiskReward?.toFixed(2) ?? "N/A"}R`, snapshotKey: `${strategy.updatedAt}:${candleKey}:${strategy.status}` };
    }
    case "liquidity_sweep": {
      const sweep = asset.events.find((event) => event.kind === "liquidity_sweep");
      if (!sweep) return { available: true, matched: false, value: null, reason: "尚未偵測到已收盤 K 線的流動性掃蕩", snapshotKey: candleKey };
      return { available: true, matched: true, value: asset.price.value, reason: sweep.headline, snapshotKey: `${sweep.id}:${sweep.occurredAt}` };
    }
    case "risk_reward": {
      if (!strategy || strategy.primaryRiskReward === null) return missing("策略風報比尚不可計算");
      return { available: true, matched: compare(strategy.primaryRiskReward, rule), value: strategy.primaryRiskReward, reason: `${strategy.strategy} ${strategy.timeframe} ${strategy.primaryTarget ?? "主要目標"} 淨 RR ${strategy.primaryRiskReward.toFixed(2)}R`, snapshotKey: `${strategy.updatedAt}:${candleKey}:${strategy.status}` };
    }
    case "breakout": {
      if (!timeframe || !lastCandle) return missing(`${rule.timeframe} K 線資料缺失`);
      const upper = timeframe.rollingHigh.value;
      const lower = timeframe.rollingLow.value;
      if (upper === null || lower === null) return missing("滾動高低點資料不足");
      const matched = rule.operator === "below" ? lastCandle.close <= lower : lastCandle.close >= upper;
      return { available: true, matched, value: lastCandle.close, reason: `${asset.symbol} ${rule.timeframe} 收盤 ${lastCandle.close}，區間 ${lower}–${upper}`, snapshotKey: candleKey };
    }
  }
}

export function evaluateAlert(rule: AlertRule, data: MarketHubPayload, now = new Date()): AlertEvaluation {
  const evaluatedAt = now.toISOString();
  if (!rule.enabled) return { rule: { ...rule, currentStatus: "disabled", lastEvaluatedAt: evaluatedAt }, event: null, observedValue: null };

  const observation = observe(rule, data);
  if (!observation.available) {
    return { rule: { ...rule, currentStatus: "missing", lastEvaluatedAt: evaluatedAt, lastReason: observation.reason }, event: null, observedValue: observation.value };
  }
  if (!observation.matched) {
    return { rule: { ...rule, currentStatus: "watching", lastEvaluatedAt: evaluatedAt, lastReason: observation.reason }, event: null, observedValue: observation.value };
  }

  const dedupeKey = `${rule.id}:${observation.snapshotKey}`;
  const lastTriggered = rule.lastTriggeredAt ? new Date(rule.lastTriggeredAt).getTime() : 0;
  const cooldownMs = Math.max(0, rule.cooldownMinutes) * 60_000;
  const withinCooldown = lastTriggered > 0 && now.getTime() - lastTriggered < cooldownMs;
  const duplicate = rule.dedupeKey === dedupeKey;
  if (duplicate || withinCooldown) {
    const status: AlertStatus = "cooldown";
    return { rule: { ...rule, currentStatus: status, lastEvaluatedAt: evaluatedAt, lastReason: duplicate ? `${observation.reason}；同一資料快照已通知` : `${observation.reason}；冷卻中` }, event: null, observedValue: observation.value };
  }

  const event: AlertEvent = {
    id: crypto.randomUUID(),
    alertId: rule.id,
    dedupeKey,
    symbol: rule.symbol,
    reason: observation.reason,
    value: observation.value,
    triggeredAt: evaluatedAt,
    channel: "in_app",
    deliveryStatus: "delivered",
  };
  return {
    rule: { ...rule, dedupeKey, lastEvaluatedAt: evaluatedAt, lastTriggeredAt: evaluatedAt, triggerCount: rule.triggerCount + 1, currentStatus: "triggered", lastReason: observation.reason },
    event,
    observedValue: observation.value,
  };
}

export function evaluateAlerts(rules: AlertRule[], data: MarketHubPayload, now = new Date()) {
  const results = rules.map((rule) => evaluateAlert(rule, data, now));
  return { rules: results.map((result) => result.rule), events: results.flatMap((result) => result.event ? [result.event] : []) };
}

