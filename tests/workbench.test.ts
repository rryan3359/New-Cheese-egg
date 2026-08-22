import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { evaluateAlert, evaluateAlerts } from "../lib/alerts/engine";
import { calculateJournalAnalytics } from "../lib/journal/analytics";
import { mapWithConcurrency } from "../lib/market/http";
import { __setMarketCacheForTests, buildMarketHub, getMarketHub, okxPlanForMissingFields } from "../lib/market/hub";
import { markPayloadStale, mergeProviderPayloads, metric } from "../lib/market/merge";
import { breakout, calculateRiskRewards, evaluateStrategies, fundingMeanReversion, ictLiquiditySweep, positioningDivergence, rangeMeanReversion } from "../lib/market/strategies";
import { validateAlertSnapshot } from "../lib/market/snapshot";
import { TIMEFRAMES, type Candle, type CandleMap, type MarketHubPayload, type ProviderHealth, type ProviderPayload, type RawAsset } from "../lib/market/types";
import { authenticatedUserId } from "../lib/persistence/auth";
import { calculatePosition } from "../lib/risk/calculator";
import type { AlertRule, JournalEntry } from "../lib/workbench/types";
import { cockpitAssets, watchlistAssets } from "../lib/workbench/watchlist";

const now = "2026-08-21T00:00:00.000Z";

function candles(count: number, closeAt: (index: number) => number, volumeAt: (index: number) => number = () => 100): Candle[] {
  return Array.from({ length: count }, (_, index) => {
    const close = closeAt(index);
    const previous = index ? closeAt(index - 1) : close;
    const open = previous;
    return { time: Date.parse(now) + index * 60_000, open, close, high: Math.max(open, close) + 1, low: Math.min(open, close) - 1, volume: volumeAt(index) };
  });
}

function context(overrides: Partial<Parameters<typeof breakout>[0]> = {}) {
  return { symbol: "BTCUSDT", timeframe: "1h" as const, candles: candles(120, (index) => 100 + Math.sin(index / 4) * 2), funding: .0001, oiChange1h: 1, topRatios: [1, 1.05, .98, 1.02, 1.01, 1], globalRatios: [1, 1, 1, 1, 1, 1], now, ...overrides };
}

function health(name: ProviderHealth["name"], state: ProviderHealth["state"] = "live"): ProviderHealth {
  return { name, state, latencyMs: 10, lastSuccessAt: now, lastFailureAt: null, consecutiveFailures: 0, circuitOpen: false, coverage: { ticker: 1, funding: 1, oi: 1, positioning: 1, candles: 4 }, errors: [] };
}

function rawAsset(overrides: Partial<RawAsset> = {}): RawAsset {
  const baseCandles = candles(120, (index) => 100 + index * .03 + Math.sin(index / 4));
  const candlesByTimeframe = Object.fromEntries(TIMEFRAMES.map((timeframe) => [timeframe, baseCandles])) as CandleMap;
  return { symbol: "BTCUSDT", base: "BTC", price: 104, change24h: 2, quoteVolume: 2_000_000, quoteVolumeUnit: "USDT", quoteVolumeMethod: "test quote volume", funding: .0001, openInterest: 1_000_000, oiChange1h: 1, topRatios: [1, 1.02, .99, 1.03, 1.01, 1], globalRatios: [1, 1, 1, 1, 1, 1], candlesByTimeframe, latencyMs: 10, errors: [], ...overrides };
}

function provider(name: "Binance" | "OKX", asset: RawAsset): ProviderPayload { return { assets: [asset], health: health(name) }; }
function fear() { return Promise.resolve({ value: metric({ value: 50, label: "Neutral" }, "Alternative.me", "live", 1, null, now), health: health("Alternative.me") }); }
function market(binance: ProviderPayload | null = provider("Binance", rawAsset()), okx: ProviderPayload | null = provider("OKX", rawAsset())) {
  return mergeProviderPayloads({ binance, okx, fearGreed: metric({ value: 50, label: "Neutral" }, "Alternative.me", "live", 10, null, now), fearHealth: health("Alternative.me"), now });
}

test("all seven strategies declare missing when candle history is insufficient", () => {
  const results = evaluateStrategies(context({ candles: candles(10, (index) => 100 + index) }));
  assert.equal(results.length, 7);
  assert.deepEqual(new Set(results.map((result) => result.status)), new Set(["missing"]));
  for (const result of results) { assert.equal(result.entryLow, null); assert.equal(result.riskReward, null); assert.ok(result.missingConditions.length > 0); }
});

test("provider work queue never exceeds its configured concurrency", async () => {
  let active = 0;
  let peak = 0;
  const values = await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (value) => {
    active += 1; peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active -= 1;
    return value * 2;
  });
  assert.equal(peak, 2);
  assert.deepEqual(values, [2, 4, 6, 8, 10, 12]);
});

test("Binance success returns without waiting for OKX warm standby", async () => {
  let okxCalls = 0;
  const startedAt = Date.now();
  const payload = await buildMarketHub(false, {
    binance: async () => provider("Binance", rawAsset()),
    okx: async () => { okxCalls += 1; await new Promise((resolve) => setTimeout(resolve, 120)); return provider("OKX", rawAsset()); },
    fear,
  });
  assert.equal(okxCalls, 0);
  assert.equal(payload.pipeline.stage, "using-binance");
  assert.ok(Date.now() - startedAt < 100, `unexpected latency ${Date.now() - startedAt}ms`);
});

test("Binance missing fields request only the required OKX fields", async () => {
  const incomplete = rawAsset({ funding: null, candlesByTimeframe: { ...rawAsset().candlesByTimeframe, "4h": [] } });
  const plan = okxPlanForMissingFields(provider("Binance", incomplete));
  assert.deepEqual(plan.fundingSymbols, ["BTCUSDT"]);
  assert.deepEqual(plan.candleTimeframes.BTCUSDT, ["4h"]);
  assert.deepEqual(plan.tickerSymbols, []);
  let receivedPlan = plan;
  const payload = await buildMarketHub(false, { binance: async () => provider("Binance", incomplete), okx: async (next) => { receivedPlan = next; return provider("OKX", rawAsset()); }, fear });
  assert.deepEqual(receivedPlan, plan);
  assert.equal(payload.assets[0].funding.source, "OKX");
  assert.equal(payload.pipeline.stage, "filling-from-okx");
});

test("Binance failure switches completely to OKX", async () => {
  let fullPlan = false;
  const payload = await buildMarketHub(false, { binance: async () => { throw new Error("Binance unavailable"); }, okx: async (plan) => { fullPlan = plan.full; return provider("OKX", rawAsset()); }, fear });
  assert.equal(fullPlan, true);
  assert.equal(payload.pipeline.stage, "using-okx-fallback");
  assert.equal(payload.assets[0].price.source, "OKX");
});

test("normal and force OKX in-flight requests never share results", async () => {
  __setMarketCacheForTests(null);
  const providers = {
    binance: async () => { await new Promise((resolve) => setTimeout(resolve, 15)); return provider("Binance", rawAsset({ price: 111 })); },
    okx: async () => { await new Promise((resolve) => setTimeout(resolve, 5)); return provider("OKX", rawAsset({ price: 222 })); },
    fear,
  };
  const [normal, forced] = await Promise.all([getMarketHub(false, providers), getMarketHub(true, providers)]);
  assert.equal(normal.pipeline.mode, "normal");
  assert.equal(normal.assets[0].price.value, 111);
  assert.equal(forced.pipeline.mode, "force-okx");
  assert.equal(forced.assets[0].price.value, 222);
});

test("hung OKX fallback is hard bounded, returns stale data, and clears in-flight state", async () => {
  const saved = market();
  __setMarketCacheForTests({ payload: saved, storedAt: Date.now() - 31_000 });
  const startedAt = Date.now();
  const stale = await getMarketHub(false, {
    binance: async () => { throw new Error("Binance unavailable"); },
    okx: async () => new Promise<ProviderPayload>(() => undefined),
    fear,
    okxTimeoutMs: 15,
  });
  assert.equal(stale.pipeline.stage, "showing-stale");
  assert.ok(Date.now() - startedAt < 1_200, `deadline did not stop request: ${Date.now() - startedAt}ms`);

  const recovered = await getMarketHub(false, {
    binance: async () => provider("Binance", rawAsset({ price: 123 })),
    okx: async () => provider("OKX", rawAsset()),
    fear,
  });
  assert.equal(recovered.pipeline.stage, "using-binance");
  assert.equal(recovered.assets[0].price.value, 123);
});

test("all seven strategies produce deterministic non-missing decisions with complete inputs", () => {
  const first = evaluateStrategies(context());
  const second = evaluateStrategies(context());
  assert.equal(first.length, 7);
  assert.ok(first.every((result) => result.status !== "missing"));
  assert.deepEqual(first, second);
  assert.deepEqual(new Set(first.map((result) => result.strategy)).size, 7);
});

test("breakout becomes eligible only with range break, volume and ATR filters", () => {
  const fixture = candles(80, (index) => index === 79 ? 103 : 100 + Math.sin(index / 3), (index) => index === 79 ? 1000 : 100 + index % 5 * 5);
  const result = breakout(context({ candles: fixture }));
  assert.equal(result.status, "eligible", JSON.stringify(result));
  assert.equal(result.direction, "Long");
  assert.equal(result.conditionsMet, result.conditionsTotal);
  assert.notEqual(result.primaryRiskReward, 2);
  assert.ok(result.riskRewardTp1! < result.riskRewardTp2! && result.riskRewardTp2! < result.riskRewardTp3!);
});

test("funding mean reversion and positioning divergence require derivatives confirmation", () => {
  const extended = candles(80, (index) => index < 79 ? 100 + index * .18 : 112);
  extended[79] = { ...extended[79], open: 116, high: 117, low: 111, close: 112, volume: 500 };
  const funding = fundingMeanReversion(context({ candles: extended, funding: .0008, oiChange1h: 1 }));
  assert.notEqual(funding.status, "missing");
  assert.equal(funding.direction, "Short");

  const rising = candles(60, (index) => 100 + index * .15);
  const divergence = positioningDivergence(context({ candles: rising, oiChange1h: 1, topRatios: [1, 1, 1, 1, 1, .2], globalRatios: [1, 1, 1, 1, 1, 1] }));
  assert.equal(divergence.status, "eligible");
  assert.equal(divergence.direction, "Long");
});

test("ICT liquidity sweep distinguishes waiting from missing data", () => {
  const fixture = candles(60, (index) => 100 + Math.sin(index / 3) * 2);
  fixture[59] = { ...fixture[59], open: 96, high: 104, low: 94, close: 103, volume: 500 };
  const result = ictLiquiditySweep(context({ candles: fixture }));
  assert.notEqual(result.status, "missing");
  assert.ok(["eligible", "waiting"].includes(result.status));
  assert.ok(result.missingConditions.some((condition) => condition.includes("FVG")));
});

test("field merge uses OKX fallback and preserves unavailable positioning as missing", () => {
  const primary = rawAsset({ funding: null, topRatios: [], globalRatios: [] });
  const fallback = rawAsset({ funding: .0002, topRatios: [], globalRatios: [] });
  const payload = market(provider("Binance", primary), provider("OKX", fallback));
  assert.equal(payload.assets[0].funding.source, "OKX");
  assert.equal(payload.assets[0].funding.state, "fallback");
  assert.equal(payload.assets[0].positioning.value, null);
  assert.equal(payload.assets[0].positioning.state, "missing");
});

test("OKX global ratios alone can produce simplified positioning score", () => {
  const primary = rawAsset({ topRatios: [], globalRatios: [] });
  const fallback = rawAsset({ topRatios: [], globalRatios: [0.8, 0.85, 0.9, 0.95, 1.0, 1.2] });
  const payload = market(provider("Binance", primary), provider("OKX", fallback));
  assert.notEqual(payload.assets[0].positioning.value, null);
  assert.equal(payload.assets[0].positioning.state, "fallback");
  assert.equal(payload.assets[0].globalRatio.source, "OKX");
});

test("merge rejects empty providers and stale cache expires honestly", () => {
  assert.throws(() => market(null, null), /No market records/);
  const payload = market();
  const stale = markPayloadStale(payload, 1_000, 2_000, 5_000);
  assert.equal(stale?.assets[0].price.state, "stale");
  assert.equal(markPayloadStale(payload, 1_000, 7_000, 5_000), null);
});

function alertRule(overrides: Partial<AlertRule> = {}): AlertRule {
  return { id: "alert-1", symbol: "BTCUSDT", type: "price_target", timeframe: "1h", strategy: null, operator: "above", threshold: 100, thresholdUpper: null, referenceValue: null, enabled: true, cooldownMinutes: 60, dedupeKey: null, lastEvaluatedAt: null, lastTriggeredAt: null, triggerCount: 0, currentStatus: "watching", lastReason: "", createdAt: now, ...overrides };
}

test("alert engine triggers, deduplicates the same snapshot and enforces cooldown", () => {
  const payload = market();
  const first = evaluateAlert(alertRule(), payload, new Date("2026-08-21T01:00:00Z"));
  assert.equal(first.rule.currentStatus, "triggered"); assert.ok(first.event);
  const duplicate = evaluateAlert(first.rule, payload, new Date("2026-08-21T01:30:00Z"));
  assert.equal(duplicate.rule.currentStatus, "cooldown"); assert.equal(duplicate.event, null);
  const laterPayload: MarketHubPayload = { ...payload, updatedAt: "2026-08-21T03:00:00Z", assets: payload.assets.map((asset) => ({ ...asset, price: { ...asset.price, updatedAt: "2026-08-21T03:00:00Z" } })) };
  const later = evaluateAlert(first.rule, laterPayload, new Date("2026-08-21T03:00:00Z"));
  assert.equal(later.rule.currentStatus, "triggered"); assert.ok(later.event);
});

test("market screen and alert engine consume the same validated snapshot without providers", () => {
  const payload = market();
  const validated = validateAlertSnapshot(payload, Date.parse(now) + 1_000);
  const evaluation = evaluateAlerts([alertRule()], validated, new Date(Date.parse(now) + 1_000));
  assert.equal(validated.updatedAt, payload.updatedAt);
  assert.equal(evaluation.events.length, 1);
  assert.equal(evaluation.events[0].value, payload.assets[0].price.value);
  assert.throws(() => validateAlertSnapshot(payload, Date.parse(now) + 11 * 60_000), /超過 10 分鐘/);
});

test("TP1 TP2 TP3 RR use conservative entry boundary and real prices", () => {
  const result = calculateRiskRewards({ direction: "Long", entryLow: 99, entryHigh: 101, stop: 95, tp1: 106, tp2: 111, tp3: 116, primaryTarget: "TP2" });
  assert.equal(result.entryBasis, "conservative-boundary");
  assert.ok(Math.abs(result.riskRewardTp1! - 5 / 6) < 1e-10);
  assert.ok(Math.abs(result.riskRewardTp2! - 10 / 6) < 1e-10);
  assert.ok(Math.abs(result.riskRewardTp3! - 15 / 6) < 1e-10);
  assert.equal(result.primaryRiskReward, result.riskRewardTp2);
  assert.equal(result.riskReward, result.primaryRiskReward);
});

test("Range Mean Reversion recomputes primary RR from the Bollinger middle target", () => {
  const result = rangeMeanReversion(context());
  assert.equal(result.primaryTarget, "TP1");
  assert.equal(result.riskReward, result.riskRewardTp1);
  assert.notEqual(result.riskReward, 2);
});

test("watchlist prioritizes cockpit and truly filters scanner inputs", () => {
  const btc = market().assets[0];
  const eth = { ...btc, symbol: "ETHUSDT", name: "Ethereum" };
  const sol = { ...btc, symbol: "SOLUSDT", name: "Solana" };
  assert.deepEqual(cockpitAssets([btc, eth, sol], ["SOLUSDT", "ETHUSDT"]).map((item) => item.symbol), ["SOLUSDT", "ETHUSDT", "BTCUSDT"]);
  assert.deepEqual(watchlistAssets([btc, eth, sol], ["ETHUSDT"], true).map((item) => item.symbol), ["ETHUSDT"]);
  assert.deepEqual(watchlistAssets([btc, eth], [], true), []);
});

test("Drizzle migration is present, statement-separated, and user tables are scoped", () => {
  const migration = readFileSync(new URL("../drizzle/0000_user_workbench.sql", import.meta.url), "utf8");
  const statements = migration.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean);
  assert.ok(statements.length >= 10);
  for (const table of ["alerts", "alert_events", "journal_entries", "user_settings", "watchlist"]) assert.match(migration, new RegExp("CREATE TABLE `" + table + "`"));
  assert.ok((migration.match(/`user_id`/g) ?? []).length >= 5);
});

test("position sizing includes fees inside max risk and returns 1R/2R/3R", () => {
  const plan = calculatePosition({ balance: 10_000, riskPercent: 1, entry: 100, stop: 95, leverage: 5, side: "Long", feeRate: .001 });
  assert.equal(plan.valid, true);
  assert.ok(Math.abs(plan.riskAfterFees - 100) < 1e-8);
  assert.deepEqual(plan.targets.map((target) => target.multiple), [1, 2, 3]);
  assert.ok(plan.quantity < 20);
});

test("journal analytics use realized net PnL for profit factor, streak and drawdown", () => {
  const base: JournalEntry = { id: "", symbol: "BTC", side: "Long", strategy: "Trend Pullback", timeframe: "1h", reason: "", entry: 100, stop: 95, target: 110, exit: 0, quantity: 1, fees: 1, fundingCost: 0, actualPnl: 0, rMultiple: 0, followed: true, mistake: "無", notes: "", chartNote: "", tradeDate: "2026-08-21", entryTime: now, exitTime: now, createdAt: now };
  const entries = [{ ...base, id: "1", actualPnl: 100, rMultiple: 1 }, { ...base, id: "2", actualPnl: -50, rMultiple: -.5, followed: false }, { ...base, id: "3", actualPnl: -25, rMultiple: -.25 }];
  const stats = calculateJournalAnalytics(entries);
  assert.equal(stats.profitFactor, 100 / 75);
  assert.equal(stats.maxLosingStreak, 2);
  assert.equal(stats.maxDrawdown, -75);
});

test("identity extraction keeps users distinct and only allows local development fallback", () => {
  const first = authenticatedUserId(new Request("https://site.test/api", { headers: { "oai-authenticated-user-id": "user-a" } }));
  const second = authenticatedUserId(new Request("https://site.test/api", { headers: { "oai-authenticated-user-id": "user-b" } }));
  assert.equal(first, "user-a"); assert.equal(second, "user-b"); assert.notEqual(first, second);
  assert.equal(authenticatedUserId(new Request("https://site.test/api")), null);
  assert.equal(authenticatedUserId(new Request("http://localhost:3000/api")), "local-development-user");
});

