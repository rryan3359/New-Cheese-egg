"use client";

import { useEffect, useId, useRef } from "react";
import type { Timeframe } from "../../lib/market/types";

/** Map workbench timeframes to TradingView interval strings. */
const TV_INTERVAL: Record<Timeframe, string> = {
  "15m": "15",
  "1h": "60",
  "4h": "240",
  "1d": "D",
};

/**
 * Prefer Binance perpetual-style symbol for TV.
 * Workbench symbols are like BTCUSDT; TV Advanced Chart expects e.g. BINANCE:BTCUSDT.
 * Exchange may differ from strategy data source — UI does not claim they are identical.
 */
function toTvSymbol(symbol: string): string {
  const clean = symbol.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  return `BINANCE:${clean}`;
}

type TradingViewWidgetProps = {
  symbol: string;
  timeframe: Timeframe;
  theme?: "light" | "dark";
  /** Optional height in px; mobile should stay moderate to avoid fighting bottom nav. */
  height?: number;
};

declare global {
  interface Window {
    TradingView?: {
      widget: new (options: Record<string, unknown>) => { remove?: () => void };
    };
  }
}

let tvScriptPromise: Promise<void> | null = null;

function loadTradingViewScript(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (window.TradingView) return Promise.resolve();
  if (tvScriptPromise) return tvScriptPromise;
  tvScriptPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-tv-widget="1"]');
    if (existing) {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error("TradingView script failed")));
      if (window.TradingView) resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = "https://s3.tradingview.com/tv.js";
    script.async = true;
    script.dataset.tvWidget = "1";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("TradingView script failed"));
    document.head.appendChild(script);
  });
  return tvScriptPromise;
}

/**
 * Thin TradingView Advanced Chart embed.
 * - No custom datafeed / Charting Library.
 * - No auto-drawn entry/stop/TP lines (user copies numbers from the plan card).
 * - symbol + interval driven by parent (setup / toolbar).
 */
export default function TradingViewWidget({
  symbol,
  timeframe,
  theme = "dark",
  height = 560,
}: TradingViewWidgetProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetRef = useRef<{ remove?: () => void } | null>(null);
  const reactId = useId().replace(/:/g, "");
  const containerId = `tv_chart_${reactId}`;

  useEffect(() => {
    let cancelled = false;
    const container = containerRef.current;
    if (!container) return;

    const mount = async () => {
      try {
        await loadTradingViewScript();
      } catch {
        if (!cancelled && container) {
          container.innerHTML =
            '<div class="tv-fallback">無法載入 TradingView。請確認網路，或稍後再試。</div>';
        }
        return;
      }
      if (cancelled || !container || !window.TradingView) return;

      // Clear previous widget DOM
      container.innerHTML = "";
      const host = document.createElement("div");
      host.id = containerId;
      host.style.height = "100%";
      host.style.width = "100%";
      container.appendChild(host);

      try {
        widgetRef.current = new window.TradingView.widget({
          container_id: containerId,
          symbol: toTvSymbol(symbol),
          interval: TV_INTERVAL[timeframe] ?? "60",
          timezone: "exchange",
          theme: theme === "light" ? "light" : "dark",
          style: "1",
          locale: "zh_TW",
          toolbar_bg: theme === "light" ? "#f4f5f0" : "#0c100c",
          enable_publishing: false,
          hide_top_toolbar: false,
          hide_legend: false,
          save_image: false,
          withdateranges: true,
          allow_symbol_change: true,
          details: false,
          hotlist: false,
          calendar: false,
          studies: [],
          show_popup_button: false,
          width: "100%",
          height,
        });
      } catch {
        if (!cancelled) {
          container.innerHTML =
            '<div class="tv-fallback">TradingView 初始化失敗。數字仍以左側／上方計畫卡為準。</div>';
        }
      }
    };

    void mount();

    return () => {
      cancelled = true;
      try {
        widgetRef.current?.remove?.();
      } catch {
        /* ignore */
      }
      widgetRef.current = null;
      if (container) container.innerHTML = "";
    };
  }, [symbol, timeframe, theme, height, containerId]);

  return (
    <div className="tv-widget-shell">
      <div
        className="tv-widget-container"
        ref={containerRef}
        style={{ height, width: "100%", minHeight: height }}
        data-symbol={symbol}
        data-timeframe={timeframe}
      />
      <p className="tv-source-note">
        圖表來源：TradingView（{toTvSymbol(symbol)} · {timeframe}）。策略數字來自 Market Data Hub；兩者可能非同一交易所，以計畫卡為準。
      </p>
    </div>
  );
}

export { toTvSymbol, TV_INTERVAL };
