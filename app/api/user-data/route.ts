import { NextResponse } from "next/server";
import { z } from "zod";
import { authenticatedUserId } from "../../../lib/persistence/auth";
import { deleteUserEntity, loadUserData, saveAlert, saveAlertEvaluation, saveAlertEvent, saveJournalEntry, saveSettings } from "../../../lib/persistence/user-data";
import type { AlertEvent, AlertRule, JournalEntry, WorkbenchSettings } from "../../../lib/workbench/types";

const timeframeSchema = z.enum(["15m", "1h", "4h", "1d"]);
const strategySchema = z.enum(["Trend Pullback", "Breakout", "Volatility Squeeze", "Funding Mean Reversion", "Positioning Divergence", "ICT Liquidity Sweep", "Range Mean Reversion"]);
const alertSchema = z.object({ id: z.string().min(1).max(100), symbol: z.string().regex(/^[A-Z0-9]{2,20}$/), type: z.enum(["price_target", "price_range", "breakout", "funding", "oi_change", "positioning_reversal", "strategy_eligible", "liquidity_sweep", "risk_reward", "provider_health"]), timeframe: timeframeSchema, strategy: strategySchema.nullable(), operator: z.enum(["above", "below", "inside"]), threshold: z.number().finite(), thresholdUpper: z.number().finite().nullable(), referenceValue: z.number().finite().nullable(), enabled: z.boolean(), cooldownMinutes: z.number().min(0).max(43_200), dedupeKey: z.string().max(500).nullable(), lastEvaluatedAt: z.string().nullable(), lastTriggeredAt: z.string().nullable(), triggerCount: z.number().int().min(0), currentStatus: z.enum(["watching", "triggered", "cooldown", "missing", "disabled"]), lastReason: z.string().max(1_000), createdAt: z.string() }).strict();
const eventSchema = z.object({ id: z.string().min(1).max(100), alertId: z.string().min(1).max(100), dedupeKey: z.string().min(1).max(500), symbol: z.string().regex(/^[A-Z0-9]{2,20}$/), reason: z.string().max(1_000), value: z.number().finite().nullable(), triggeredAt: z.string(), channel: z.enum(["in_app", "browser", "telegram"]), deliveryStatus: z.enum(["delivered", "pending", "failed", "not_configured"]) }).strict();
const journalSchema = z.object({ id: z.string().min(1).max(100), symbol: z.string().regex(/^[A-Z0-9]{2,20}$/), side: z.enum(["Long", "Short"]), strategy: strategySchema, timeframe: timeframeSchema, reason: z.string().max(5_000), entry: z.number().positive(), stop: z.number().positive(), target: z.number().nonnegative(), exit: z.number().positive(), quantity: z.number().positive(), fees: z.number().nonnegative(), fundingCost: z.number().finite(), actualPnl: z.number().finite(), rMultiple: z.number().finite(), followed: z.boolean(), mistake: z.string().max(200), notes: z.string().max(10_000), chartNote: z.string().max(2_000), tradeDate: z.string(), entryTime: z.string(), exitTime: z.string(), createdAt: z.string() }).strict();
const settingsSchema = z.object({ refreshSeconds: z.number().int().min(30).max(3_600), watchlist: z.array(z.string().regex(/^[A-Z0-9]{2,20}$/)).max(50), dailyLossLimit: z.number().nonnegative().max(100_000_000), defaultRiskPercent: z.number().positive().max(10), defaultFeeRate: z.number().nonnegative().max(.02) }).strict();
const mutationSchema = z.discriminatedUnion("entity", [
  z.object({ entity: z.literal("alert"), record: alertSchema }),
  z.object({ entity: z.literal("alert_event"), record: eventSchema }),
  z.object({ entity: z.literal("journal"), record: journalSchema }),
  z.object({ entity: z.literal("settings"), record: settingsSchema }),
  z.object({ entity: z.literal("alert_evaluation"), rules: z.array(alertSchema).max(100), events: z.array(eventSchema).max(100) }),
]);
const deletionSchema = z.object({ entity: z.enum(["alert", "journal"]), id: z.string().min(1) });

function unauthorized() {
  return NextResponse.json({ error: "需要 ChatGPT Sites 使用者身分才能同步資料" }, { status: 401 });
}

/** Vercel / 無 Sites 身分時：明確回傳 device 模式，前端降級本機，不假裝雲端同步。 */
function deviceOnlyPayload() {
  return NextResponse.json({
    persistence: "device",
    alerts: [],
    alertEvents: [],
    journal: [],
    settings: {
      refreshSeconds: 60,
      watchlist: ["BTCUSDT", "ETHUSDT", "SOLUSDT"],
      dailyLossLimit: 300,
      defaultRiskPercent: 1,
      defaultFeeRate: 0.0005,
    },
    error: "目前環境沒有 Sites 使用者身分或 D1，設定與紀錄只保存在此裝置",
  }, { status: 200 });
}

export async function GET(request: Request) {
  const userId = authenticatedUserId(request);
  if (!userId) return deviceOnlyPayload();
  try {
    return NextResponse.json(await loadUserData(userId));
  } catch {
    // D1 不可用（例如 Vercel）：降級，不要用 503 嚇前端
    return deviceOnlyPayload();
  }
}

export async function POST(request: Request) {
  const userId = authenticatedUserId(request);
  if (!userId) return unauthorized();
  const parsed = mutationSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "無效的保存內容" }, { status: 400 });
  try {
    if (parsed.data.entity === "alert") await saveAlert(userId, parsed.data.record as AlertRule);
    if (parsed.data.entity === "alert_event") await saveAlertEvent(userId, parsed.data.record as AlertEvent);
    if (parsed.data.entity === "journal") await saveJournalEntry(userId, parsed.data.record as JournalEntry);
    if (parsed.data.entity === "settings") await saveSettings(userId, parsed.data.record as WorkbenchSettings);
    if (parsed.data.entity === "alert_evaluation") await saveAlertEvaluation(userId, parsed.data.rules as AlertRule[], parsed.data.events as AlertEvent[]);
    return NextResponse.json({ success: true, persistence: "d1" });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "D1 暫時無法保存" }, { status: 503 });
  }
}

export async function DELETE(request: Request) {
  const userId = authenticatedUserId(request);
  if (!userId) return unauthorized();
  const parsed = deletionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "無效的刪除內容" }, { status: 400 });
  try {
    await deleteUserEntity(userId, parsed.data.entity, parsed.data.id);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "D1 暫時無法刪除" }, { status: 503 });
  }
}
