import { getMarketHub } from "../../../lib/market/hub";
import type { FetchTier } from "../../../lib/market/types";

export const maxDuration = 60;

function parseTier(raw: string | null): FetchTier {
  if (raw === "l1" || raw === "l2" || raw === "l3") return raw;
  return "l2";
}

export async function GET(request: Request) {
  const startedAt = Date.now();
  const url = new URL(request.url);
  // Compatibility alias for old bookmarked URLs. The hub is always OKX-only.
  const compatibilityAlias = url.searchParams.get("provider") === "okx";
  const tier = parseTier(url.searchParams.get("tier"));
  console.log("[api/crypto] request started", { compatibilityAlias, tier });
  try {
    const payload = await getMarketHub(undefined, tier);
    if (!payload.assets.length) throw new Error("Market Data Hub returned zero records");
    console.log("[api/crypto] request completed", {
      compatibilityAlias,
      tier,
      durationMs: Date.now() - startedAt,
      assets: payload.assets.length,
      stage: payload.pipeline.stage,
      okxMs: payload.pipeline.okxDurationMs,
    });
    // L1 can be shorter-lived; L2/L3 keep previous 45s + SWR
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
