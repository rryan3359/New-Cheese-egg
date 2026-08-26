"use client";

import type { AlertEvent } from "../../../lib/workbench/types";
import type { MarketHubPayload } from "../../../lib/market/types";
import type { LoadStage } from "../../hooks/useMarketData";

type DataBannersProps = {
  loadStage: LoadStage;
  healthTone: "live" | "stale" | "missing";
  data: MarketHubPayload | null;
  error: string | null;
  persistence: "d1" | "device";
  persistenceReason: string;
  toasts: AlertEvent[];
  onDismissToast: (id: string) => void;
  onRefresh: () => void;
  onNavigate: (view: string) => void;
  hideStatusDetails?: boolean;
  onHideStatusDetails?: () => void;
  statusOpen?: boolean;
  onToggleStatus?: () => void;
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
  hideStatusDetails = false,
  onHideStatusDetails,
  statusOpen = false,
  onToggleStatus,
}: DataBannersProps) {
  const showDetails = statusOpen && !hideStatusDetails;

  return (
    <>
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

      {(error || data?.pipeline.stage === "showing-stale") && (
        <div className="data-banner warning-banner" aria-live="polite">
          <span>!</span>
          <p>
            <b>{data ? "行情服務暫時不可用，已保留最後成功資料" : "目前沒有可用行情，請稍後重試"}</b>
            {data
              ? `最後成功更新：${new Date(data.updatedAt).toLocaleString("zh-TW")} · 狀態：稍早資料。`
              : "設定、交易日誌、警報歷史、資料健康與離線風險試算仍可使用。"}
          </p>
          <button type="button" onClick={onRefresh}>
            重新嘗試
          </button>
        </div>
      )}

      {showDetails && (
        <section className={`status-detail-panel ${healthTone}`} aria-live="polite">
          <div className="status-detail-grid">
            <div>
              <b>載入狀態</b>
              <span>{loadStage}</span>
            </div>
            <div>
              <b>資料年齡</b>
              <span>
                {data
                  ? `${Math.round(data.cacheAgeMs / 1000)} 秒前 · 管線 ${(data.pipeline.marketApiDurationMs / 1000).toFixed(1)} 秒`
                  : "尚未取得第一份行情"}
              </span>
            </div>
            <div>
              <b>來源健康</b>
              <span>
                {data?.health.map((p) => `${p.name}:${p.state}`).join(" · ") ?? "—"}
              </span>
            </div>
            <div>
              <b>保存</b>
              <span>
                {persistence === "d1" ? "私人同步" : "僅此裝置"}
                {persistence === "device" ? ` · ${persistenceReason}` : ""}
              </span>
            </div>
          </div>
          <div className="status-detail-actions">
            <button type="button" onClick={() => onNavigate("health")}>
              查看來源
            </button>
            <button type="button" onClick={onRefresh}>
              更新行情
            </button>
            {onHideStatusDetails && (
              <button type="button" className="ghost" onClick={onHideStatusDetails}>
                不再顯示詳情
              </button>
            )}
            {onToggleStatus && (
              <button type="button" className="ghost" onClick={onToggleStatus}>
                收起
              </button>
            )}
          </div>
        </section>
      )}
    </>
  );
}
