import type { JournalEntry } from "../workbench/types";

type Breakdown = { label: string; trades: number; winRate: number | null; totalPnl: number; averageR: number | null };

function breakdown(entries: JournalEntry[], key: (entry: JournalEntry) => string): Breakdown[] {
  const groups = new Map<string, JournalEntry[]>();
  for (const entry of entries) groups.set(key(entry), [...(groups.get(key(entry)) ?? []), entry]);
  return Array.from(groups, ([label, group]) => ({ label, trades: group.length, winRate: group.length ? group.filter((entry) => entry.actualPnl > 0).length / group.length * 100 : null, totalPnl: group.reduce((sum, entry) => sum + entry.actualPnl, 0), averageR: group.length ? group.reduce((sum, entry) => sum + entry.rMultiple, 0) / group.length : null }));
}

export function calculateJournalAnalytics(entries: JournalEntry[]) {
  if (!entries.length) return { trades: 0, winRate: null, averageR: null, profitFactor: null, maxLosingStreak: 0, maxDrawdown: null, totalPnl: 0, byStrategy: [] as Breakdown[], bySide: [] as Breakdown[], byTimeframe: [] as Breakdown[], byDiscipline: [] as Breakdown[] };
  const chronological = [...entries].sort((a, b) => new Date(a.exitTime || a.createdAt).getTime() - new Date(b.exitTime || b.createdAt).getTime());
  const wins = chronological.filter((entry) => entry.actualPnl > 0);
  const losses = chronological.filter((entry) => entry.actualPnl < 0);
  const grossProfit = wins.reduce((sum, entry) => sum + entry.actualPnl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, entry) => sum + entry.actualPnl, 0));
  let losingStreak = 0;
  let maxLosingStreak = 0;
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const entry of chronological) {
    losingStreak = entry.actualPnl < 0 ? losingStreak + 1 : 0;
    maxLosingStreak = Math.max(maxLosingStreak, losingStreak);
    equity += entry.actualPnl;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.min(maxDrawdown, equity - peak);
  }
  return {
    trades: chronological.length,
    winRate: wins.length / chronological.length * 100,
    averageR: chronological.reduce((sum, entry) => sum + entry.rMultiple, 0) / chronological.length,
    profitFactor: grossLoss ? grossProfit / grossLoss : null,
    maxLosingStreak,
    maxDrawdown,
    totalPnl: chronological.reduce((sum, entry) => sum + entry.actualPnl, 0),
    byStrategy: breakdown(chronological, (entry) => entry.strategy),
    bySide: breakdown(chronological, (entry) => entry.side),
    byTimeframe: breakdown(chronological, (entry) => entry.timeframe),
    byDiscipline: breakdown(chronological, (entry) => entry.followed ? "遵守策略" : "未遵守策略"),
  };
}

