/**
 * 加密合約分倉試算 — 對齊產品共識公式
 *
 * 輸入：總資金、合約帳戶比例、分倉數、單筆止損%、當日止損%、獲利目標 RR
 * 輸出：合約帳戶資金、現貨/備用金、單筆保證金、單筆最大虧損、當日止損上限、單筆獲利目標
 */

export type AllocationInput = {
  /** 總資金 (USDT) */
  totalCapital: number;
  /** 合約帳戶比例 (%) */
  contractRatioPercent: number;
  /** 分倉數 */
  slots: number;
  /** 單筆止損 %（佔總資金） */
  perTradeStopPercent: number;
  /** 當日止損 %（佔總資金） */
  dailyStopPercent: number;
  /** 獲利目標 RR */
  rewardRisk: number;
};

export type AllocationResult = {
  valid: boolean;
  reason: string | null;
  /** 合約帳戶資金 = 總資金 × 合約比例 */
  contractCapital: number;
  /** 現貨/備用 = 總資金 − 合約帳戶資金 */
  spotReserve: number;
  /** 單筆最大虧損 = 總資金 × 單筆止損% */
  maxLossPerTrade: number;
  /** 當日止損上限 = 總資金 × 當日止損% */
  dailyLossLimit: number;
  /** 單筆保證金 = 合約帳戶資金 ÷ 分倉數 */
  marginPerSlot: number;
  /** 單筆獲利目標 = 單筆最大虧損 × RR */
  profitTargetPerTrade: number;
};

const invalid = (reason: string): AllocationResult => ({
  valid: false,
  reason,
  contractCapital: 0,
  spotReserve: 0,
  maxLossPerTrade: 0,
  dailyLossLimit: 0,
  marginPerSlot: 0,
  profitTargetPerTrade: 0,
});

export function calculateAllocation(input: AllocationInput): AllocationResult {
  const {
    totalCapital,
    contractRatioPercent,
    slots,
    perTradeStopPercent,
    dailyStopPercent,
    rewardRisk,
  } = input;

  if (
    ![totalCapital, contractRatioPercent, slots, perTradeStopPercent, dailyStopPercent, rewardRisk].every(
      Number.isFinite,
    )
  ) {
    return invalid("輸入必須是有限數字");
  }
  if (totalCapital <= 0) return invalid("總資金必須大於 0");
  if (contractRatioPercent <= 0 || contractRatioPercent > 100) return invalid("合約帳戶比例須介於 0–100%");
  if (slots < 1 || !Number.isInteger(slots)) return invalid("分倉數須為 ≥1 的整數");
  if (perTradeStopPercent <= 0 || perTradeStopPercent > 20) return invalid("單筆止損%須介於 0–20");
  if (dailyStopPercent <= 0 || dailyStopPercent > 50) return invalid("當日止損%須介於 0–50");
  if (rewardRisk <= 0) return invalid("獲利目標 RR 必須大於 0");

  const contractCapital = totalCapital * (contractRatioPercent / 100);
  const spotReserve = totalCapital - contractCapital;
  const maxLossPerTrade = totalCapital * (perTradeStopPercent / 100);
  const dailyLossLimit = totalCapital * (dailyStopPercent / 100);
  const marginPerSlot = contractCapital / slots;
  const profitTargetPerTrade = maxLossPerTrade * rewardRisk;

  return {
    valid: true,
    reason: null,
    contractCapital,
    spotReserve,
    maxLossPerTrade,
    dailyLossLimit,
    marginPerSlot,
    profitTargetPerTrade,
  };
}

/** @deprecated 舊版進場價/停損價/槓桿細算，僅保留型別相容；主流程已改為分倉試算 */
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

const invalidPlan = (reason: string): PositionPlan => ({
  valid: false,
  reason,
  maxLoss: 0,
  quantity: 0,
  notional: 0,
  margin: 0,
  stopDistance: 0,
  stopDistancePercent: 0,
  estimatedFees: 0,
  riskBeforeFees: 0,
  riskAfterFees: 0,
  targets: [],
  leverageWarning: null,
});

/** 舊版函數保留供測試相容，UI 不再使用 */
export function calculatePosition(input: PositionInput): PositionPlan {
  if (![input.balance, input.riskPercent, input.entry, input.stop, input.leverage, input.feeRate].every(Number.isFinite)) {
    return invalidPlan("輸入必須是有限數字");
  }
  if (input.balance <= 0 || input.entry <= 0 || input.stop <= 0 || input.leverage <= 0) {
    return invalidPlan("資金、價格與槓桿必須大於 0");
  }
  if (input.riskPercent <= 0 || input.riskPercent > 10) return invalidPlan("單筆風險必須介於 0% 與 10%");
  if (input.feeRate < 0 || input.feeRate > 0.02) return invalidPlan("手續費率超出合理範圍");
  if (input.side === "Long" && input.stop >= input.entry) return invalidPlan("Long 停損必須低於進場價");
  if (input.side === "Short" && input.stop <= input.entry) return invalidPlan("Short 停損必須高於進場價");
  const maxLoss = (input.balance * input.riskPercent) / 100;
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
  const stopDistancePercent = (stopDistance / input.entry) * 100;
  const leverageWarning =
    input.leverage >= 10 || liquidationBufferPercent < stopDistancePercent * 1.5
      ? `槓桿 ${input.leverage}× 的理論清算緩衝約 ${liquidationBufferPercent.toFixed(1)}%，請降低槓桿並以停損執行風險上限。`
      : null;
  return {
    valid: true,
    reason: null,
    maxLoss,
    quantity,
    notional,
    margin: notional / input.leverage,
    stopDistance,
    stopDistancePercent,
    estimatedFees,
    riskBeforeFees,
    riskAfterFees,
    targets,
    leverageWarning,
  };
}
