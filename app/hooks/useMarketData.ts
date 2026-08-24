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
  | "L3 圖表／策略 K 線載入中"
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

function hasUsableCandles(payload: MarketHubPayload): boolean {
  return payload.assets.some((asset) =>
    Object.values(asset.timeframes).some((tf) => tf.candles.length >= 30),
  );
}

export function useMarketData({ evaluateCurrentAlerts, refreshSeconds, hydrated }: UseMarketDataOptions) {
  const [data, setData] = useState<MarketHubPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [fallbackTesting, setFallbackTesting] = useState(false);
  const [loadStage, setLoadStage] = useState<LoadStage>("讀取最近資料");
  const [error, setError] = useState<string | null>(null);
  const [activeTier, setActiveTier] = useState<{ l1: boolean; l2: boolean; l3: boolean }>({
    l1: false,
    l2: false,
    l3: false,
  });

  const normalRequestId = useRef(0);
  const forceRequestId = useRef(0);
  const dataRef = useRef<MarketHubPayload | null>(null);
  const normalAbortRef = useRef<AbortController | null>(null);
  const forceAbortRef = useRef<AbortController | null>(null);
  const bgAbortRef = useRef<AbortController | null>(null);
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

  const fetchTier = useCallback(async (tier: FetchTier, signal: AbortSignal, forceOkx = false) => {
    const response = await fetch(`/api/crypto?tier=${tier}${forceOkx ? "&provider=okx" : ""}`, {
      cache: "no-store",
      signal,
    });
    const payload = (await response.json()) as MarketHubPayload & { error?: string };
    if (!response.ok || !payload.success || !payload.assets?.length) {
      throw new Error(payload.error ?? `Market Data Hub 回傳 ${response.status}`);
    }
    return payload;
  }, []);

  /**
   * Progressive refresh:
   * 1) L1 — priority price/funding → cockpit usable in 1–3s
   * 2) L2 — OI / positioning for all symbols
   * 3) L3 — short-depth candles → opportunity scanner + strategies (chart UI: TradingView)
   *
   * Force-OKX uses tier=l3 so charts/scanner still populate on pure OKX.
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

      const clientDeadlineMs = forceOkx ? 38_000 : 8_000;
      const clientDeadline = window.setTimeout(() => controller.abort(), clientDeadlineMs);

      if (forceOkx) {
        fallbackTestingRef.current = true;
        setFallbackTesting(true);
        setLoadStage("OKX 備援啟用");
      } else {
        refreshingRef.current = true;
        setRefreshing(true);
        setLoadStage("L1 關鍵行情載入中");
        setActiveTier({ l1: true, l2: false, l3: false });
      }
      setError(null);

      try {
        if (forceOkx) {
          // Full usable snapshot on OKX (includes short candles)
          const payload = await fetchTier("l3", controller.signal, true);
          if (currentRequest !== requestRef.current) return;
          await applyPayload(payload, "replace");
          return;
        }

        // --- L1 critical path ---
        const l1 = await fetchTier("l1", controller.signal, false);
        if (currentRequest !== requestRef.current) return;
        await applyPayload(l1, dataRef.current ? "progressive" : "replace");
        setLoading(false);
        setActiveTier({ l1: false, l2: true, l3: false });
        setLoadStage("L2 衍生品補齊中");

        // Background L2 + L3 share one controller so a new refresh cancels both
        bgAbortRef.current?.abort();
        const bgController = new AbortController();
        bgAbortRef.current = bgController;

        // --- L2 ---
        try {
          const l2Deadline = window.setTimeout(() => bgController.abort(), 14_000);
          try {
            const l2 = await fetchTier("l2", bgController.signal, false);
            if (currentRequest !== requestRef.current) return;
            await applyPayload(l2, "progressive");
          } finally {
            window.clearTimeout(l2Deadline);
          }
        } catch (l2Error) {
          if (currentRequest !== requestRef.current) return;
          if (!(l2Error instanceof Error && l2Error.name === "AbortError")) {
            setError(l2Error instanceof Error ? l2Error.message : "L2 衍生品補齊失敗");
          }
        }

        // --- L3: candles for scanner + chart (required until TradingView owns the chart) ---
        if (currentRequest !== requestRef.current) return;
        setActiveTier({ l1: false, l2: false, l3: true });
        setLoadStage("L3 圖表／策略 K 線載入中");
        try {
          const l3Controller = new AbortController();
          bgAbortRef.current = l3Controller;
          const l3Deadline = window.setTimeout(() => l3Controller.abort(), 22_000);
          try {
            const l3 = await fetchTier("l3", l3Controller.signal, false);
            if (currentRequest !== requestRef.current) return;
            await applyPayload(l3, "progressive");
            if (!hasUsableCandles(l3) && !hasUsableCandles(dataRef.current ?? l3)) {
              setError("K 線資料不足，機會掃描與圖表可能暫時空白");
            }
          } finally {
            window.clearTimeout(l3Deadline);
          }
        } catch (l3Error) {
          if (currentRequest !== requestRef.current) return;
          if (!(l3Error instanceof Error && l3Error.name === "AbortError")) {
            setError(l3Error instanceof Error ? l3Error.message : "L3 K 線載入失敗；價格／資金費仍可用");
          }
        } finally {
          if (bgAbortRef.current) bgAbortRef.current = null;
          setActiveTier({ l1: false, l2: false, l3: false });
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
            setActiveTier({ l1: false, l2: false, l3: false });
          }
        }
      }
    },
    [applyPayload, fetchTier],
  );

  const abortAllMarketRequests = useCallback(() => {
    normalAbortRef.current?.abort();
    forceAbortRef.current?.abort();
    bgAbortRef.current?.abort();
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
