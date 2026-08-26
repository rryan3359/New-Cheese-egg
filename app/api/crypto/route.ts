import { getMarketHub } from "../../../lib/market/hub";
import type { FetchTier } from "../../../lib/market/types";

export const maxDuration = 60;

function parseTier(raw: string | null): FetchTier {
  if (raw === "l1" || raw === "l2" || raw === "l3") return raw;
  return "l2";
}

function parseRate(raw: string | null, fallback: number) {
  const value = raw === null ? fallback : Number(raw);
  return Number.isFinite(value) ? Math.max(0, Math.min(0.02, value)) : fallback;
}

export async function GET(request: Request) {
  const startedAt = Date.now();
  const url = new URL(request.url);
  const compatibilityAlias = url.searchParams.get("provider") === "okx";
  const tier = parseTier(url.searchParams.get("tier"));
  const costs = {
    feeRate: parseRate(url.searchParams.get("feeRate"), 0.0005),
    slippageRate: parseRate(url.searchParams.get("slippageRate"), 0.0003),
  };
  console.log("[api/crypto] request started", { compatibilityAlias, tier });
  try {
    const payload = await getMarketHub(undefined, tier, costs);
    if (!payload.assets.length) throw new Error("Market Data Hub returned zero records");
    console.log("[api/crypto] request completed", {
      compatibilityAlias,
      tier,
      durationMs: Date.now() - startedAt,
      assets: payload.assets.length,
      stage: payload.pipeline.stage,
      okxMs: payload.pipeline.okxDurationMs,
    });
    const maxAge = tier === "l1" ? 20 : 45;
    const swr = tier === "l1" ? 60 : 120;
    return Response.json(payload, {
      headers: {
        "Cache-Control": `public, max-age=${maxAge}, stale-while-revalidate=${swr}`,
        ...(compatibilityAlias ? { "X-Cheese-Egg-Provider-Alias": "okx-compat" } : {}),
      },
    });
  } catch (error) {
    console.error("[api/crypto] request failed", {
      compatibilityAlias,
      tier,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      {
        success: false,
        updatedAt: new Date().toISOString(),
        assets: [],
        error: "目前沒有可用行情，請稍後重試",
        code: "MARKET_UNAVAILABLE",
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
