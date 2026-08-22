"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { markPayloadStale, mergeSnapshotsProgressive } from "../../lib/market/merge";
import type { FetchTier, MarketHubPayload } from "../../lib/market/types";
import { parseStored, storageKeys, writeStored } from "./storage";

export type LoadStage =
  | "讀取最近資料"
  | "L1 關鍵行情載入中"
  | "使用 Binance 即時資料"
  | "Binance 缺值，補抓 OKX"
  | "L2 衍生品補齊中"
  | "OKX 備援啟用"
  | "顯示最後成功資料"
  | "所有來源不可用";

type UseMarketDataOptions = {
  evaluateCurrentAlerts: (snapshot: MarketHubPayload) => Promise<void>;
  refreshSeconds: number;
  hydrated: boolean;
};

function stageFromPipeline(payload: MarketHubPayload): LoadStage {
  if (payload.pipeline.stage === "using-binance") return "使用 Binance 即時資料";
  if (payload.pipeline.stage === "filling-from-okx") return "Binance 缺值，補抓 OKX";
  if (payload.pipeline.stage === "showing-stale") return "顯示最後成功資料";
  return "OKX 備援啟用";
}

export function useMarketData({ evaluateCurrentAlerts, refreshSeconds, hydrated }: UseMarketDataOptions) {
  const [data, setData] = useState<MarketHubPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [fallbackTesting, setFallbackTesting] = useState(false);
  const [loadStage, setLoadStage] = useState<LoadStage>("讀取最近資料");
  const [error, setError] = useState<string | null>(null);
  const [activeTier, setActiveTier] = useState<{ l1: boolean; l2: boolean }>({ l1: false, l2: false });

  const normalRequestId = useRef(0);
  const forceRequestId = useRef(0);
  const dataRef = useRef<MarketHubPayload | null>(null);
  const normalAbortRef = useRef<AbortController | null>(null);
  const forceAbortRef = useRef<AbortController | null>(null);
  const l2AbortRef = useRef<AbortController | null>(null);
  const refreshingRef = useRef(false);
  const fallbackTestingRef = useRef(false);

  useEffect(() => {
    dataRef.current = data;
  }, [data]);

  const applyPayload = useCallback(
    async (payload: MarketHubPayload, mode: "replace" | "progressive") => {
      setData((prev) => {
        const next = mode === "progressive" ? mergeSnapshotsProgressive(prev, payload) : payload;
        writeStored(storageKeys.data, next);
        return next;
      });
      setLoadStage(stageFromPipeline(payload));
      await evaluateCurrentAlerts(payload);
    },
    [evaluateCurrentAlerts],
  );

  const fetchTier = useCallback(
    async (tier: FetchTier, signal: AbortSignal, forceOkx = false) => {
      const response = await fetch(`/api/crypto?tier=${tier}${forceOkx ? "&provider=okx" : ""}`, {
        cache: "no-store",
        signal,
      });
      const payload = (await response.json()) as MarketHubPayload & { error?: string };
      if (!response.ok || !payload.success || !payload.assets?.length) {
        throw new Error(payload.error ?? `Market Data Hub 回傳 ${response.status}`);
      }
      return payload;
    },
    [],
  );

  /**
   * Progressive refresh:
   * 1) L1 (priority ticker+funding+fear) → cockpit usable
   * 2) L2 in background (OI/positioning, full symbol set)
   * Force-OKX still uses a single longer path (tier=l2).
   */
  const refresh = useCallback(
    async (forceOkx = false) => {
      if (forceOkx ? fallbackTestingRef.current || refreshingRef.current : refreshingRef.current || fallbackTestingRef.current) {
        return;
      }
      const requestRef = forceOkx ? forceRequestId : normalRequestId;
      const abortRef = forceOkx ? forceAbortRef : normalAbortRef;
      const currentRequest = ++requestRef.current;
      const controller = new AbortController();
      abortRef.current = controller;

      // Client deadlines aligned with server tier deadlines + network slack
      const clientDeadlineMs = forceOkx ? 32_000 : 16_000;
      const clientDeadline = window.setTimeout(() => controller.abort(), clientDeadlineMs);

      if (forceOkx) {
        fallbackTestingRef.current = true;
        setFallbackTesting(true);
        setLoadStage("OKX 備援啟用");
      } else {
        refreshingRef.current = true;
        setRefreshing(true);
        setLoadStage("L1 關鍵行情載入中");
        setActiveTier((s) => ({ ...s, l1: true }));
      }
      setError(null);

      try {
        if (forceOkx) {
          const payload = await fetchTier("l2", controller.signal, true);
          if (currentRequest !== requestRef.current) return;
          await applyPayload(payload, "replace");
          return;
        }

        // --- L1 critical path ---
        const l1 = await fetchTier("l1", controller.signal, false);
        if (currentRequest !== requestRef.current) return;
        await applyPayload(l1, dataRef.current ? "progressive" : "replace");
        setLoading(false);
        setActiveTier((s) => ({ ...s, l1: false, l2: true }));
        setLoadStage("L2 衍生品補齊中");

        // --- L2 background (own abort so L1 success isn't cancelled) ---
        l2AbortRef.current?.abort();
        const l2Controller = new AbortController();
        l2AbortRef.current = l2Controller;
        const l2Deadline = window.setTimeout(() => l2Controller.abort(), 14_000);
        try {
          const l2 = await fetchTier("l2", l2Controller.signal, false);
          if (currentRequest !== requestRef.current) return;
          await applyPayload(l2, "progressive");
        } catch (l2Error) {
          // L2 failure must not wipe L1; surface soft error only
          if (currentRequest !== requestRef.current) return;
          if (!(l2Error instanceof Error && l2Error.name === "AbortError")) {
            setError(l2Error instanceof Error ? l2Error.message : "L2 衍生品補齊失敗");
          }
        } finally {
          window.clearTimeout(l2Deadline);
          if (l2AbortRef.current === l2Controller) l2AbortRef.current = null;
          setActiveTier((s) => ({ ...s, l2: false }));
        }
      } catch (reason) {
        if (currentRequest !== requestRef.current) return;
        const message =
          reason instanceof Error && reason.name === "AbortError"
            ? forceOkx
              ? "OKX 完整測試已在時限內停止；目前快照不受影響"
              : "行情更新已在時限內停止；正在保留最後成功資料"
            : reason instanceof Error
              ? reason.message
              : "市場資料暫時無法更新";
        setError(message);
        setLoadStage(dataRef.current ? "顯示最後成功資料" : "所有來源不可用");
      } finally {
        window.clearTimeout(clientDeadline);
        if (currentRequest === requestRef.current) {
          abortRef.current = null;
          setLoading(false);
          if (forceOkx) {
            fallbackTestingRef.current = false;
            setFallbackTesting(false);
          } else {
            refreshingRef.current = false;
            setRefreshing(false);
            setActiveTier({ l1: false, l2: false });
          }
        }
      }
    },
    [applyPayload, fetchTier],
  );

  const abortAllMarketRequests = useCallback(() => {
    normalAbortRef.current?.abort();
    forceAbortRef.current?.abort();
    l2AbortRef.current?.abort();
  }, []);

  const hydrateFromCache = useCallback(() => {
    const cached = parseStored<MarketHubPayload | null>(storageKeys.data, null);
    const cachedStoredAt = cached ? new Date(cached.updatedAt).getTime() : 0;
    const stale = cached?.assets?.length ? markPayloadStale(cached, cachedStoredAt, Date.now()) : null;
    if (stale) {
      setData(stale);
      setLoadStage("顯示最後成功資料");
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible" && !refreshingRef.current && !fallbackTestingRef.current) {
        void refresh();
      }
    }, Math.max(30, refreshSeconds) * 1000);
    return () => window.clearInterval(interval);
  }, [hydrated, refresh, refreshSeconds]);

  useEffect(() => {
    const onOnline = () => {
      if (document.visibilityState === "visible" && !refreshingRef.current && !fallbackTestingRef.current) {
        void refresh();
      }
    };
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [refresh]);

  return {
    data,
    setData,
    loading,
    refreshing,
    fallbackTesting,
    loadStage,
    error,
    refresh,
    abortAllMarketRequests,
    hydrateFromCache,
    dataRef,
    activeTier,
  };
}
