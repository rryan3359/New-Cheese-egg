import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { evaluateAlert, evaluateAlerts } from "../lib/alerts/engine";
import { summarizeTrades, type BacktestTrade } from "../lib/backtest/engine";
import { calculateJournalAnalytics } from "../lib/journal/analytics";
import { mapWithConcurrency } from "../lib/market/http";
import { __setMarketCacheForTests, buildMarketHub, getMarketHub } from "../lib/market/hub";
import { markPayloadStale, mergeProviderPayloads, mergeSnapshotsProgressive, metric } from "../lib/market/merge";
import { buildSessionLevels, currentSession } from "../lib/market/sessions";
import { validateAlertSnapshot } from "../lib/market/snapshot";
import { calculateRiskRewards, evaluateStrategies, gradeForNetRr, ictContinuation, ictReversal } from "../lib/market/strategies";
import { DEFAULT_TRADE_COSTS, TIMEFRAMES, emptyCandleMap, type Candle, type CandleMap, type ProviderHealth, type ProviderPayload, type RawAsset, type Timeframe } from "../lib/market/types";
import { authenticatedUserId } from "../lib/persistence/auth";
import { calculatePosition } from "../lib/risk/calculator";
import type { AlertRule, JournalEntry } from "../lib/workbench/types";
import { groupOpportunitySetups } from "../lib/workbench/opportunities";
import { cockpitAssets, watchlistAssets } from "../lib/workbench/watchlist";

const now = "2026-08-21T12:00:00.000Z";
const duration: Record<Timeframe, number> = { "1m": 60_000, "5m": 300_000, "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000 };

function candles(timeframe: Timeframe, count: number, closeAt: (index: number) => number, volumeAt: (index: number) => number = () => 100): Candle[] {
  const end = Date.parse(now) - duration[timeframe];
  return Array.from({ length: count }, (_, index) => {
    const close = closeAt(index);
    const previous = index ? closeAt(index - 1) : close;
    const open = previous;
    return { time: end - (count - 1 - index) * duration[timeframe], open, close, high: Math.max(open, close) + 1, low: Math.min(open, close) - 1, volume: volumeAt(index) };
  });
}

function candleMap(count = 140): CandleMap {
  return Object.fromEntries(TIMEFRAMES.map((timeframe) => [timeframe, candles(timeframe, timeframe === "1d" ? 130 : timeframe === "4h" ? 100 : timeframe === "1h" ? 240 : count, (index) => 100 + index * 0.04 + Math.sin(index / 5) * 1.2, (index) => index % 23 === 0 ? 280 : 100 + index % 7)])) as CandleMap;
}

function strategyContext(map = candleMap()) {
  return { symbol: "BTCUSDT", candlesByTimeframe: map, sessionLevels: buildSessionLevels(map, new Date(now)), funding: 0.0001, oiChange1h: 1, topRatios: [1, 1.05, 0.98, 1.02, 1.01, 1], globalRatios: [1, 1, 1, 1, 1, 1], now };
}

function health(name: ProviderHealth["name"], state: ProviderHealth["state"] = "live"): ProviderHealth {
  return { name, state, latencyMs: 10, lastSuccessAt: now, lastFailureAt: null, consecutiveFailures: 0, circuitOpen: false, coverage: { ticker: 1, funding: 1, oi: 1, positioning: 1, candles: TIMEFRAMES.length }, errors: [] };
}

function rawAsset(overrides: Partial<RawAsset> = {}): RawAsset {
  return { symbol: "BTCUSDT", base: "BTC", price: 104, change24h: 2, quoteVolume: 2_000_000, quoteVolumeUnit: "USDT", quoteVolumeMethod: "test quote volume", funding: 0.0001, openInterest: 1_000_000, oiChange1h: 1, topRatios: [1, 1.02, 0.99, 1.03, 1.01, 1], globalRatios: [1, 1, 1, 1, 1, 1], candlesByTimeframe: candleMap(), latencyMs: 10, errors: [], ...overrides };
}

function provider(asset: RawAsset): ProviderPayload { return { assets: [asset], health: health("OKX") }; }
function fear() { return Promise.resolve({ value: metric({ value: 50, label: "Neutral" }, "Alternative.me", "live", 1, null, now), health: health("Alternative.me") }); }
function market(okx: ProviderPayload | null = provider(rawAsset())) {
  return mergeProviderPayloads({ okx, fearGreed: metric({ value: 50, label: "Neutral" }, "Alternative.me", "live", 10, null, now), fearHealth: health("Alternative.me"), now });
}

test("v13 exposes exactly three deterministic strategies and all six required timeframes", () => {
  assert.deepEqual(TIMEFRAMES, ["1m", "5m", "15m", "1h", "4h", "1d"]);
  const first = evaluateStrategies(strategyContext());
  const second = evaluateStrategies(strategyContext());
  assert.equal(first.length, 3);
  assert.deepEqual(first, second);
  assert.deepEqual(new Set(first.map((result) => result.strategy)), new Set(["EMA Trend", "Bollinger Breakout", "ICT / SMC"]));
  assert.ok(first.every((result) => result.source.includes("OKX") && result.source.includes("no look-ahead") && !result.source.toLowerCase().includes("binance")));
});

test("all three strategies remain missing instead of inventing signals when candles are absent", () => {
  const results = evaluateStrategies(strategyContext(emptyCandleMap()));
  assert.equal(results.length, 3);
  assert.ok(results.every((result) => result.status === "not_applicable" && result.dataState === "missing" && result.missingData.length > 0 && result.direction === "Neutral" && result.primaryRiskReward === null));
});

test("net RR uses worst entry boundary and deducts round-trip fees plus slippage", () => {
  const result = calculateRiskRewards({ direction: "Long", entryLow: 99, entryHigh: 101, stop: 95, tp1: 106, tp2: 111, tp3: 116, primaryTarget: "TP2", feeRate: 0.001, slippageRate: 0.0005 });
  const grossRisk = 6;
  const oneWayRate = 0.0015;
  const netRisk = grossRisk + 101 * oneWayRate + 95 * oneWayRate;
  assert.equal(result.entryBasis, "conservative-boundary");
  assert.ok(Math.abs(result.riskRewardTp1! - ((5 - (101 + 106) * oneWayRate) / netRisk)) < 1e-10);
  assert.ok(Math.abs(result.riskRewardTp2! - ((10 - (101 + 111) * oneWayRate) / netRisk)) < 1e-10);
  assert.equal(result.primaryRiskReward, result.riskRewardTp2);
  assert.ok(result.grossRiskRewardTp2! > result.riskRewardTp2!);
});

test("1.5R is executable B grade and 2R is executable A grade", () => {
  assert.equal(gradeForNetRr(1.49), null);
  assert.equal(gradeForNetRr(1.5), "B");
  assert.equal(gradeForNetRr(1.99), "B");
  assert.equal(gradeForNetRr(2), "A");
  for (const setup of evaluateStrategies(strategyContext())) {
    if (setup.status === "executable") assert.ok(setup.primaryRiskReward !== null && setup.primaryRiskReward >= 1.5 && setup.grade !== null);
    if (setup.eligibleForScanner) assert.equal(setup.status, "executable");
  }
});

test("strategies separate hard, bonus and missing data while ICT keeps two submodels", () => {
  const results = evaluateStrategies(strategyContext());
  assert.ok(results.every((setup) => setup.hardConditions.length > 0 && setup.bonusConditions.length > 0));
  assert.ok(results.every((setup) => setup.conditionsTotal === setup.hardConditionsTotal));
  assert.equal(ictReversal(strategyContext()).submodel, "Reversal");
  assert.equal(ictContinuation(strategyContext()).submodel, "Continuation");
  assert.ok(ictContinuation(strategyContext()).trigger.includes("不要求先 Sweep"));
});

test("same-symbol confluence merges and opposite directions become no-trade conflict", () => {
  const base = evaluateStrategies(strategyContext())[0];
  const longA = { ...base, strategy: "EMA Trend" as const, status: "executable" as const, direction: "Long" as const, grade: "B" as const, primaryRiskReward: 1.7, eligibleForScanner: true };
  const longB = { ...base, id: `${base.id}-bb`, strategy: "Bollinger Breakout" as const, status: "executable" as const, direction: "Long" as const, grade: "A" as const, primaryRiskReward: 2.2, eligibleForScanner: true };
  const merged = groupOpportunitySetups([longA, longB]);
  assert.equal(merged.opportunities.length, 1);
  assert.equal(merged.opportunities[0].setups.length, 2);
  assert.equal(merged.opportunities[0].primary.strategy, "Bollinger Breakout");
  const conflict = groupOpportunitySetups([longA, { ...longB, direction: "Short" as const }]);
  assert.equal(conflict.opportunities.length, 0);
  assert.equal(conflict.conflicts.length, 1);
});

test("session clock uses the five New York windows and handles daylight saving", () => {
  assert.equal(currentSession(new Date("2026-07-16T00:30:00Z")).label, "亞盤");
  assert.equal(currentSession(new Date("2026-07-15T06:30:00Z")).label, "倫敦盤");
  const summer = currentSession(new Date("2026-07-15T13:45:00Z"));
  const winter = currentSession(new Date("2026-01-15T14:45:00Z"));
  assert.equal(summer.label, "美盤早盤");
  assert.equal(summer.opensAt, "2026-07-15T13:30:00.000Z");
  assert.equal(summer.closesAt, "2026-07-15T14:45:00.000Z");
  assert.equal(winter.opensAt, "2026-01-15T14:30:00.000Z");
  assert.equal(winter.closesAt, "2026-01-15T15:45:00.000Z");
  assert.equal(currentSession(new Date("2026-07-15T16:15:00Z")).label, "美盤午盤");
  assert.equal(currentSession(new Date("2026-07-15T18:00:00Z")).label, "美盤午後");
});

test("PDH PDL and session levels come from candles and never default to zero", () => {
  const levels = buildSessionLevels(candleMap(), new Date(now));
  assert.ok(levels.some((level) => level.kind === "PDH"));
  assert.ok(levels.some((level) => level.kind === "PDL"));
  assert.ok(levels.every((level) => Number.isFinite(level.price) && level.price !== 0));
});

test("provider work queue never exceeds configured concurrency", async () => {
  let active = 0;
  let peak = 0;
  const values = await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (value) => { active += 1; peak = Math.max(peak, active); await new Promise((resolve) => setTimeout(resolve, 2)); active -= 1; return value * 2; });
  assert.equal(peak, 2);
  assert.deepEqual(values, [2, 4, 6, 8, 10, 12]);
});

test("OKX-only hub returns three strategies and preserves missing derivatives as null", async () => {
  const payload = await buildMarketHub({ okx: async () => provider(rawAsset({ price: 99, funding: null, oiChange1h: null, topRatios: [], globalRatios: [] })), fear }, "l3");
  assert.equal(payload.pipeline.stage, "using-okx");
  assert.equal(payload.assets[0].price.source, "OKX");
  assert.equal(payload.assets[0].funding.value, null);
  assert.equal(payload.assets[0].positioning.value, null);
  assert.equal(payload.assets[0].strategies.length, 3);
  assert.equal(payload.pipeline.binanceDurationMs, null);
});

test("progressive merge retains L1 price and accepts richer L3 strategy candles", () => {
  const l1 = market(provider(rawAsset({ candlesByTimeframe: emptyCandleMap(), price: 101 })));
  const l3 = market(provider(rawAsset({ price: null, funding: null, openInterest: null, oiChange1h: null })));
  const merged = mergeSnapshotsProgressive(l1, l3);
  assert.equal(merged.assets[0].price.value, 101);
  assert.equal(merged.assets[0].strategies.length, 3);
  assert.ok(merged.assets[0].timeframes["1m"].candles.length > 0);
});

test("fresh caches isolate l1 l2 and l3", async () => {
  __setMarketCacheForTests(null);
  for (const [tier, price] of [["l1", 11], ["l2", 22], ["l3", 33]] as const) {
    const payload = market(provider(rawAsset({ price })));
    __setMarketCacheForTests({ payload: { ...payload, pipeline: { ...payload.pipeline, tier } }, storedAt: Date.now() }, tier);
  }
  const results = await Promise.all([getMarketHub(undefined, "l1"), getMarketHub(undefined, "l2"), getMarketHub(undefined, "l3")]);
  assert.deepEqual(results.map((value) => value.assets[0].price.value), [11, 22, 33]);
  __setMarketCacheForTests(null);
});

test("concurrent requests for one tier coalesce and hung OKX falls back to stale", async () => {
  __setMarketCacheForTests(null);
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const clients = { okx: async () => { calls += 1; await gate; return provider(rawAsset({ price: 88 })); }, fear };
  const first = getMarketHub(clients, "l1");
  const second = getMarketHub(clients, "l1");
  release();
  const same = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.deepEqual(same[0], same[1]);

  const saved = market(provider(rawAsset({ price: 50 })));
  __setMarketCacheForTests(null);
  __setMarketCacheForTests({ payload: saved, storedAt: Date.now() - 31_000 });
  const stale = await getMarketHub({ okx: async () => new Promise<ProviderPayload>(() => undefined), fear, okxTimeoutMs: 15 });
  assert.equal(stale.pipeline.stage, "showing-stale");
  __setMarketCacheForTests(null);
});

function alertRule(overrides: Partial<AlertRule> = {}): AlertRule {
  return { id: "alert-1", symbol: "BTCUSDT", type: "price_target", timeframe: "1h", strategy: null, operator: "above", threshold: 100, thresholdUpper: null, referenceValue: null, enabled: true, cooldownMinutes: 60, dedupeKey: null, lastEvaluatedAt: null, lastTriggeredAt: null, triggerCount: 0, currentStatus: "watching", lastReason: "", createdAt: now, ...overrides };
}

test("alerts dedupe snapshots and retired strategy alerts are retained as legacy missing", () => {
  const payload = market();
  const first = evaluateAlert(alertRule(), payload, new Date("2026-08-21T13:00:00Z"));
  assert.equal(first.rule.currentStatus, "triggered");
  assert.ok(first.event);
  const duplicate = evaluateAlert(first.rule, payload, new Date("2026-08-21T13:30:00Z"));
  assert.equal(duplicate.rule.currentStatus, "cooldown");
  const legacy = evaluateAlert(alertRule({ type: "strategy_eligible", strategy: "Funding Mean Reversion", strategyLegacy: true }), payload);
  assert.equal(legacy.rule.currentStatus, "missing");
  assert.match(legacy.rule.lastReason, /legacy/);
});

test("market and alert engine consume the same validated snapshot", () => {
  const payload = market();
  const validated = validateAlertSnapshot(payload, Date.parse(now) + 1_000);
  const evaluation = evaluateAlerts([alertRule()], validated, new Date(Date.parse(now) + 1_000));
  assert.equal(validated.updatedAt, payload.updatedAt);
  assert.equal(evaluation.events.length, 1);
  assert.throws(() => validateAlertSnapshot(payload, Date.parse(now) + 11 * 60_000), /超過 10 分鐘/);
});

test("stale cache expires honestly", () => {
  const payload = market();
  assert.equal(markPayloadStale(payload, 1_000, 2_000, 5_000)?.assets[0].price.state, "stale");
  assert.equal(markPayloadStale(payload, 1_000, 7_000, 5_000), null);
});

test("backtest statistics include expectancy profit factor drawdown and sample warnings", () => {
  const base: BacktestTrade = { symbol: "BTCUSDT", strategy: "EMA Trend", timeframe: "15m", session: "倫敦盤", regime: "Trend Up", threshold: 1.5, signalAt: now, entryAt: now, exitAt: now, direction: "Long", entry: 100, stop: 95, target: 110, exit: 110, plannedNetRr: 1.8, realizedR: 1, outcome: "target" };
  const metrics = summarizeTrades([{ ...base, realizedR: 1 }, { ...base, realizedR: -1, outcome: "stop" }, { ...base, realizedR: 2 }]);
  assert.equal(metrics.trades, 3);
  assert.equal(metrics.winRate, 2 / 3 * 100);
  assert.equal(metrics.averageR, 2 / 3);
  assert.equal(metrics.expectancy, metrics.averageR);
  assert.equal(metrics.profitFactor, 3);
  assert.equal(metrics.sampleSufficient, false);
});

test("watchlist, risk sizing, journal analytics, identity and migrations remain compatible", () => {
  const btc = market().assets[0];
  const eth = { ...btc, symbol: "ETHUSDT", name: "Ethereum" };
  const sol = { ...btc, symbol: "SOLUSDT", name: "Solana" };
  assert.deepEqual(cockpitAssets([btc, eth, sol], ["SOLUSDT", "ETHUSDT"]).map((item) => item.symbol), ["SOLUSDT", "ETHUSDT", "BTCUSDT"]);
  assert.deepEqual(watchlistAssets([btc, eth], [], true), []);

  const position = calculatePosition({ balance: 10_000, riskPercent: 1, entry: 100, stop: 95, leverage: 5, side: "Long", feeRate: 0.001 });
  assert.equal(position.valid, true);
  assert.ok(Math.abs(position.riskAfterFees - 100) < 1e-8);

  const journalBase: JournalEntry = { id: "", symbol: "BTC", side: "Long", strategy: "EMA Trend", strategyVersion: 13, strategyLegacy: false, timeframe: "15m", reason: "", entry: 100, stop: 95, target: 110, exit: 0, quantity: 1, fees: 1, fundingCost: 0, actualPnl: 0, rMultiple: 0, followed: true, mistake: "無", notes: "", chartNote: "", tradeDate: "2026-08-21", entryTime: now, exitTime: now, createdAt: now };
  const stats = calculateJournalAnalytics([{ ...journalBase, id: "1", actualPnl: 100, rMultiple: 1 }, { ...journalBase, id: "2", actualPnl: -50, rMultiple: -0.5 }]);
  assert.equal(stats.profitFactor, 2);

  assert.notEqual(authenticatedUserId(new Request("https://site.test/api", { headers: { "oai-authenticated-user-id": "user-a" } })), authenticatedUserId(new Request("https://site.test/api", { headers: { "oai-authenticated-user-id": "user-b" } })));
  const legacyMigration = readFileSync(new URL("../drizzle/0001_v13_strategy_compat.sql", import.meta.url), "utf8");
  const rulesetMigration = readFileSync(new URL("../drizzle/0002_v13_1_strategy_ruleset.sql", import.meta.url), "utf8");
  assert.match(legacyMigration, /strategy_legacy/);
  assert.match(rulesetMigration, /strategy_model/);
  assert.match(rulesetMigration, /strategy_ruleset/);
  assert.match(rulesetMigration, /v13-legacy/);
  assert.match(rulesetMigration, /PRAGMA optimize/);
  assert.doesNotMatch(`${legacyMigration}\n${rulesetMigration}`, /DROP TABLE|DELETE FROM/);
});

test("default trade costs stay conservative and explicit", () => {
  assert.deepEqual(DEFAULT_TRADE_COSTS, { feeRate: 0.0005, slippageRate: 0.0003 });
});
