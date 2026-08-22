import { getMarketHub } from "../../../lib/market/hub";

export const maxDuration = 60;

export async function GET(request: Request) {
  const startedAt = Date.now();
  const mode = new URL(request.url).searchParams.get("provider") === "okx" ? "force-okx" : "normal";
  console.log("[api/crypto] request started", { mode });
  try {
    const payload = await getMarketHub(mode === "force-okx");
    if (!payload.assets.length) throw new Error("Market Data Hub returned zero records");
    console.log("[api/crypto] request completed", { mode, durationMs: Date.now() - startedAt, assets: payload.assets.length, stage: payload.pipeline.stage });
    // Server-side cache 45s + SWR so repeated refreshes are fast
    return Response.json(payload, { headers: { "Cache-Control": "public, max-age=45, stale-while-revalidate=120" } });
  } catch (error) {
    console.error("[api/crypto] request failed", { mode, durationMs: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error) });
    return Response.json({ success: false, updatedAt: new Date().toISOString(), assets: [], error: error instanceof Error ? error.message : "Market Data Hub unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
