"use client";

import type { MarketHubPayload } from "../../../lib/market/types";
import { formatPercent, formatPrice } from "../MarketViews";

type PriceTickerProps = {
  data: MarketHubPayload | null;
  loading: boolean;
  error: string | null;
  onSelect?: (symbol: string) => void;
};

export function PriceTicker({ data, loading, error, onSelect }: PriceTickerProps) {
  if (!data?.assets.length) {
    return (
      <div className="price-ticker empty" aria-live="polite">
        <span className="ticker-item muted">{loading ? "行情載入中…" : error ? "行情暫時不可用" : "目前沒有可用行情"}</span>
      </div>
    );
  }

  const items = [...data.assets, ...data.assets];

  return (
    <div className={`price-ticker${data.pipeline.stage === "showing-stale" ? " stale" : ""}`} role="marquee" aria-label={data.pipeline.stage === "showing-stale" ? "過期價格跑馬燈" : "即時價格跑馬燈"}>
      {data.pipeline.stage === "showing-stale" && <span className="ticker-stale-label">過期資料 · {new Date(data.updatedAt).toLocaleTimeString("zh-TW", { hour12: false })}</span>}
      <div className="ticker-track">
        {items.map((asset, index) => {
          const change = asset.change24h.value;
          const tone = change === null ? "muted" : change >= 0 ? "positive" : "negative";
          return (
            <button
              type="button"
              className={`ticker-item ${tone}`}
              key={`${asset.symbol}-${index}`}
              onClick={() => onSelect?.(asset.symbol)}
            >
              <b>{asset.symbol.replace("USDT", "")}</b>
              <span>{formatPrice(asset.price.value)}</span>
              <em>{formatPercent(change, 2)}</em>
            </button>
          );
        })}
      </div>
    </div>
  );
}
