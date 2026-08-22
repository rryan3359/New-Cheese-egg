import { and, desc, eq } from "drizzle-orm";
import { env } from "cloudflare:workers";
import { getDb } from "../../db";
import { alertEvents, alerts, journalEntries, userSettings, watchlist } from "../../db/schema";
import type { AlertEvent, AlertRule, JournalEntry, UserDataPayload, WorkbenchSettings } from "../workbench/types";

export const DEFAULT_SETTINGS: WorkbenchSettings = {
  refreshSeconds: 60,
  watchlist: ["BTCUSDT", "ETHUSDT", "SOLUSDT"],
  dailyLossLimit: 300,
  defaultRiskPercent: 1,
  defaultFeeRate: 0.0005,
};

let schemaReady: Promise<void> | null = null;

export const LOCAL_SCHEMA_STATEMENTS = [
  "CREATE TABLE IF NOT EXISTS alerts (id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL, symbol TEXT NOT NULL, enabled INTEGER NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS alerts_user_idx ON alerts (user_id)",
  "CREATE UNIQUE INDEX IF NOT EXISTS alerts_user_id_unique ON alerts (user_id, id)",
  "CREATE TABLE IF NOT EXISTS alert_events (id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL, alert_id TEXT NOT NULL, dedupe_key TEXT NOT NULL, symbol TEXT NOT NULL, triggered_at TEXT NOT NULL, payload TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS alert_events_user_time_idx ON alert_events (user_id, triggered_at)",
  "CREATE UNIQUE INDEX IF NOT EXISTS alert_events_user_dedupe_unique ON alert_events (user_id, dedupe_key)",
  "CREATE TABLE IF NOT EXISTS journal_entries (id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL, symbol TEXT NOT NULL, strategy TEXT NOT NULL, timeframe TEXT NOT NULL, actual_pnl REAL NOT NULL, r_multiple REAL NOT NULL, trade_date TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS journal_user_date_idx ON journal_entries (user_id, trade_date)",
  "CREATE UNIQUE INDEX IF NOT EXISTS journal_user_id_unique ON journal_entries (user_id, id)",
  "CREATE TABLE IF NOT EXISTS user_settings (user_id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS watchlist (id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL, symbol TEXT NOT NULL, created_at TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS watchlist_user_idx ON watchlist (user_id)",
  "CREATE UNIQUE INDEX IF NOT EXISTS watchlist_user_symbol_unique ON watchlist (user_id, symbol)",
] as const;

export function ensureUserDataSchema() {
  if (process.env.NODE_ENV !== "development") return Promise.resolve();
  if (schemaReady) return schemaReady;
  const database = env.DB;
  if (!database) throw new Error("D1 binding DB is unavailable");
  schemaReady = database.batch(LOCAL_SCHEMA_STATEMENTS.map((statement) => database.prepare(statement))).then(() => undefined).catch((error: unknown) => {
    schemaReady = null;
    throw error;
  });
  return schemaReady;
}

function recordPayload<T>(payload: unknown): T {
  if (typeof payload === "string") return JSON.parse(payload) as T;
  return payload as T;
}

export async function loadUserData(userId: string): Promise<UserDataPayload> {
  await ensureUserDataSchema();
  const db = getDb();
  const [alertRows, eventRows, journalRows, settingsRows, watchRows] = await Promise.all([
    db.select({ payload: alerts.payload }).from(alerts).where(eq(alerts.userId, userId)),
    db.select({ payload: alertEvents.payload }).from(alertEvents).where(eq(alertEvents.userId, userId)).orderBy(desc(alertEvents.triggeredAt)).limit(100),
    db.select({ payload: journalEntries.payload }).from(journalEntries).where(eq(journalEntries.userId, userId)).orderBy(desc(journalEntries.createdAt)),
    db.select({ payload: userSettings.payload }).from(userSettings).where(eq(userSettings.userId, userId)).limit(1),
    db.select({ symbol: watchlist.symbol }).from(watchlist).where(eq(watchlist.userId, userId)),
  ]);
  const savedSettings = settingsRows[0] ? recordPayload<WorkbenchSettings>(settingsRows[0].payload) : DEFAULT_SETTINGS;
  return {
    persistence: "d1",
    alerts: alertRows.map((row) => recordPayload<AlertRule>(row.payload)),
    alertEvents: eventRows.map((row) => recordPayload<AlertEvent>(row.payload)),
    journal: journalRows.map((row) => recordPayload<JournalEntry>(row.payload)),
    settings: { ...DEFAULT_SETTINGS, ...savedSettings, watchlist: watchRows.length ? watchRows.map((row) => row.symbol) : savedSettings.watchlist },
  };
}

export async function saveAlert(userId: string, rule: AlertRule) {
  await ensureUserDataSchema();
  const now = new Date().toISOString();
  const db = getDb();
  await db.batch([
    db.update(alerts).set({ symbol: rule.symbol, enabled: rule.enabled, payload: rule, updatedAt: now }).where(and(eq(alerts.userId, userId), eq(alerts.id, rule.id))),
    db.insert(alerts).values({ id: rule.id, userId, symbol: rule.symbol, enabled: rule.enabled, payload: rule, createdAt: rule.createdAt, updatedAt: now }).onConflictDoNothing(),
  ]);
}

export async function saveAlertEvent(userId: string, event: AlertEvent) {
  await ensureUserDataSchema();
  await getDb().insert(alertEvents).values({ id: event.id, userId, alertId: event.alertId, dedupeKey: event.dedupeKey, symbol: event.symbol, triggeredAt: event.triggeredAt, payload: event }).onConflictDoNothing();
}

export async function saveJournalEntry(userId: string, entry: JournalEntry) {
  await ensureUserDataSchema();
  const now = new Date().toISOString();
  const db = getDb();
  await db.batch([
    db.update(journalEntries).set({ symbol: entry.symbol, strategy: entry.strategy, timeframe: entry.timeframe, actualPnl: entry.actualPnl, rMultiple: entry.rMultiple, tradeDate: entry.tradeDate, payload: entry, updatedAt: now }).where(and(eq(journalEntries.userId, userId), eq(journalEntries.id, entry.id))),
    db.insert(journalEntries).values({ id: entry.id, userId, symbol: entry.symbol, strategy: entry.strategy, timeframe: entry.timeframe, actualPnl: entry.actualPnl, rMultiple: entry.rMultiple, tradeDate: entry.tradeDate, payload: entry, createdAt: entry.createdAt, updatedAt: now }).onConflictDoNothing(),
  ]);
}

export async function saveSettings(userId: string, settings: WorkbenchSettings) {
  await ensureUserDataSchema();
  const database = env.DB;
  if (!database) throw new Error("D1 binding DB is unavailable");
  const now = new Date().toISOString();
  await database.batch([
    database.prepare("INSERT INTO user_settings (user_id, payload, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at").bind(userId, JSON.stringify(settings), now),
    database.prepare("DELETE FROM watchlist WHERE user_id = ?").bind(userId),
    ...settings.watchlist.map((symbol) => database.prepare("INSERT INTO watchlist (id, user_id, symbol, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, symbol) DO NOTHING").bind(`${userId}:${symbol}`, userId, symbol, now)),
  ]);
}

export async function saveAlertEvaluation(userId: string, rules: AlertRule[], events: AlertEvent[]) {
  await ensureUserDataSchema();
  const database = env.DB;
  if (!database) throw new Error("D1 binding DB is unavailable");
  const now = new Date().toISOString();
  const statements = [
    ...rules.map((rule) => database.prepare("INSERT INTO alerts (id, user_id, symbol, enabled, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET symbol = excluded.symbol, enabled = excluded.enabled, payload = excluded.payload, updated_at = excluded.updated_at WHERE user_id = excluded.user_id").bind(rule.id, userId, rule.symbol, rule.enabled ? 1 : 0, JSON.stringify(rule), rule.createdAt, now)),
    ...events.map((event) => database.prepare("INSERT INTO alert_events (id, user_id, alert_id, dedupe_key, symbol, triggered_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, dedupe_key) DO NOTHING").bind(event.id, userId, event.alertId, event.dedupeKey, event.symbol, event.triggeredAt, JSON.stringify(event))),
  ];
  if (statements.length > 0) await database.batch(statements);
}

export async function deleteUserEntity(userId: string, entity: "alert" | "journal", id: string) {
  await ensureUserDataSchema();
  const db = getDb();
  if (entity === "alert") await db.batch([
    db.delete(alertEvents).where(and(eq(alertEvents.userId, userId), eq(alertEvents.alertId, id))),
    db.delete(alerts).where(and(eq(alerts.userId, userId), eq(alerts.id, id))),
  ]);
  else await db.delete(journalEntries).where(and(eq(journalEntries.userId, userId), eq(journalEntries.id, id)));
}

