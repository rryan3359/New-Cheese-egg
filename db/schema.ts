import { integer, real, sqliteTable, text, uniqueIndex, index } from "drizzle-orm/sqlite-core";

export const alerts = sqliteTable(
  "alerts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    symbol: text("symbol").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull(),
    payload: text("payload", { mode: "json" }).notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("alerts_user_idx").on(table.userId),
    uniqueIndex("alerts_user_id_unique").on(table.userId, table.id),
  ],
);

export const alertEvents = sqliteTable(
  "alert_events",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    alertId: text("alert_id").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    symbol: text("symbol").notNull(),
    triggeredAt: text("triggered_at").notNull(),
    payload: text("payload", { mode: "json" }).notNull(),
  },
  (table) => [
    index("alert_events_user_time_idx").on(table.userId, table.triggeredAt),
    uniqueIndex("alert_events_user_dedupe_unique").on(table.userId, table.dedupeKey),
  ],
);

export const journalEntries = sqliteTable(
  "journal_entries",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    symbol: text("symbol").notNull(),
    strategy: text("strategy").notNull(),
    timeframe: text("timeframe").notNull(),
    actualPnl: real("actual_pnl").notNull(),
    rMultiple: real("r_multiple").notNull(),
    tradeDate: text("trade_date").notNull(),
    payload: text("payload", { mode: "json" }).notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("journal_user_date_idx").on(table.userId, table.tradeDate),
    uniqueIndex("journal_user_id_unique").on(table.userId, table.id),
  ],
);

export const userSettings = sqliteTable("user_settings", {
  userId: text("user_id").primaryKey(),
  payload: text("payload", { mode: "json" }).notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const watchlist = sqliteTable(
  "watchlist",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    symbol: text("symbol").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("watchlist_user_idx").on(table.userId),
    uniqueIndex("watchlist_user_symbol_unique").on(table.userId, table.symbol),
  ],
);
