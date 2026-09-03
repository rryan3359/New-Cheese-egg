"use client";

import { useMemo, useState, useSyncExternalStore } from "react";
import {
  STRATEGY_NAMES,
  TIMEFRAMES,
  type MarketHubPayload,
  type StrategyName,
  type StrategyResult,
  type StrategyStatus,
  type Timeframe,
} from "../../lib/market/types";
import { cockpitAssets, prioritizeByWatchlist } from "../../lib/workbench/watchlist";
import { groupOpportunitySetups, type OpportunityGroup } from "../../lib/workbench/opportunities";
import TradingViewWidget from "./TradingViewWidget";

export type OpenChart = (symbol: string, timeframe?: Timeframe, strategy?: StrategyName) => void;
export type OpportunityActions = {
  onOpenChart: OpenChart;
  onCreateAlert?: (setup: StrategyResult) => void;
  onToggleWatchlist?: (symbol: string) => void;
};

export const strategyTips: Record<StrategyName, string> = {
  "EMA Trend": "1H／4H EMA 與有效斜率決定 Bias；5m／15m 回踩後，收盤站回或微型 BOS 任一成立即可，成交量與衍生品只加分。",
  "Bollinger Breakout": "BB Width 位於近 100 根低 20% 後擴張；有效收盤突破是硬條件，成交量與回測只提高品質。",
  "ICT / SMC": "反轉模型需要 Sweep；延續模型不強制 Sweep。兩者皆接受 FVG 或 OB 任一成立，1m 只作精細進場加分。",
};
export const strategyLabels: Record<StrategyName, string> = {
  "EMA Trend": "均線順勢",
  "Bollinger Breakout": "布林帶波動突破",
  "ICT / SMC": "ICT／SMC",
};
const stateLabels: Record<string, string> = {
  live: "即時", stale: "稍早資料", missing: "資料缺失",
  not_applicable: "不適用", forming: "形成中", waiting_trigger: "等待觸發", executable: "可執行", invalidated: "失效／過期",
  eligible: "可執行", waiting: "形成中", applicable: "不適用", invalid: "失效／過期",
  triggered: "已觸發", cooldown: "暫停提醒", disabled: "已關閉",
};
const directionLabels: Record<string, string> = { Long: "偏多", Short: "偏空", Neutral: "中性" };
const regimeLabels: Record<string, string> = {
  "Trend Up": "上升趨勢", "Trend Down": "下降趨勢", Compression: "波動收斂",
  "Liquidity Sweep": "流動性掃蕩", "High Volatility": "高波動", "No Trade": "目前不適合交易", "N/A": "資料不足",
};

export function formatPrice(value: number | null, digits = 2) {
  if (value === null || !Number.isFinite(value)) return "N/A";
  return `$${new Intl.NumberFormat("en-US", { maximumFractionDigits: value < 10 ? 4 : digits, minimumFractionDigits: value < 10 ? 4 : digits }).format(value)}`;
}
export function formatPercent(value: number | null, digits = 2) {
  if (value === null) return "N/A";
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}%`;
}
export function compact(value: number | null) {
  if (value === null) return "N/A";
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(value);
}
function compactMoney(value: number | null) { return value === null ? "N/A" : `$${compact(value)}`; }
function tone(value: number | null) { return value === null ? "missing" : value >= 0 ? "positive" : "negative"; }
function StatePill({ state }: { state: string }) { return <span className={`metric-state ${state}`}>{stateLabels[state] ?? state}</span>; }

function formatSessionRange(opensAt: string, closesAt: string, timeZone: string) {
  const start = new Date(opensAt);
  const end = new Date(closesAt);
  const time = new Intl.DateTimeFormat("zh-TW", { hour12: false, hour: "2-digit", minute: "2-digit", timeZone });
  const date = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone });
  const nextDay = date.format(start) !== date.format(end);
  return `${time.format(start)}–${nextDay ? "翌日 " : ""}${time.format(end)}`;
}

const subscribeToTimeZone = () => () => {};
const readUserTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

function SessionTimeCard({ session }: { session: MarketHubPayload["session"] }) {
  const userTimeZone = useSyncExternalStore(subscribeToTimeZone, readUserTimeZone, () => null);

  if (!session.opensAt || !session.closesAt) {
    return <article><span>目前市場交易時段</span><strong>{session.label}</strong><p>等待下一個主要時段</p></article>;
  }

  const marketRange = formatSessionRange(session.opensAt, session.closesAt, session.timezone);
  const localRange = userTimeZone ? formatSessionRange(session.opensAt, session.closesAt, userTimeZone) : "自動換算中";
  return <article><span>目前市場交易時段</span><strong>{session.label}</strong><p>市場時間 {marketRange} · {session.timezone}<br />使用者當地時間 {localRange}{userTimeZone ? ` · ${userTimeZone}` : ""}</p></article>;
}

function AssetQuoteCard({ asset, ticker }: { asset: MarketHubPayload["assets"][number] | undefined; ticker: "BTC" | "ETH" }) {
  const price = asset?.price.value ?? null;
  const change = asset?.change24h.value ?? null;
  const funding = asset?.funding.value ?? null;
  const openInterest = asset?.openInterest.value ?? null;
  return <article className={`asset-quote-card ${ticker.toLowerCase()}`}>
    <span>{ticker} 永續行情</span>
    <div><strong>{formatPrice(price)}</strong><StatePill state={asset?.price.state ?? "missing"} /></div>
    <p><b className={tone(change)}>24h {formatPercent(change)}</b><small>Funding {funding === null ? "N/A" : `${(funding * 100).toFixed(4)}%`} · OI {compact(openInterest)}</small></p>
  </article>;
}
function rr(value: number | null) { return value === null ? "N/A" : `${value.toFixed(2)}R`; }

function rankSetups(setups: StrategyResult[]) {
  const rank: Record<StrategyStatus, number> = { executable: 5, waiting_trigger: 4, forming: 3, not_applicable: 2, invalidated: 1 };
  return [...setups].sort((a, b) => rank[b.status] - rank[a.status] || Number(b.grade === "A") - Number(a.grade === "A") || (b.primaryRiskReward ?? -1) - (a.primaryRiskReward ?? -1) || b.confidence - a.confidence);
}

function OpportunityCard({ opportunity, watchlist, actions }: { opportunity: OpportunityGroup; watchlist: string[]; actions: OpportunityActions }) {
  const setup = opportunity.primary;
  const pending = setup.pendingConditions.slice(0, 2);
  const missing = setup.missingData.slice(0, 2);
  const confluence = opportunity.setups.map((item) => `${strategyLabels[item.strategy]}${item.submodel ? `／${item.submodel === "Reversal" ? "反轉" : "延續"}` : ""}`);
  return <article className="opportunity-card-v13">
    <header>
      <div><span className={`direction ${setup.direction.toLowerCase()}`}>{directionLabels[setup.direction]}</span><b>{setup.symbol.replace("USDT", "")} · {setup.timeframe}</b></div>
      <div className="opportunity-badges"><StatePill state={setup.status} />{setup.grade && <b className={`grade-badge grade-${setup.grade.toLowerCase()}`}>{setup.grade}級</b>}</div>
    </header>
    <h3>{confluence.join(" × ")}</h3>
    {opportunity.setups.length > 1 && <p className="confluence-note">Confluence · {opportunity.setups.length} 套策略同向成立，已合併為一個機會</p>}
    <p className="opportunity-reason">{setup.reasons.slice(0, 2).join(" · ") || setup.trigger}</p>
    {pending.length > 0 && <p className="opportunity-missing"><b>待完成：</b>{pending.join("；")}</p>}
    {missing.length > 0 && <p className="opportunity-missing"><b>missing：</b>{missing.join("；")}</p>}
    <div className="opportunity-levels">
      <span>Entry<b>{formatPrice(setup.entryLow)}–{formatPrice(setup.entryHigh)}</b></span>
      <span>Stop<b>{formatPrice(setup.stop)}</b></span>
      <span>TP1 / TP2 / TP3<b>{formatPrice(setup.tp1)} / {formatPrice(setup.tp2)} / {formatPrice(setup.tp3)}</b><small>{rr(setup.riskRewardTp1)} / {rr(setup.riskRewardTp2)} / {rr(setup.riskRewardTp3)}</small></span>
      <span>{setup.primaryTarget ?? "主要目標"} 淨 RR<b className={(setup.primaryRiskReward ?? 0) >= 2 ? "positive" : ""}>{rr(setup.primaryRiskReward)}</b><small>{setup.grade ?? "未分級"} · 已扣來回費用與滑價</small></span>
    </div>
    <p className="opportunity-invalidation"><b>失效：</b>{setup.invalidation}</p>
    <footer>
      <span>{new Date(setup.updatedAt).toLocaleTimeString("zh-TW", { hour12: false })} · 品質信心 {setup.confidence}% · {setup.source}</span>
      <div>
        <button type="button" onClick={() => actions.onOpenChart(setup.symbol, setup.timeframe, setup.strategy)}>開啟圖表</button>
        {actions.onCreateAlert && <button type="button" onClick={() => actions.onCreateAlert?.(setup)}>建立警報</button>}
        {actions.onToggleWatchlist && <button type="button" aria-pressed={watchlist.includes(setup.symbol)} onClick={() => actions.onToggleWatchlist?.(setup.symbol)}>{watchlist.includes(setup.symbol) ? "★ 已觀察" : "☆ 加入觀察"}</button>}
      </div>
    </footer>
  </article>;
}

function ConditionChecklist({ setup, limit }: { setup: StrategyResult; limit?: number }) {
  const conditions = [...setup.hardConditions, ...setup.bonusConditions];
  const rows = typeof limit === "number" ? conditions.slice(0, limit) : conditions;
  return <ul className="checklist condition-checklist">{rows.map((condition) => <li className={condition.state === "met" ? "done" : condition.state === "missing" ? "missing" : ""} key={`${condition.kind}-${condition.id}`}>{condition.state === "met" ? "✓" : condition.state === "missing" ? "? missing" : "—"} <b>{condition.kind === "hard" ? "硬" : "加分"}</b> · {condition.label}</li>)}</ul>;
}

export function CockpitView({ data, watchlist, onNavigate, onOpenChart, onCreateAlert, onToggleWatchlist }: { data: MarketHubPayload; watchlist: string[]; onNavigate: (view: string) => void } & OpportunityActions) {
  const prioritized = cockpitAssets(data.assets, watchlist);
  const grouped = groupOpportunitySetups(prioritized.flatMap((asset) => asset.strategies));
  const opportunities = grouped.opportunities.slice(0, 5);
  const strategyStates = STRATEGY_NAMES.map((name) => ({ name, best: rankSetups(data.assets.flatMap((asset) => asset.strategies).filter((setup) => setup.strategy === name))[0] ?? null }));
  const primaryLevels = prioritized[0]?.sessionLevels.slice(0, 8) ?? [];
  const cockpitEvents = data.recentEvents.filter((event) => event.kind !== "funding_anomaly" && event.kind !== "oi_anomaly").slice(0, 6);
  const btc = data.assets.find((asset) => asset.symbol === "BTCUSDT");
  const eth = data.assets.find((asset) => asset.symbol === "ETHUSDT");
  const noTrade = opportunities.length === 0;
  const actions = { onOpenChart, onCreateAlert, onToggleWatchlist };
  return <div className="view-stack command-center">
    <section className="cockpit-heading view-heading command-hero">
      <div><p>TRADING OVERVIEW</p><h1>交易總攬<br /><i>{noTrade ? "目前不適合交易。" : "只做結構與空間都足夠的機會。"}</i></h1></div>
      <button type="button" onClick={() => onNavigate("scanner")}>開啟完整掃描器 <span>↗</span></button>
    </section>

    <section className="today-status-grid">
      <article className={`today-regime ${noTrade ? "no-trade" : ""}`}><span>今日市場狀態</span><strong>{regimeLabels[data.regime] ?? data.regime}</strong><p>{data.breadth.total ? `${data.breadth.advancing}/${data.breadth.total} 檔上漲` : "Breadth N/A"} · {data.pipeline.stage === "showing-stale" ? "稍早資料" : "OKX 即時"}</p></article>
      <SessionTimeCard session={data.session} />
      <AssetQuoteCard asset={btc} ticker="BTC" />
      <AssetQuoteCard asset={eth} ticker="ETH" />
    </section>

    <section className="command-split">
      <article className="terminal-panel"><div className="panel-heading"><div><p>WHAT JUST HAPPENED</p><h2>剛剛發生什麼</h2></div></div>
        {/* Scroll regions need keyboard focus even though they are not controls. */}
        {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
        <div className="event-timeline compact-scroll-region" role="region" aria-label="最近市場事件，顯示兩筆，可捲動查看更多" tabIndex={0}>{cockpitEvents.length ? cockpitEvents.map((event) => <button type="button" key={event.id} onClick={() => onOpenChart(event.symbol, event.kind === "bb_expansion" ? "15m" : "5m")}><i className={event.direction.toLowerCase()} /><span><b>{event.headline}</b><small>{event.detail}</small></span><time>{new Date(event.occurredAt).toLocaleTimeString("zh-TW", { hour12: false })}</time></button>) : <div className="inline-empty">最近已收盤 K 線沒有確認 sweep、BOS／MSS 或 BB 擴張。</div>}</div>
      </article>
      <article className="terminal-panel"><div className="panel-heading"><div><p>SESSION LEVELS</p><h2>{prioritized[0]?.symbol.replace("USDT", "") ?? "市場"} 重要價位</h2></div></div>
        {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
        <div className="session-level-grid compact-scroll-region" role="region" aria-label="重要價位，顯示兩個，可捲動查看更多" tabIndex={0}>{primaryLevels.length ? primaryLevels.map((level) => <span key={level.id}><small>{level.label}</small><b>{formatPrice(level.price)}</b></span>) : <div className="inline-empty">Session levels 資料不足；不補成 0。</div>}</div>
      </article>
    </section>

    <section className="terminal-panel opportunity-panel-v13"><div className="panel-heading"><div><p>BEST OPPORTUNITIES</p><h2>最佳機會 · 最多 5 個</h2></div></div>
      {grouped.conflicts.length > 0 && <div className="signal-conflicts" role="status"><b>訊號衝突／不交易</b>{grouped.conflicts.map((conflict) => <p key={conflict.symbol}>{conflict.symbol.replace("USDT", "")} · {conflict.long.map((item) => strategyLabels[item.strategy]).join("＋")} 偏多 vs {conflict.short.map((item) => strategyLabels[item.strategy]).join("＋")} 偏空；已合併排除，不重複列出。</p>)}</div>}
      <div className="opportunity-grid-v13">{opportunities.length ? opportunities.map((opportunity) => <OpportunityCard key={opportunity.id} opportunity={opportunity} watchlist={watchlist} actions={actions} />) : <div className="no-trade-decision"><b>目前沒有值得交易的設定</b><p>沒有不衝突的策略同時具備真實結構空間與至少 1.5 的淨 RR。等待也是交易決策。</p></div>}</div>
    </section>

    <section className="terminal-panel strategy-status-board"><div className="panel-heading"><div><p>THREE PLAYBOOKS</p><h2>三套策略現在適合嗎</h2></div></div>
      <div>{strategyStates.map(({ name, best }, index) => <article key={name}><header><b>0{index + 1} · {strategyLabels[name]}</b>{best ? <StatePill state={best.status} /> : <StatePill state="missing" />}</header><p>{best ? `${best.symbol.replace("USDT", "")} · ${best.timeframe} · ${directionLabels[best.direction]}${best.submodel ? ` · ${best.submodel === "Reversal" ? "反轉" : "延續"}` : ""}` : "資料不足"}</p><small>{best?.missingData[0] ? `missing：${best.missingData[0]}` : best?.pendingConditions[0] ?? best?.reasons[0] ?? strategyTips[name]}</small></article>)}</div>
    </section>
  </div>;
}

export function ScannerView({ data, minimumNetRr = 1.5, onOpenChart }: { data: MarketHubPayload; watchlist: string[]; minimumNetRr?: number; onOpenChart: OpenChart }) {
  const [search, setSearch] = useState("");
  const [timeframe, setTimeframe] = useState<Timeframe | "All">("All");
  const [strategy, setStrategy] = useState<StrategyName | "All">("All");
  const [direction, setDirection] = useState("All");
  const grouped = useMemo(() => groupOpportunitySetups(data.assets.flatMap((asset) => asset.strategies).filter((setup) =>
    setup.symbol.toLowerCase().includes(search.toLowerCase()) &&
    (timeframe === "All" || setup.timeframe === timeframe) && (strategy === "All" || setup.strategy === strategy) &&
    (direction === "All" || setup.direction === direction),
  ), minimumNetRr), [data.assets, direction, minimumNetRr, search, strategy, timeframe]);
  const assetMap = useMemo(() => new Map(data.assets.map((asset) => [asset.symbol, asset])), [data.assets]);
  return <div className="view-stack"><ViewTitle eyebrow="OPPORTUNITY SCANNER" title="先看真實空間，再談方向。" copy="只列硬條件完整且淨 RR 至少 1.5 的機會；1.5–2R 為 B 級、≥2R 為 A 級，兩者皆可執行。加分條件只影響品質信心。" />
    <section className="filter-bar"><label>搜尋<input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="BTC, ETH, SOL…" /></label><label>週期<select value={timeframe} onChange={(event) => setTimeframe(event.target.value as Timeframe | "All")}><option value="All">全部</option>{TIMEFRAMES.map((item) => <option key={item}>{item}</option>)}</select></label><label>策略<select value={strategy} onChange={(event) => setStrategy(event.target.value as StrategyName | "All")}><option value="All">全部</option>{STRATEGY_NAMES.map((item) => <option key={item} value={item}>{strategyLabels[item]}</option>)}</select></label><label>方向<select value={direction} onChange={(event) => setDirection(event.target.value)}><option value="All">全部</option><option value="Long">偏多</option><option value="Short">偏空</option><option value="Neutral">中性</option></select></label><span>{grouped.opportunities.length} 個結果</span></section>
    {grouped.conflicts.length > 0 && <div className="signal-conflicts" role="status"><b>訊號衝突／不交易</b>{grouped.conflicts.map((conflict) => <p key={conflict.symbol}>{conflict.symbol.replace("USDT", "")} · 多空可執行策略同時成立，已合併排除。</p>)}</div>}
    <section className="scanner-table"><div className="scanner-row scanner-head"><span>幣種／週期</span><span>價格／24h</span><span>策略／方向</span><span>狀態</span><span>Entry／Stop</span><span>TP1／2／3</span><span>淨 RR</span><span>品質信心</span></div>{grouped.opportunities.map((opportunity) => {
      const setup = opportunity.primary;
      const asset = assetMap.get(opportunity.symbol);
      if (!asset) return null;
      return <button className="scanner-row" key={opportunity.id} type="button" onClick={() => onOpenChart(asset.symbol, setup.timeframe, setup.strategy)}><span data-label="幣種／週期" className="symbol-cell"><b>{asset.symbol.replace("USDT", "")} · {setup.timeframe}</b><small>{new Date(setup.updatedAt).toLocaleTimeString("zh-TW", { hour12: false })} · {stateLabels[asset.price.state]}</small></span><span data-label="價格／24h"><b>{formatPrice(asset.price.value)}</b><small className={tone(asset.change24h.value)}>{formatPercent(asset.change24h.value)}</small></span><span data-label="策略／方向">{opportunity.setups.map((item) => strategyLabels[item.strategy]).join(" × ")}<small>{directionLabels[setup.direction]} · {opportunity.setups.length > 1 ? `Confluence ${opportunity.setups.length}` : setup.submodel ? (setup.submodel === "Reversal" ? "反轉模型" : "延續模型") : "單策略"}</small></span><span data-label="狀態"><StatePill state={setup.status} /><small>{setup.grade}級 · 硬條件 {setup.hardConditionsMet}/{setup.hardConditionsTotal}</small></span><span data-label="Entry／Stop"><b>{formatPrice(setup.entryLow)}–{formatPrice(setup.entryHigh)}</b><small>Stop {formatPrice(setup.stop)}</small></span><span data-label="TP1／2／3"><b>{formatPrice(setup.tp1)} / {formatPrice(setup.tp2)} / {formatPrice(setup.tp3)}</b><small>{rr(setup.riskRewardTp1)} / {rr(setup.riskRewardTp2)} / {rr(setup.riskRewardTp3)}</small></span><span data-label="淨 RR"><b>{rr(setup.primaryRiskReward)}</b><small>{setup.primaryTarget ?? "N/A"}</small></span><span data-label="品質信心" className="confidence-cell"><b>{setup.confidence}%</b><i style={{ width: `${setup.confidence}%` }} /></span></button>;
    })}</section>
    {!grouped.opportunities.length && <div className="no-trade-decision"><b>目前沒有值得交易的設定</b><p>沒有不衝突的結果通過目前的硬條件與淨 RR 門檻。等待也是交易決策。</p></div>}
  </div>;
}

export function WatchlistView({ data, watchlist, onOpenChart, onToggleWatchlist }: { data: MarketHubPayload; watchlist: string[]; onOpenChart: OpenChart; onToggleWatchlist: (symbol: string) => void }) {
  const assets = prioritizeByWatchlist(data.assets, watchlist).filter((asset) => watchlist.includes(asset.symbol));
  return <div className="view-stack"><ViewTitle eyebrow="WATCHLIST" title="只追蹤你真的會看的市場。" copy="觀察清單保留在私人同步或此裝置；價格、籌碼與策略缺值一律顯示 N/A。" />
    {assets.length ? <section className="watchlist-board">{assets.map((asset) => {
      const setup = asset.setup;
      const pressure = asset.positioning?.value ?? null;
      const liquidations = asset.liquidations?.value;
      return <article key={asset.symbol} className="watchlist-market-card"><header><div><span>{asset.name}</span><h2>{asset.symbol.replace("USDT", "/USDT")}</h2></div><button type="button" aria-label={`從觀察清單移除 ${asset.symbol}`} onClick={() => onToggleWatchlist(asset.symbol)}>★</button></header><div className="watchlist-quote"><b>{formatPrice(asset.price.value)}</b><em className={tone(asset.change24h.value)}>{formatPercent(asset.change24h.value)}</em></div><dl><div><dt>大戶籌碼壓力</dt><dd className={tone(pressure)}>{pressure === null ? "N/A" : `${pressure > 0 ? "+" : ""}${pressure}`}</dd></div><div><dt>公開強平樣本</dt><dd>{liquidations ? `${liquidations.eventCount} 筆 · ${compactMoney(liquidations.totalNotionalUsd)}` : "N/A"}</dd></div><div><dt>最佳策略</dt><dd>{setup ? `${strategyLabels[setup.strategy]} · ${stateLabels[setup.status]}` : "No Trade"}</dd></div><div><dt>淨 RR</dt><dd>{setup ? rr(setup.primaryRiskReward) : "N/A"}</dd></div></dl><button className="secondary-terminal-button" type="button" onClick={() => onOpenChart(asset.symbol, setup?.timeframe, setup?.strategy)}>開啟圖表與決策 →</button></article>;
    })}</section> : <EmptyState title="觀察清單目前是空的" copy="可從交易總攬的機會卡加入，或到設定選擇要追蹤的幣種。" />}
  </div>;
}

export function DerivativesView({ data }: { data: MarketHubPayload }) {
  const [tab, setTab] = useState<"positioning" | "liquidations" | "volatility" | "breadth">("positioning");
  const withFunding = data.assets.filter((asset) => asset.funding.value !== null);
  const withOi = data.assets.filter((asset) => asset.oiChange1h.value !== null);
  const withPositioning = data.assets.filter((asset) => asset.positioning.value !== null);
  const liquidationWindows = data.assets.map((asset) => asset.liquidations?.value).filter((item) => item !== null && item !== undefined);
  const liquidationEvents = liquidationWindows.flatMap((item) => item.events).sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  const knownLiquidations = liquidationEvents.filter((event) => event.notionalUsd !== null);
  const longLiquidations = knownLiquidations.filter((event) => event.positionSide === "Long").reduce((sum, event) => sum + event.notionalUsd!, 0);
  const shortLiquidations = knownLiquidations.filter((event) => event.positionSide === "Short").reduce((sum, event) => sum + event.notionalUsd!, 0);
  const highVolatility = data.assets.filter((asset) => asset.timeframes["1h"].volatility.value === "High").length;
  return <div className="view-stack"><ViewTitle eyebrow="MARKET DATA" title="市場數據要能解釋，也要承認看不到的部分。" copy="全部來自免費公開資料。籌碼壓力是相對偏離估算；強平為 OKX 已成交公開事件，不是未來清算地圖。" />
    <section className="derivative-summary"><article><span>Funding 異常</span><b>{withFunding.length ? withFunding.filter((asset) => Math.abs(asset.funding.value!) >= 0.0005).length : "—"}</b><small>絕對值 ≥ 0.05%</small></article><article><span>OI 1h 增加</span><b>{withOi.length ? withOi.filter((asset) => asset.oiChange1h.value! > 0).length : "—"}</b><small>有效樣本 {withOi.length}</small></article><article><span>大戶壓力極端</span><b>{withPositioning.length ? withPositioning.filter((asset) => Math.abs(asset.positioning.value!) >= 60).length : "—"}</b><small>相對分數，非持倉集中度</small></article><article><span>1h 高波動</span><b>{data.assets.length ? highVolatility : "—"}</b><small>共 {data.assets.length} 個市場</small></article></section>
    <div className="market-data-tabs" role="group" aria-label="市場數據分類">{([['positioning','大戶籌碼壓力'],['liquidations','強平監測'],['volatility','波動雷達'],['breadth','市場廣度']] as const).map(([id, label]) => <button type="button" aria-pressed={tab === id} className={tab === id ? "active" : ""} key={id} onClick={() => setTab(id)}>{label}</button>)}</div>
    {tab === "positioning" && <section className="position-table market-position-table"><div className="position-row position-head"><span>幣種</span><span>全體帳戶</span><span>大戶帳戶</span><span>大戶持倉</span><span>壓力分數</span><span>Funding</span><span>OI 1h</span></div>{data.assets.map((asset) => <div className="position-row" key={asset.symbol}><b data-label="幣種">{asset.symbol.replace("USDT", "")}</b><span data-label="全體帳戶">{asset.globalRatio.value?.toFixed(2) ?? "N/A"}</span><span data-label="大戶帳戶">{asset.topRatio.value?.toFixed(2) ?? "N/A"}</span><span data-label="大戶持倉">{asset.topPositionRatio?.value?.toFixed(2) ?? "N/A"}</span><span data-label="壓力分數" className={tone(asset.positioning.value)}><b>{asset.positioning.value === null ? "N/A" : `${asset.positioning.value > 0 ? "+" : ""}${asset.positioning.value}`}</b><small>{asset.positioning.value === null ? "資料不足" : asset.positioning.value > 15 ? "相對偏多" : asset.positioning.value < -15 ? "相對偏空" : "接近常態"}</small></span><span data-label="Funding">{asset.funding.value === null ? "N/A" : `${(asset.funding.value * 100).toFixed(4)}%`}</span><span data-label="OI 1h" className={tone(asset.oiChange1h.value)}>{formatPercent(asset.oiChange1h.value)}</span></div>)}</section>}
    {tab === "liquidations" && <section className="liquidation-layout"><div className="liquidation-summary"><article><span>公開事件</span><b>{liquidationWindows.length ? liquidationEvents.length : "—"}</b><small>{liquidationWindows.length} 個市場有回應</small></article><article><span>多單強平</span><b>{knownLiquidations.length ? compactMoney(longLiquidations) : "N/A"}</b><small>按合約規格換算</small></article><article><span>空單強平</span><b>{knownLiquidations.length ? compactMoney(shortLiquidations) : "N/A"}</b><small>按合約規格換算</small></article></div><article className="terminal-panel liquidation-feed"><div className="panel-heading"><div><p>FILLED LIQUIDATIONS</p><h2>最近公開強平事件</h2></div><span>最新 {Math.min(40, liquidationEvents.length)} 筆</span></div>{liquidationEvents.length ? <div className="liquidation-list" role="region" aria-label="最近強平事件">{liquidationEvents.slice(0, 40).map((event) => <div key={event.id}><span className={event.positionSide === "Long" ? "negative" : "positive"}>{event.positionSide === "Long" ? "多單強平" : "空單強平"}</span><b>{event.symbol.replace("USDT", "")}</b><span>{formatPrice(event.bankruptcyPrice)}</span><span>{event.notionalUsd === null ? `${compact(event.contracts)} 張` : compactMoney(event.notionalUsd)}</span><time>{new Date(event.occurredAt).toLocaleString("zh-TW", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })}</time></div>)}</div> : <div className="inline-empty">OKX 公開端點目前未返回事件，或資料暫時不可用；不顯示為 0。</div>}<p className="data-method-note">事件總額僅加總可依 OKX 合約面值換算的資料；這是最近回傳樣本，不代表固定 24 小時統計。</p></article></section>}
    {tab === "volatility" && <section className="position-table volatility-table"><div className="position-row position-head"><span>幣種</span><span>1h 漲跌</span><span>ATR / 價格</span><span>BB Width</span><span>成交量 Z</span><span>波動狀態</span><span>24h</span></div>{data.assets.map((asset) => { const tf = asset.timeframes["1h"]; const atrRatio = tf.atr.value !== null && asset.price.value ? tf.atr.value / asset.price.value * 100 : null; return <div className="position-row" key={asset.symbol}><b data-label="幣種">{asset.symbol.replace("USDT", "")}</b><span data-label="1h 漲跌" className={tone(asset.change1h.value)}>{formatPercent(asset.change1h.value)}</span><span data-label="ATR / 價格">{formatPercent(atrRatio)}</span><span data-label="BB Width">{tf.bollingerWidth.value === null ? "N/A" : `${(tf.bollingerWidth.value * 100).toFixed(2)}%`}</span><span data-label="成交量 Z">{tf.volumeZScore.value?.toFixed(2) ?? "N/A"}</span><span data-label="波動狀態">{tf.volatility.value === "High" ? "高波動" : tf.volatility.value === "Low" ? "低波動" : tf.volatility.value === "Normal" ? "正常" : "N/A"}</span><span data-label="24h" className={tone(asset.change24h.value)}>{formatPercent(asset.change24h.value)}</span></div>; })}</section>}
    {tab === "breadth" && <section className="breadth-board"><article className="breadth-hero"><span>目前市場狀態</span><b>{regimeLabels[data.regime] ?? data.regime}</b><p>{data.breadth.total ? `${data.breadth.advancing} 上漲 · ${data.breadth.declining} 下跌 · ${data.breadth.total} 有效樣本` : "Breadth N/A"}</p></article><div className="breadth-grid">{data.assets.map((asset) => <article key={asset.symbol}><header><b>{asset.symbol.replace("USDT", "")}</b><span className={tone(asset.change24h.value)}>{formatPercent(asset.change24h.value)}</span></header><p>{asset.timeframes["4h"].trend.value === "Trend Up" ? "4h 上升趨勢" : asset.timeframes["4h"].trend.value === "Trend Down" ? "4h 下降趨勢" : asset.timeframes["4h"].trend.value === "Range" ? "4h 區間" : "4h N/A"}</p></article>)}</div></section>}
  </div>;
}

type CrossMetric = "change24h" | "change1h" | "oiChange1h" | "positioning" | "funding" | "bbWidth";
const crossMetricLabels: Record<CrossMetric, string> = { change24h: "24h 漲跌", change1h: "1h 漲跌", oiChange1h: "OI 1h", positioning: "籌碼壓力", funding: "Funding", bbWidth: "1h BB Width" };

export function CrossSectionView({ data, onOpenChart }: { data: MarketHubPayload; onOpenChart: OpenChart }) {
  const [metricId, setMetricId] = useState<CrossMetric>("change24h");
  const rows = useMemo(() => data.assets.map((asset) => {
    const value = metricId === "bbWidth" ? asset.timeframes["1h"].bollingerWidth.value === null ? null : asset.timeframes["1h"].bollingerWidth.value! * 100
      : metricId === "funding" ? asset.funding.value === null ? null : asset.funding.value * 100
      : asset[metricId].value;
    return { asset, value };
  }).filter((row): row is { asset: MarketHubPayload["assets"][number]; value: number } => row.value !== null).sort((a, b) => b.value - a.value), [data.assets, metricId]);
  const maxAbs = Math.max(...rows.map((row) => Math.abs(row.value)), 1);
  return <div className="view-stack"><ViewTitle eyebrow="CROSS-SECTION" title="在 30 個市場裡找出真正的相對異常。" copy="這是同一時間點的橫截面比較，不是歷史回測；資料不足的市場不參與排名。" /><section className="cross-toolbar"><label>比較指標<select value={metricId} onChange={(event) => setMetricId(event.target.value as CrossMetric)}>{Object.entries(crossMetricLabels).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label><span>有效樣本 {rows.length}/{data.assets.length}</span></section>{rows.length ? <section className="cross-section-list">{rows.map((row, index) => { const percentile = rows.length === 1 ? 100 : Math.round((1 - index / (rows.length - 1)) * 100); return <button type="button" key={row.asset.symbol} onClick={() => onOpenChart(row.asset.symbol)}><span className="cross-rank">{String(index + 1).padStart(2, "0")}</span><b>{row.asset.symbol.replace("USDT", "")}</b><div><i className={tone(row.value)} style={{ width: `${Math.max(3, Math.abs(row.value) / maxAbs * 100)}%` }} /></div><strong className={tone(row.value)}>{metricId === "positioning" ? `${row.value > 0 ? "+" : ""}${row.value.toFixed(0)}` : `${row.value > 0 ? "+" : ""}${row.value.toFixed(metricId === "funding" ? 4 : 2)}%`}</strong><small>P{percentile}</small></button>; })}</section> : <EmptyState title="目前沒有可比較資料" copy="此指標的 30 個市場都缺少有效值，因此不建立排名。" />}</div>;
}

export function StrategyView({ data, onOpenChart }: { data: MarketHubPayload; onOpenChart: OpenChart }) {
  return <div className="view-stack"><ViewTitle eyebrow="STRATEGY DESK" title="只保留三套可驗證的日內策略。" copy="硬條件決定有效性；加分條件只提高品質信心，missing 不會被當成失敗或補成 0。所有策略使用已收盤 OKX K 線與結構目標。" /><section className="strategy-desk three-strategies">{STRATEGY_NAMES.map((name, index) => {
    const results = rankSetups(data.assets.flatMap((asset) => asset.strategies).filter((item) => item.strategy === name));
    const best = results[0];
    const executable = results.filter((item) => item.status === "executable").length;
    return <article className="terminal-panel" key={name}><div className="panel-heading"><div><p>STRATEGY 0{index + 1}</p><h2>{strategyLabels[name]}</h2></div><span>{executable} 個可執行</span></div><p className="plan-copy">{strategyTips[name]}</p>{best ? <><div className="mini-plan"><span className={`direction ${best.direction.toLowerCase()}`}>{directionLabels[best.direction]}</span><b>{best.symbol.replace("USDT", "")} · {best.timeframe}{best.submodel ? ` · ${best.submodel === "Reversal" ? "反轉" : "延續"}` : ""}</b><StatePill state={best.status} /><em>{best.grade ? `${best.grade} · ` : ""}{rr(best.primaryRiskReward)}</em></div><ConditionChecklist setup={best} limit={5} />{best.missingData.length > 0 && <p className="opportunity-missing"><b>missing：</b>{best.missingData.slice(0, 2).join("；")}</p>}<button className="secondary-terminal-button" type="button" onClick={() => onOpenChart(best.symbol, best.timeframe, best.strategy)}>查看圖表與計畫 →</button></> : <div className="inline-empty">資料不足，不做判定。</div>}</article>;
  })}</section></div>;
}

export function ChartView({ data, symbol, initialTimeframe, initialStrategy, watchlist, onSymbolChange, theme = "dark" }: { data: MarketHubPayload; symbol: string; initialTimeframe: Timeframe; initialStrategy: StrategyName | null; watchlist: string[]; onSymbolChange: (symbol: string) => void; theme?: "light" | "dark" }) {
  const asset = data.assets.find((item) => item.symbol === symbol) ?? data.assets[0];
  const [timeframe, setTimeframe] = useState<Timeframe>(initialTimeframe);
  const [strategy, setStrategy] = useState<StrategyName>(initialStrategy ?? "EMA Trend");
  if (!asset) return <EmptyState title="沒有圖表資料" copy="目前沒有可用行情，請稍後重新整理。" />;
  const setup = asset.strategies.find((item) => item.strategy === strategy) ?? null;
  const symbolOptions = prioritizeByWatchlist(data.assets, watchlist);
  return <div className="view-stack decision-view"><section className="view-title with-action"><div><p>CHART WORKSPACE</p><h1>{asset.symbol.replace("USDT", "/USDT")} 決策</h1><span>圖表與策略皆指定 OKX 永續；策略位只由 Market Data Hub 已收盤 K 線產生。</span></div><div className="chart-toolbar"><select aria-label="選擇幣種" value={asset.symbol} onChange={(event) => onSymbolChange(event.target.value)}>{symbolOptions.map((item) => <option key={item.symbol} value={item.symbol}>{watchlist.includes(item.symbol) ? `★ ${item.symbol}` : item.symbol}</option>)}</select><select aria-label="選擇圖表週期" value={timeframe} onChange={(event) => setTimeframe(event.target.value as Timeframe)}>{TIMEFRAMES.map((item) => <option key={item}>{item}</option>)}</select><select aria-label="選擇策略" value={strategy} onChange={(event) => { const next = event.target.value as StrategyName; setStrategy(next); const strategyTimeframe = asset.strategies.find((item) => item.strategy === next)?.timeframe; if (strategyTimeframe) setTimeframe(strategyTimeframe); }}>{STRATEGY_NAMES.map((item) => <option key={item} value={item}>{strategyLabels[item]}</option>)}</select></div></section>
    <section className="chart-layout decision-layout"><article className="terminal-panel chart-panel decision-tv-panel"><div className="chart-toolbar tv-toolbar"><p>TradingView · OKX:{asset.symbol}.P · {timeframe}</p></div><TradingViewWidget symbol={asset.symbol} timeframe={timeframe} theme={theme} height={560} /></article>
      <article className="terminal-panel strategy-plan decision-plan-card"><div className="panel-heading"><div><p>TRADE PLAN</p><h2>{setup ? `${strategyLabels[setup.strategy]}${setup.submodel ? ` · ${setup.submodel === "Reversal" ? "反轉模型" : "延續模型"}` : ""}` : "策略資料不足"}</h2></div>{setup && <StatePill state={setup.status} />}</div>{setup ? <><div className="plan-regime"><span className={`direction ${setup.direction.toLowerCase()}`}>{directionLabels[setup.direction]}</span><b>{setup.timeframe}</b><em>硬 {setup.hardConditionsMet}/{setup.hardConditionsTotal} · 加分 {setup.bonusConditionsMet}/{setup.bonusConditionsTotal}</em></div><div className="plan-levels"><span>進場區<b>{formatPrice(setup.entryLow)}–{formatPrice(setup.entryHigh)}</b><small>最不利邊界計算</small></span><span>結構 Stop<b>{formatPrice(setup.stop)}</b><small>ATR 只作結構外緩衝</small></span><span>TP1 / TP2 / TP3<b>{formatPrice(setup.tp1)} / {formatPrice(setup.tp2)} / {formatPrice(setup.tp3)}</b><small>淨 RR {rr(setup.riskRewardTp1)} / {rr(setup.riskRewardTp2)} / {rr(setup.riskRewardTp3)}</small></span><span>{setup.primaryTarget ?? "主要目標"} 淨 RR<b>{rr(setup.primaryRiskReward)}</b><small>{setup.grade ? `${setup.grade}級 · ` : ""}手續費 {(setup.feeRate * 100).toFixed(3)}%／邊 · 滑價 {(setup.slippageRate * 100).toFixed(3)}%／邊</small></span></div><p className="plan-copy"><b>何時成立：</b>{setup.trigger}</p><p className="plan-copy"><b>何時失效：</b>{setup.invalidation}</p><p className="plan-copy"><b>目標依據：</b>{setup.targetBasis}</p><ConditionChecklist setup={setup} />{setup.missingData.length > 0 && <p className="opportunity-missing"><b>missing：</b>{setup.missingData.join("；")}</p>}<div className="formula-note"><b>策略說明</b><p>{strategyTips[setup.strategy]}</p><small>Confidence 只反映品質；未通過硬條件時不能變成可執行。</small></div></> : <div className="inline-empty">目前資料不足，先不產生計畫。</div>}</article>
    </section></div>;
}

export function ViewTitle({ eyebrow, title, copy }: { eyebrow: string; title: string; copy: string }) { return <section className="view-title"><p>{eyebrow}</p><h1>{title}</h1><span>{copy}</span></section>; }
export function EmptyState({ title, copy, actionLabel, onAction }: { title: string; copy: string; actionLabel?: string; onAction?: () => void }) { return <div className="empty-state"><span>—</span><h2>{title}</h2><p>{copy}</p>{actionLabel && onAction && <button className="secondary-terminal-button" type="button" onClick={onAction}>{actionLabel}</button>}</div>; }
