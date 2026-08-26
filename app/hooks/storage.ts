import type { WorkbenchSettings } from "../../lib/workbench/types";

export const defaultSettings: WorkbenchSettings = {
  refreshSeconds: 60,
  watchlist: ["BTCUSDT", "ETHUSDT", "SOLUSDT"],
  dailyLossLimit: 300,
  defaultRiskPercent: 1,
  defaultFeeRate: 0.0005,
  defaultSlippageRate: 0.0003,
  minimumNetRr: 1.5,
};

export const storageKeys = {
  data: "ce-market-cache-v13",
  alerts: "ce-alerts-v3",
  alertEvents: "ce-alert-events-v3",
  journal: "ce-journal-v3",
  settings: "ce-settings-v3",
  sidebar: "ce-sidebar-collapsed-v1",
  theme: "ce-theme-v1",
} as const;

export function parseStored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function writeStored(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    void 0;
  }
}
