"use client";

import { WorkbenchLogo } from "./WorkbenchLogo";

type TopbarProps = {
  activeLabel: string;
  healthTone: "live" | "fallback" | "stale";
  healthLabel: string;
  assetCount: number;
  persistenceLabel: string;
  updatedAt: string;
  theme: "light" | "dark";
  refreshing: boolean;
  fallbackTesting: boolean;
  loadStage: string;
  loading: boolean;
  estimatedSeconds?: number | null;
  onToggleTheme: () => void;
  onRefresh: () => void;
  onToggleStatus?: () => void;
  statusOpen?: boolean;
};

export function Topbar({
  activeLabel,
  healthTone,
  healthLabel,
  assetCount,
  persistenceLabel,
  updatedAt,
  theme,
  refreshing,
  fallbackTesting,
  loadStage,
  loading,
  estimatedSeconds,
  onToggleTheme,
  onRefresh,
  onToggleStatus,
  statusOpen,
}: TopbarProps) {
  const busy = refreshing || fallbackTesting || loading;
  const stageHint =
    busy
      ? estimatedSeconds != null
        ? `載入中（約 ${estimatedSeconds} 秒）`
        : loadStage.includes("備援") || loadStage.includes("OKX")
          ? "備援中…"
          : "載入中…"
      : null;

  return (
    <header className="workbench-topbar">
      <div>
        <span className="mobile-brand">
          <WorkbenchLogo />
        </span>
        <p>{activeLabel}</p>
      </div>
      <div className="topbar-health">
        <button
          type="button"
          className={`status-badge ${healthTone} ${statusOpen ? "open" : ""}`}
          onClick={onToggleStatus}
          aria-expanded={statusOpen}
          title="點擊查看資料狀態詳情"
        >
          <i className="status-dot" aria-hidden="true" />
          <span>
            {stageHint ?? healthLabel}
            {assetCount > 0 ? ` · ${assetCount} 市` : ""}
          </span>
        </button>
        <span className="topbar-meta">{persistenceLabel}</span>
        <span className="topbar-meta">更新 {updatedAt}</span>
        <button
          className="theme-toggle"
          type="button"
          onClick={onToggleTheme}
          aria-pressed={theme === "dark"}
          aria-label={theme === "light" ? "切換夜間模式" : "切換日間模式"}
        >
          <i aria-hidden="true">{theme === "light" ? "☾" : "☀"}</i>
          <b>{theme === "light" ? "夜間" : "日間"}</b>
        </button>
        <button type="button" onClick={onRefresh} disabled={refreshing || fallbackTesting}>
          {refreshing ? "更新中…" : "更新行情 ↻"}
        </button>
      </div>
    </header>
  );
}
