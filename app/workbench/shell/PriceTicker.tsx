"use client";

import type { MarketHubPayload } from "../../../lib/market/types";
import { formatPercent, formatPrice } from "../MarketViews";

type PriceTickerProps = {
  data: MarketHubPayload | null;
  onSelect?: (symbol: string) => void;
};

export function PriceTicker({ data, onSelect }: PriceTickerProps) {
  if (!data?.assets.length) {
    return (
      <div className="price-ticker empty" aria-live="polite">
        <span className="ticker-item muted">行情載入中…</span>
      </div>
    );
  }

  // Duplicate list for seamless marquee
  const items = [...data.assets, ...data.assets];

  return (
    <div className="price-ticker" role="marquee" aria-label="即時價格跑馬燈">
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
