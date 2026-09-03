"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { markPayloadStale, mergeSnapshotsProgressive } from "../../lib/market/merge";
import { normalizeStrategyResult, type FetchTier, type MarketHubPayload } from "../../lib/market/types";
import { parseStored, storageKeys, writeStored } from "./storage";

export type LoadStage =
  | "讀取最近資料"
  | "L1 關鍵行情載入中"
  | "使用 OKX 即時資料"
  | "L2／L3 進階資料補齊中"
  | "顯示最後成功資料"
  | "所有來源不可用";

type UseMarketDataOptions = {
  evaluateCurrentAlerts: (snapshot: MarketHubPayload) => Promise<void>;
  refreshSeconds: number;
  hydrated: boolean;
  feeRate: number;
  slippageRate: number;
};

const CLIENT_SNAPSHOT_TTL_MS = 24 * 60 * 60_000;
const TIER_DEADLINE_MS: Record<FetchTier, number> = {
  l1: 8_000,
  l2: 20_000,
  l3: 22_000,
};

function stageFromPipeline(payload: MarketHubPayload): LoadStage {
  return payload.pipeline.stage === "showing-stale" ? "顯示最後成功資料" : "使用 OKX 即時資料";
}

function isAbortError(reason: unknown) {
  return reason instanceof Error && reason.name === "AbortError";
}

function marketFailureMessage(hasSnapshot: boolean) {
  return hasSnapshot
    ? "行情服務暫時不可用，已保留最後成功資料"
    : "目前沒有可用行情，請稍後重試";
}

function normalizeCachedStrategies(payload: MarketHubPayload): MarketHubPayload {
  return {
    ...payload,
    assets: payload.assets.map((asset) => {
      const strategies = asset.strategies.map(normalizeStrategyResult);
      const missingMetric = {
        value: null,
        source: "Calculated" as const,
        state: "missing" as const,
        updatedAt: asset.price.updatedAt,
        latencyMs: null,
        reason: "舊版快取沒有此欄位；等待 L2 更新",
      };
      return {
        ...asset,
        topPositionRatio: asset.topPositionRatio ?? missingMetric,
        liquidations: asset.liquidations ?? missingMetric,
        strategies,
        setup: asset.setup ? normalizeStrategyResult(asset.setup) : null,
      };
    }),
  };
}

export function useMarketData({ evaluateCurrentAlerts, refreshSeconds, hydrated, feeRate, slippageRate }: UseMarketDataOptions) {
  const [data, setData] = useState<MarketHubPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadStage, setLoadStage] = useState<LoadStage>("讀取最近資料");
  const [error, setError] = useState<string | null>(null);
  const [activeTier, setActiveTier] = useState<{ l1: boolean; l2: boolean; l3: boolean }>({
    l1: false,
    l2: false,
    l3: false,
  });

  const requestIdRef = useRef(0);
  const dataRef = useRef<MarketHubPayload | null>(null);
  const l1AbortRef = useRef<AbortController | null>(null);
  const enrichmentAbortRef = useRef<Set<AbortController>>(new Set());
  const refreshingRef = useRef(false);
  const mountedRef = useRef(true);

  const applyPayload = useCallback(
    (payload: MarketHubPayload, mode: "replace" | "progressive") => {
      const next = mode === "progressive" ? mergeSnapshotsProgressive(dataRef.current, payload) : payload;
      dataRef.current = next;
      setData(next);
      writeStored(storageKeys.data, next);
      setLoadStage(stageFromPipeline(next));

      void evaluateCurrentAlerts(next).catch(() => undefined);
      return next;
    },
    [evaluateCurrentAlerts],
  );

  const fetchTier = useCallback(async (tier: FetchTier, signal: AbortSignal) => {
    const params = new URLSearchParams({ tier, feeRate: String(feeRate), slippageRate: String(slippageRate) });
    const response = await fetch(`/api/crypto?${params}`, {
      cache: "no-store",
      signal,
    });
    const payload = (await response.json().catch(() => null)) as MarketHubPayload | null;
    if (!response.ok || !payload?.success || !payload.assets?.length) {
      throw new Error("MARKET_UNAVAILABLE");
    }
    return payload;
  }, [feeRate, slippageRate]);

  const fetchTierWithDeadline = useCallback(
    async (tier: FetchTier, parentSignal?: AbortSignal) => {
      const controller = new AbortController();
      const abortFromParent = () => controller.abort();
      if (parentSignal?.aborted) controller.abort();
      else parentSignal?.addEventListener("abort", abortFromParent, { once: true });
      const timer = window.setTimeout(() => controller.abort(), TIER_DEADLINE_MS[tier]);
      try {
        return await fetchTier(tier, controller.signal);
      } finally {
        window.clearTimeout(timer);
        parentSignal?.removeEventListener("abort", abortFromParent);
      }
    },
    [fetchTier],
  );

  const markCurrentSnapshotStale = useCallback(() => {
    const current = dataRef.current;
    if (!current) return null;
    const storedAt = Date.parse(current.updatedAt);
    const stale = markPayloadStale(
      current,
      Number.isFinite(storedAt) ? storedAt : Date.now(),
      Date.now(),
      CLIENT_SNAPSHOT_TTL_MS,
    );
    if (!stale) return current;
    dataRef.current = stale;
    setData(stale);
    writeStored(storageKeys.data, stale);
    return stale;
  }, []);

  const refresh = useCallback(async () => {
    if (refreshingRef.current) return;

    const currentRequest = ++requestIdRef.current;
    const l1Controller = new AbortController();
    l1AbortRef.current = l1Controller;
    refreshingRef.current = true;
    setRefreshing(true);
    setLoading(!dataRef.current);
    setError(null);
    setLoadStage("L1 關鍵行情載入中");
    setActiveTier({ l1: true, l2: false, l3: false });

    try {
      const l1 = await fetchTierWithDeadline("l1", l1Controller.signal);
      if (!mountedRef.current || currentRequest !== requestIdRef.current) return;

      applyPayload(l1, dataRef.current ? "progressive" : "replace");
      setLoading(false);
      setLoadStage("L2／L3 進階資料補齊中");
      setActiveTier({ l1: false, l2: true, l3: true });

      const enrich = async (tier: "l2" | "l3") => {
        const controller = new AbortController();
        enrichmentAbortRef.current.add(controller);
        try {
          const payload = await fetchTierWithDeadline(tier, controller.signal);
          if (!mountedRef.current || currentRequest !== requestIdRef.current) return;
          applyPayload(payload, "progressive");
        } finally {
          enrichmentAbortRef.current.delete(controller);
        }
      };

      const results = await Promise.allSettled([enrich("l2"), enrich("l3")]);
      if (!mountedRef.current || currentRequest !== requestIdRef.current) return;

      const failed = results.some((result) => result.status === "rejected" && !isAbortError(result.reason));
      if (failed) {
        setError("部分進階行情暫時不可用；已保留其他可用資料");
      } else if (dataRef.current) {
        setLoadStage(stageFromPipeline(dataRef.current));
      }
    } catch {
      if (!mountedRef.current || currentRequest !== requestIdRef.current) return;
      const snapshot = markCurrentSnapshotStale();
      setError(marketFailureMessage(Boolean(snapshot)));
      setLoadStage(snapshot ? "顯示最後成功資料" : "所有來源不可用");
    } finally {
      if (mountedRef.current && currentRequest === requestIdRef.current) {
        l1AbortRef.current = null;
        refreshingRef.current = false;
        setRefreshing(false);
        setLoading(false);
        setActiveTier({ l1: false, l2: false, l3: false });
      }
    }
  }, [applyPayload, fetchTierWithDeadline, markCurrentSnapshotStale]);

  const abortAllMarketRequests = useCallback(() => {
    requestIdRef.current += 1;
    l1AbortRef.current?.abort();
    l1AbortRef.current = null;
    enrichmentAbortRef.current.forEach((controller) => controller.abort());
    enrichmentAbortRef.current.clear();
    refreshingRef.current = false;
    if (mountedRef.current) {
      setRefreshing(false);
      setLoading(false);
      setActiveTier({ l1: false, l2: false, l3: false });
    }
  }, []);

  const hydrateFromCache = useCallback(() => {
    const stored = parseStored<MarketHubPayload | null>(storageKeys.data, null);
    const cached = stored ? normalizeCachedStrategies(stored) : null;
    const cachedStoredAt = cached ? Date.parse(cached.updatedAt) : 0;
    const stale = cached?.assets?.length
      ? markPayloadStale(
          cached,
          Number.isFinite(cachedStoredAt) ? cachedStoredAt : Date.now(),
          Date.now(),
          CLIENT_SNAPSHOT_TTL_MS,
        )
      : null;
    if (!stale) return;
    dataRef.current = stale;
    setData(stale);
    setLoadStage("顯示最後成功資料");
    setLoading(false);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const enrichmentControllers = enrichmentAbortRef.current;
    return () => {
      mountedRef.current = false;
      requestIdRef.current += 1;
      l1AbortRef.current?.abort();
      enrichmentControllers.forEach((controller) => controller.abort());
      enrichmentControllers.clear();
    };
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible" && !refreshingRef.current) void refresh();
    }, Math.max(30, refreshSeconds) * 1000);
    return () => window.clearInterval(interval);
  }, [hydrated, refresh, refreshSeconds]);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        abortAllMarketRequests();
        return;
      }
      if (!refreshingRef.current) void refresh();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [abortAllMarketRequests, refresh]);

  useEffect(() => {
    const onOnline = () => {
      if (document.visibilityState === "visible" && !refreshingRef.current) void refresh();
    };
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [refresh]);

  return {
    data,
    loading,
    refreshing,
    loadStage,
    error,
    refresh,
    abortAllMarketRequests,
    hydrateFromCache,
    dataRef,
    activeTier,
  };
}
