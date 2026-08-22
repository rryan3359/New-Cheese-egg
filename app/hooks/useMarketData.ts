"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { markPayloadStale } from "../../lib/market/merge";
import type { MarketHubPayload } from "../../lib/market/types";
import { parseStored, storageKeys, writeStored } from "./storage";

export type LoadStage =
  | "讀取最近資料"
  | "Binance 連線中"
  | "使用 Binance 即時資料"
  | "Binance 缺值，補抓 OKX"
  | "OKX 備援啟用"
  | "顯示最後成功資料"
  | "所有來源不可用";

type UseMarketDataOptions = {
  evaluateCurrentAlerts: (snapshot: MarketHubPayload) => Promise<void>;
  refreshSeconds: number;
  hydrated: boolean;
};

export function useMarketData({ evaluateCurrentAlerts, refreshSeconds, hydrated }: UseMarketDataOptions) {
  const [data, setData] = useState<MarketHubPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [fallbackTesting, setFallbackTesting] = useState(false);
  const [loadStage, setLoadStage] = useState<LoadStage>("讀取最近資料");
  const [error, setError] = useState<string | null>(null);

  const normalRequestId = useRef(0);
  const forceRequestId = useRef(0);
  const dataRef = useRef<MarketHubPayload | null>(null);
  const normalAbortRef = useRef<AbortController | null>(null);
  const forceAbortRef = useRef<AbortController | null>(null);
  const refreshingRef = useRef(false);
  const fallbackTestingRef = useRef(false);

  useEffect(() => {
    dataRef.current = data;
  }, [data]);

  const refresh = useCallback(
    async (forceOkx = false) => {
      if (forceOkx ? fallbackTestingRef.current || refreshingRef.current : refreshingRef.current || fallbackTestingRef.current) return;
      const requestRef = forceOkx ? forceRequestId : normalRequestId;
      const abortRef = forceOkx ? forceAbortRef : normalAbortRef;
      const currentRequest = ++requestRef.current;
      const controller = new AbortController();
      abortRef.current = controller;
      const clientDeadlineMs = forceOkx ? 38_000 : 18_000;
      const clientDeadline = window.setTimeout(() => controller.abort(), clientDeadlineMs);
      if (forceOkx) {
        fallbackTestingRef.current = true;
        setFallbackTesting(true);
        setLoadStage("OKX 備援啟用");
      } else {
        refreshingRef.current = true;
        setRefreshing(true);
        setLoadStage("Binance 連線中");
      }
      setError(null);
      try {
        const response = await fetch(`/api/crypto${forceOkx ? "?provider=okx" : ""}`, { cache: "no-store", signal: controller.signal });
        const payload = (await response.json()) as MarketHubPayload & { error?: string };
        if (!response.ok || !payload.success || !payload.assets?.length) {
          throw new Error(payload.error ?? `Market Data Hub 回傳 ${response.status}`);
        }
        if (currentRequest !== requestRef.current) return;
        setData(payload);
        writeStored(storageKeys.data, payload);
        setLoadStage(
          payload.pipeline.stage === "using-binance"
            ? "使用 Binance 即時資料"
            : payload.pipeline.stage === "filling-from-okx"
              ? "Binance 缺值，補抓 OKX"
              : payload.pipeline.stage === "showing-stale"
                ? "顯示最後成功資料"
                : "OKX 備援啟用",
        );
        await evaluateCurrentAlerts(payload);
      } catch (reason) {
        if (currentRequest !== requestRef.current) return;
        const message =
          reason instanceof Error && reason.name === "AbortError"
            ? forceOkx
              ? "OKX 完整測試已在 38 秒停止；目前快照不受影響"
              : "行情更新已在 18 秒停止；正在保留最後成功資料"
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
          }
        }
      }
    },
    [evaluateCurrentAlerts],
  );

  const abortAllMarketRequests = useCallback(() => {
    normalAbortRef.current?.abort();
    forceAbortRef.current?.abort();
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
  };
}
