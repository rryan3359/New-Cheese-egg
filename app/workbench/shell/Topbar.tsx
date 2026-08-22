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
  onToggleTheme: () => void;
  onRefresh: () => void;
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
  onToggleTheme,
  onRefresh,
}: TopbarProps) {
  return (
    <header className="workbench-topbar">
      <div>
        <span className="mobile-brand">
          <WorkbenchLogo />
        </span>
        <p>{activeLabel}</p>
      </div>
      <div className="topbar-health">
        <span className={`health-indicator ${healthTone}`}>● {healthLabel}</span>
        <span>{assetCount} 個市場</span>
        <span>{persistenceLabel}</span>
        <span>更新 {updatedAt}</span>
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
