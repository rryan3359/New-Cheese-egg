import type { AssetSnapshot } from "../market/types";

export function prioritizeByWatchlist<T extends { symbol: string }>(items: readonly T[], watchlist: readonly string[]) {
  const order = new Map(watchlist.map((symbol, index) => [symbol, index]));
  return [...items].sort((a, b) => {
    const aOrder = order.get(a.symbol);
    const bOrder = order.get(b.symbol);
    if (aOrder !== undefined && bOrder !== undefined) return aOrder - bOrder;
    if (aOrder !== undefined) return -1;
    if (bOrder !== undefined) return 1;
    return 0;
  });
}

export function cockpitAssets(assets: readonly AssetSnapshot[], watchlist: readonly string[]) {
  return prioritizeByWatchlist(assets, watchlist);
}

export function watchlistAssets<T extends { symbol: string }>(items: readonly T[], watchlist: readonly string[], onlyWatchlist: boolean) {
  if (!onlyWatchlist) return prioritizeByWatchlist(items, watchlist);
  const watched = new Set(watchlist);
  return prioritizeByWatchlist(items.filter((item) => watched.has(item.symbol)), watchlist);
}

