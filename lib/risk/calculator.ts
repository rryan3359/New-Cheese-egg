export type PositionInput = {
  balance: number;
  riskPercent: number;
  entry: number;
  stop: number;
  leverage: number;
  side: "Long" | "Short";
  feeRate: number;
};

export type PositionPlan = {
  valid: boolean;
  reason: string | null;
  maxLoss: number;
  quantity: number;
  notional: number;
  margin: number;
  stopDistance: number;
  stopDistancePercent: number;
  estimatedFees: number;
  riskBeforeFees: number;
  riskAfterFees: number;
  targets: Array<{ multiple: 1 | 2 | 3; price: number; grossPnl: number; netPnl: number }>;
  leverageWarning: string | null;
};

const invalidPlan = (reason: string): PositionPlan => ({ valid: false, reason, maxLoss: 0, quantity: 0, notional: 0, margin: 0, stopDistance: 0, stopDistancePercent: 0, estimatedFees: 0, riskBeforeFees: 0, riskAfterFees: 0, targets: [], leverageWarning: null });

export function calculatePosition(input: PositionInput): PositionPlan {
  if (![input.balance, input.riskPercent, input.entry, input.stop, input.leverage, input.feeRate].every(Number.isFinite)) return invalidPlan("輸入必須是有限數字");
  if (input.balance <= 0 || input.entry <= 0 || input.stop <= 0 || input.leverage <= 0) return invalidPlan("資金、價格與槓桿必須大於 0");
  if (input.riskPercent <= 0 || input.riskPercent > 10) return invalidPlan("單筆風險必須介於 0% 與 10%");
  if (input.feeRate < 0 || input.feeRate > .02) return invalidPlan("手續費率超出合理範圍");
  if (input.side === "Long" && input.stop >= input.entry) return invalidPlan("Long 停損必須低於進場價");
  if (input.side === "Short" && input.stop <= input.entry) return invalidPlan("Short 停損必須高於進場價");
  const maxLoss = input.balance * input.riskPercent / 100;
  const stopDistance = Math.abs(input.entry - input.stop);
  const feePerUnit = input.entry * input.feeRate * 2;
  const quantity = maxLoss / (stopDistance + feePerUnit);
  const notional = quantity * input.entry;
  const estimatedFees = notional * input.feeRate * 2;
  const riskBeforeFees = quantity * stopDistance;
  const riskAfterFees = riskBeforeFees + estimatedFees;
  const sign = input.side === "Long" ? 1 : -1;
  const targets = ([1, 2, 3] as const).map((multiple) => {
    const price = input.entry + sign * stopDistance * multiple;
    const grossPnl = quantity * stopDistance * multiple;
    return { multiple, price, grossPnl, netPnl: grossPnl - estimatedFees };
  });
  const liquidationBufferPercent = 100 / input.leverage;
  const stopDistancePercent = stopDistance / input.entry * 100;
  const leverageWarning = input.leverage >= 10 || liquidationBufferPercent < stopDistancePercent * 1.5
    ? `槓桿 ${input.leverage}× 的理論清算緩衝約 ${liquidationBufferPercent.toFixed(1)}%，請降低槓桿並以停損執行風險上限。`
    : null;
  return { valid: true, reason: null, maxLoss, quantity, notional, margin: notional / input.leverage, stopDistance, stopDistancePercent, estimatedFees, riskBeforeFees, riskAfterFees, targets, leverageWarning };
}

