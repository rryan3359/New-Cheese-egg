"use client";

import type { AlertEvent } from "../../../lib/workbench/types";
import type { MarketHubPayload } from "../../../lib/market/types";
import type { LoadStage } from "../../hooks/useMarketData";

type DataBannersProps = {
  loadStage: LoadStage;
  healthTone: "live" | "fallback" | "stale";
  data: MarketHubPayload | null;
  error: string | null;
  persistence: "d1" | "device";
  persistenceReason: string;
  toasts: AlertEvent[];
  onDismissToast: (id: string) => void;
  onRefresh: () => void;
  onNavigate: (view: string) => void;
};

export function DataBanners({
  loadStage,
  healthTone,
  data,
  error,
  persistence,
  persistenceReason,
  toasts,
  onDismissToast,
  onRefresh,
  onNavigate,
}: DataBannersProps) {
  return (
    <>
      <section className={`load-stage ${healthTone}`} aria-live="polite">
        <i />
        <div>
          <b>{loadStage}</b>
          <span>
            {data
              ? `這份資料是 ${Math.round(data.cacheAgeMs / 1000)} 秒前更新 · 可用至 ${data.staleExpiresAt ? new Date(data.staleExpiresAt).toLocaleTimeString("zh-TW", { hour12: false }) : "—"}`
              : "正在取得第一份行情"}
          </span>
        </div>
        {data && <em>本次更新 {(data.pipeline.marketApiDurationMs / 1000).toFixed(1)} 秒</em>}
      </section>

      {toasts.length > 0 && (
        <div className="alert-toasts" aria-live="polite">
          {toasts.map((event) => (
            <button
              type="button"
              key={event.id}
              onClick={() => {
                onDismissToast(event.id);
                onNavigate("alerts");
              }}
            >
              <b>{event.symbol.replace("USDT", "")} 警報觸發</b>
              <span>{event.reason}</span>
            </button>
          ))}
        </div>
      )}

      {error && data && (
        <div className="data-banner warning-banner">
          <span>!</span>
          <p>
            <b>這次沒有更新成功</b>
            先保留上一份可用行情，你可以稍後再試。
          </p>
          <button type="button" onClick={onRefresh}>
            再試一次
          </button>
        </div>
      )}

      {!error && data?.health.some((provider) => provider.state !== "live") && (
        <div className="data-banner fallback-banner">
          <span>i</span>
          <p>
            <b>部分資料改用備援來源</b>
            價格仍可閱讀；暫缺的項目會清楚顯示「—」。
          </p>
          <button type="button" onClick={() => onNavigate("health")}>
            查看來源
          </button>
        </div>
      )}

      {persistence === "device" && (
        <div className="data-banner persistence-banner">
          <span>i</span>
          <p>
            <b>保存在這台裝置</b>
            {persistenceReason}
          </p>
          <button type="button" onClick={() => onNavigate("settings")}>
            查看設定
          </button>
        </div>
      )}
    </>
  );
}
