import { NextResponse } from "next/server";
import { evaluateAlerts } from "../../../../lib/alerts/engine";
import { validateAlertSnapshot } from "../../../../lib/market/snapshot";
import { authenticatedUserId } from "../../../../lib/persistence/auth";
import { loadUserData, saveAlertEvaluation } from "../../../../lib/persistence/user-data";

export async function POST(request: Request) {
  const userId = authenticatedUserId(request);
  if (!userId) return NextResponse.json({ error: "需要 ChatGPT Sites 使用者身分才能執行警報" }, { status: 401 });
  try {
    const body = await request.json().catch(() => null) as { snapshot?: unknown } | null;
    const market = validateAlertSnapshot(body?.snapshot);
    const userData = await loadUserData(userId);
    const evaluation = evaluateAlerts(userData.alerts, market);
    await saveAlertEvaluation(userId, evaluation.rules, evaluation.events);
    return NextResponse.json({ success: true, snapshotUpdatedAt: market.updatedAt, rules: evaluation.rules, events: evaluation.events, evaluatedAt: new Date().toISOString() });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "警報引擎暫時無法執行" }, { status: 400 });
  }
}

