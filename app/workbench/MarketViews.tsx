"use client";

import { useMemo, useState } from "react";
import {
  STRATEGY_NAMES,
  TIMEFRAMES,
  type AssetSnapshot,
  type MarketHubPayload,
  type StrategyName,
  type StrategyResult,
  type StrategyStatus,
  type Timeframe,
} from "../../lib/market/types";
import { cockpitAssets, prioritizeByWatchlist, watchlistAssets } from "../../lib/workbench/watchlist";
import TradingViewWidget from "./TradingViewWidget";

export type OpenChart = (symbol: string, timeframe?: Timeframe, strategy?: StrategyName) => void;
export type OpportunityActions = {
  onOpenChart: OpenChart;
  onCreateAlert?: (setup: StrategyResult) => void;
  onToggleWatchlist?: (symbol: string) => void;
};

export const strategyTips: Record<StrategyName, string> = {
  "EMA Trend": "1H／4H EMA20、EMA50 與斜率先決定 Bias；15m 回踩重新站穩後，再等 5m 結構確認。",
  "Bollinger Breakout": "BB Width 先落到歷史低百分位再擴張；收盤突破、成交量確認，並優先等回測而非追價。",
  "ICT / SMC": "只接受 Sweep → Displacement → MSS/BOS → FVG/OB 回踩的先後順序，並以 1H／4H Bias 過濾。",
};
export const strategyLabels: Record<StrategyName, string> = {
  "EMA Trend": "均線順勢",
  "Bollinger Breakout": "布林帶波動突破",
  "ICT / SMC": "ICT／SMC",
};
const stateLabels: Record<string, string> = {
  live: "即時", stale: "稍早資料", missing: "資料不足", eligible: "可執行",
  waiting: "形成中／觀察", applicable: "適用", invalid: "失效／淘汰",
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
function tone(value: number | null) { return value === null ? "missing" : value >= 0 ? "positive" : "negative"; }
function StatePill({ state }: { state: string }) { return <span className={`metric-state ${state}`}>{stateLabels[state] ?? state}</span>; }
function rr(value: number | null) { return value === null ? "N/A" : `${value.toFixed(2)}R`; }

function rankSetups(setups: StrategyResult[]) {
  const rank: Record<StrategyStatus, number> = { eligible: 5, waiting: 4, applicable: 3, invalid: 2, missing: 1 };
  return [...setups].sort((a, b) => rank[b.status] - rank[a.status] || (b.primaryRiskReward ?? -1) - (a.primaryRiskReward ?? -1) || b.confidence - a.confidence);
}

function OpportunityCard({ setup, watchlist, actions }: { setup: StrategyResult; watchlist: string[]; actions: OpportunityActions }) {
  const missing = setup.missingConditions.slice(0, 2);
  return <article className="opportunity-card-v13">
    <header>
      <div><span className={`direction ${setup.direction.toLowerCase()}`}>{directionLabels[setup.direction]}</span><b>{setup.symbol.replace("USDT", "")} · {setup.timeframe}</b></div>
      <StatePill state={setup.status} />
    </header>
    <h3>{strategyLabels[setup.strategy]}</h3>
    <p className="opportunity-reason">{setup.reasons.slice(0, 2).join(" · ") || setup.trigger}</p>
    {missing.length > 0 && <p className="opportunity-missing"><b>仍缺：</b>{missing.join("；")}</p>}
    <div className="opportunity-levels">
      <span>Entry<b>{formatPrice(setup.entryLow)}–{formatPrice(setup.entryHigh)}</b></span>
      <span>Stop<b>{formatPrice(setup.stop)}</b></span>
      <span>TP1 / TP2 / TP3<b>{formatPrice(setup.tp1)} / {formatPrice(setup.tp2)} / {formatPrice(setup.tp3)}</b><small>{rr(setup.riskRewardTp1)} / {rr(setup.riskRewardTp2)} / {rr(setup.riskRewardTp3)}</small></span>
      <span>主要淨 RR<b className={(setup.primaryRiskReward ?? 0) >= 2 ? "positive" : ""}>{rr(setup.primaryRiskReward)}</b><small>已扣來回費用與滑價</small></span>
    </div>
    <p className="opportunity-invalidation"><b>失效：</b>{setup.invalidation}</p>
    <footer>
      <span>{new Date(setup.updatedAt).toLocaleTimeString("zh-TW", { hour12: false })} · 信心 {setup.confidence}% · OKX closed</span>
      <div>
        <button type="button" onClick={() => actions.onOpenChart(setup.symbol, setup.timeframe, setup.strategy)}>開啟圖表</button>
        {actions.onCreateAlert && <button type="button" onClick={() => actions.onCreateAlert?.(setup)}>建立警報</button>}
        {actions.onToggleWatchlist && <button type="button" aria-pressed={watchlist.includes(setup.symbol)} onClick={() => actions.onToggleWatchlist?.(setup.symbol)}>{watchlist.includes(setup.symbol) ? "★ 已觀察" : "☆ 加入觀察"}</button>}
      </div>
    </footer>
  </article>;
}

export function CockpitView({ data, watchlist, onNavigate, onOpenChart, onCreateAlert, onToggleWatchlist }: { data: MarketHubPayload; watchlist: string[]; onNavigate: (view: string) => void } & OpportunityActions) {
  const prioritized = cockpitAssets(data.assets, watchlist);
  const opportunities = rankSetups(prioritized.flatMap((asset) => asset.strategies).filter((setup) => setup.eligibleForScanner)).slice(0, 5);
  const strategyStates = STRATEGY_NAMES.map((name) => ({ name, best: rankSetups(data.assets.flatMap((asset) => asset.strategies).filter((setup) => setup.strategy === name))[0] ?? null }));
  const primaryLevels = prioritized[0]?.sessionLevels.slice(0, 8) ?? [];
  const noTrade = opportunities.length === 0;
  const actions = { onOpenChart, onCreateAlert, onToggleWatchlist };
  return <div className="view-stack command-center">
    <section className="cockpit-heading view-heading command-hero">
      <div><p>TRADING OVERVIEW</p><h1>交易總攬<br /><i>{noTrade ? "目前不適合交易。" : "只做結構與空間都足夠的機會。"}</i></h1></div>
      <button type="button" onClick={() => onNavigate("scanner")}>開啟完整掃描器 <span>↗</span></button>
    </section>

    <section className="today-status-grid">
      <article className={`today-regime ${noTrade ? "no-trade" : ""}`}><span>今日市場狀態</span><strong>{regimeLabels[data.regime] ?? data.regime}</strong><p>{data.breadth.total ? `${data.breadth.advancing}/${data.breadth.total} 檔上漲` : "Breadth N/A"} · {data.pipeline.stage === "showing-stale" ? "稍早資料" : "OKX 即時"}</p></article>
      <article><span>當前交易時段</span><strong>{data.session.label}</strong><p>{data.session.localTime}<br />{data.session.closesAt ? `結束 ${new Date(data.session.closesAt).toLocaleTimeString("zh-TW", { hour12: false, hour: "2-digit", minute: "2-digit", timeZone: data.session.timezone })} ${data.session.timezone}` : "等待下一個主要時段"}</p></article>
      <article><span>衍生品背景</span><strong>{data.riskAlerts.length ? `${data.riskAlerts.length} 項異常` : "未見明顯異常"}</strong><p>Funding／OI／Positioning 只確認背景，不單獨給方向。</p></article>
      <article><span>決策門檻</span><strong>1.5R 觀察 · 2R 執行</strong><p>淨值已扣雙邊手續費與滑價，不人工拉遠目標。</p></article>
    </section>

    <section className="command-split">
      <article className="terminal-panel"><div className="panel-heading"><div><p>WHAT JUST HAPPENED</p><h2>剛剛發生什麼</h2></div></div>
        <div className="event-timeline">{data.recentEvents.length ? data.recentEvents.slice(0, 6).map((event) => <button type="button" key={event.id} onClick={() => onOpenChart(event.symbol, event.kind === "bb_expansion" ? "15m" : "5m")}><i className={event.direction.toLowerCase()} /><span><b>{event.headline}</b><small>{event.detail}</small></span><time>{new Date(event.occurredAt).toLocaleTimeString("zh-TW", { hour12: false })}</time></button>) : <div className="inline-empty">最近已收盤 K 線沒有確認 sweep、BOS/MSS、BB 擴張或衍生品異常。</div>}</div>
      </article>
      <article className="terminal-panel"><div className="panel-heading"><div><p>SESSION LEVELS</p><h2>{prioritized[0]?.symbol.replace("USDT", "") ?? "市場"} 重要價位</h2></div></div>
        <div className="session-level-grid">{primaryLevels.length ? primaryLevels.map((level) => <span key={level.id}><small>{level.label}</small><b>{formatPrice(level.price)}</b></span>) : <div className="inline-empty">Session levels 資料不足；不補成 0。</div>}</div>
      </article>
    </section>

    <section className="terminal-panel opportunity-panel-v13"><div className="panel-heading"><div><p>BEST OPPORTUNITIES</p><h2>最佳機會 · 最多 5 個</h2></div></div>
      <div className="opportunity-grid-v13">{opportunities.length ? opportunities.map((setup) => <OpportunityCard key={setup.id} setup={setup} watchlist={watchlist} actions={actions} />) : <div className="no-trade-decision"><b>等待也是交易決策</b><p>目前沒有策略同時具備真實結構空間與至少 1.5 的淨 RR。不要為了交易而交易。</p></div>}</div>
    </section>

    <section className="terminal-panel strategy-status-board"><div className="panel-heading"><div><p>THREE PLAYBOOKS</p><h2>三套策略現在適合嗎</h2></div></div>
      <div>{strategyStates.map(({ name, best }, index) => <article key={name}><header><b>0{index + 1} · {strategyLabels[name]}</b>{best ? <StatePill state={best.status} /> : <StatePill state="missing" />}</header><p>{best ? `${best.symbol.replace("USDT", "")} · ${best.timeframe} · ${directionLabels[best.direction]}` : "資料不足"}</p><small>{best?.missingConditions[0] ?? best?.reasons[0] ?? strategyTips[name]}</small></article>)}</div>
    </section>
  </div>;
}

type ScannerRow = { asset: AssetSnapshot; setup: StrategyResult };
export function ScannerView({ data, watchlist, minimumNetRr = 1.5, onOpenChart }: { data: MarketHubPayload; watchlist: string[]; minimumNetRr?: number; onOpenChart: OpenChart }) {
  const [search, setSearch] = useState("");
  const [timeframe, setTimeframe] = useState<Timeframe | "All">("All");
  const [strategy, setStrategy] = useState<StrategyName | "All">("All");
  const [direction, setDirection] = useState("All");
  const [status, setStatus] = useState<StrategyStatus | "All">("All");
  const [minimumConfidence, setMinimumConfidence] = useState(45);
  const [minimumRr, setMinimumRr] = useState(Math.max(1.5, minimumNetRr));
  const [onlyWatchlist, setOnlyWatchlist] = useState(false);
  const rows = useMemo(() => watchlistAssets(data.assets, watchlist, onlyWatchlist).flatMap((asset) => asset.strategies.map((setup): ScannerRow => ({ asset, setup }))).filter(({ asset, setup }) =>
    asset.symbol.toLowerCase().includes(search.toLowerCase()) &&
    (timeframe === "All" || setup.timeframe === timeframe) && (strategy === "All" || setup.strategy === strategy) &&
    (direction === "All" || setup.direction === direction) && (status === "All" || setup.status === status) &&
    setup.confidence >= minimumConfidence && (setup.primaryRiskReward ?? -Infinity) >= minimumRr,
  ).sort((a, b) => (Number(b.setup.status === "eligible") - Number(a.setup.status === "eligible")) || (b.setup.primaryRiskReward ?? 0) - (a.setup.primaryRiskReward ?? 0) || b.setup.confidence - a.setup.confidence), [data.assets, direction, minimumConfidence, minimumRr, onlyWatchlist, search, status, strategy, timeframe, watchlist]);
  return <div className="view-stack"><ViewTitle eyebrow="OPPORTUNITY SCANNER" title="先看真實空間，再談方向。" copy="只掃描三套策略。預設最低淨 RR 1.5；不足者不進榜，1.5–2R 只觀察，≥2R 且條件完整才可執行。" />
    <section className="filter-bar"><label>搜尋<input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="BTC, ETH, SOL…" /></label><label>週期<select value={timeframe} onChange={(event) => setTimeframe(event.target.value as Timeframe | "All")}><option value="All">全部</option>{TIMEFRAMES.map((item) => <option key={item}>{item}</option>)}</select></label><label>策略<select value={strategy} onChange={(event) => setStrategy(event.target.value as StrategyName | "All")}><option value="All">全部</option>{STRATEGY_NAMES.map((item) => <option key={item} value={item}>{strategyLabels[item]}</option>)}</select></label><label>方向<select value={direction} onChange={(event) => setDirection(event.target.value)}><option value="All">全部</option><option value="Long">偏多</option><option value="Short">偏空</option><option value="Neutral">中性</option></select></label><label>狀態<select value={status} onChange={(event) => setStatus(event.target.value as StrategyStatus | "All")}><option value="All">全部</option><option value="eligible">可執行</option><option value="waiting">形成中／觀察</option><option value="applicable">適用</option><option value="invalid">失效／淘汰</option><option value="missing">資料不足</option></select></label><label>最低信心<input type="number" min="0" max="100" value={minimumConfidence} onChange={(event) => setMinimumConfidence(Number(event.target.value))} /></label><label>最低淨 RR<input type="number" min="1.5" step="0.25" value={minimumRr} onChange={(event) => setMinimumRr(Math.max(1.5, Number(event.target.value)))} /></label><button className={onlyWatchlist ? "watchlist-filter active" : "watchlist-filter"} type="button" aria-pressed={onlyWatchlist} onClick={() => setOnlyWatchlist((current) => !current)}>★ 只看自選</button><span>{rows.length} 個結果</span></section>
    {onlyWatchlist && watchlist.length === 0 && <div className="watchlist-empty">自選清單是空的。請先到「設定」加入幣種。</div>}
    <section className="scanner-table"><div className="scanner-row scanner-head"><span>幣種／週期</span><span>價格／24h</span><span>策略／方向</span><span>狀態</span><span>Entry／Stop</span><span>TP1／2／3</span><span>淨 RR</span><span>信心</span></div>{rows.map(({ asset, setup }) => <button className="scanner-row" key={setup.id} type="button" onClick={() => onOpenChart(asset.symbol, setup.timeframe, setup.strategy)}><span data-label="幣種／週期" className="symbol-cell"><b>{asset.symbol.replace("USDT", "")} · {setup.timeframe}</b><small>{new Date(setup.updatedAt).toLocaleTimeString("zh-TW", { hour12: false })} · {stateLabels[asset.price.state]}</small></span><span data-label="價格／24h"><b>{formatPrice(asset.price.value)}</b><small className={tone(asset.change24h.value)}>{formatPercent(asset.change24h.value)}</small></span><span data-label="策略／方向">{strategyLabels[setup.strategy]}<small>{directionLabels[setup.direction]}</small></span><span data-label="狀態"><StatePill state={setup.status} /><small>{setup.conditionsMet}/{setup.conditionsTotal} 條件</small></span><span data-label="Entry／Stop"><b>{formatPrice(setup.entryLow)}–{formatPrice(setup.entryHigh)}</b><small>Stop {formatPrice(setup.stop)}</small></span><span data-label="TP1／2／3"><b>{formatPrice(setup.tp1)} / {formatPrice(setup.tp2)} / {formatPrice(setup.tp3)}</b><small>{rr(setup.riskRewardTp1)} / {rr(setup.riskRewardTp2)} / {rr(setup.riskRewardTp3)}</small></span><span data-label="淨 RR"><b>{rr(setup.primaryRiskReward)}</b><small>{setup.primaryTarget ?? "N/A"}</small></span><span data-label="信心" className="confidence-cell"><b>{setup.confidence}%</b><i style={{ width: `${setup.confidence}%` }} /></span></button>)}</section>
    {!rows.length && <div className="no-trade-decision"><b>目前不適合交易</b><p>沒有結果通過目前的淨 RR 與條件篩選。等待也是交易決策。</p></div>}
  </div>;
}

export function DerivativesView({ data }: { data: MarketHubPayload }) {
  const withFunding = data.assets.filter((asset) => asset.funding.value !== null);
  const withOi = data.assets.filter((asset) => asset.oiChange1h.value !== null);
  const withPositioning = data.assets.filter((asset) => asset.positioning.value !== null);
  return <div className="view-stack"><ViewTitle eyebrow="DERIVATIVES" title="衍生品只做背景，不做第四套策略。" copy="OKX Funding、OI、全體／大戶帳戶比與 Positioning 不會單獨產生方向；缺值保留 N/A。" />
    <section className="derivative-summary"><article><span>Funding 異常</span><b>{withFunding.length ? withFunding.filter((asset) => Math.abs(asset.funding.value!) >= 0.0005).length : "—"}</b><small>絕對值 ≥ 0.05%</small></article><article><span>OI 1h 增加</span><b>{withOi.length ? withOi.filter((asset) => asset.oiChange1h.value! > 0).length : "—"}</b><small>樣本 {withOi.length}</small></article><article><span>帳戶傾向極端</span><b>{withPositioning.length ? withPositioning.filter((asset) => Math.abs(asset.positioning.value!) >= 60).length : "—"}</b><small>非真實持倉集中度</small></article></section>
    <section className="position-table"><div className="position-row position-head"><span>幣種</span><span>Funding</span><span>未平倉量</span><span>OI 1h</span><span>全體多空比</span><span>大戶多空比</span><span>傾向分數</span></div>{data.assets.map((asset) => <div className="position-row" key={asset.symbol}><b data-label="幣種">{asset.symbol.replace("USDT", "")}</b><span data-label="Funding">{asset.funding.value === null ? "N/A" : `${(asset.funding.value * 100).toFixed(4)}%`}</span><span data-label="未平倉量">{compact(asset.openInterest.value)}</span><span data-label="OI 1h" className={tone(asset.oiChange1h.value)}>{formatPercent(asset.oiChange1h.value)}</span><span data-label="全體多空比">{asset.globalRatio.value?.toFixed(2) ?? "N/A"}</span><span data-label="大戶多空比">{asset.topRatio.value?.toFixed(2) ?? "N/A"}</span><span data-label="傾向分數" className={tone(asset.positioning.value)}>{asset.positioning.value?.toFixed(1) ?? "N/A"}</span></div>)}</section>
  </div>;
}

export function StrategyView({ data, onOpenChart }: { data: MarketHubPayload; onOpenChart: OpenChart }) {
  return <div className="view-stack"><ViewTitle eyebrow="STRATEGY DESK" title="只保留三套可驗證的日內策略。" copy="Funding、OI 與 Positioning 僅作背景；每套策略都以已收盤 OKX K 線與結構目標計算。" /><section className="strategy-desk three-strategies">{STRATEGY_NAMES.map((name, index) => {
    const results = rankSetups(data.assets.flatMap((asset) => asset.strategies).filter((item) => item.strategy === name));
    const best = results[0];
    const executable = results.filter((item) => item.status === "eligible").length;
    return <article className="terminal-panel" key={name}><div className="panel-heading"><div><p>STRATEGY 0{index + 1}</p><h2>{strategyLabels[name]}</h2></div><span>{executable} 個可執行</span></div><p className="plan-copy">{strategyTips[name]}</p>{best ? <><div className="mini-plan"><span className={`direction ${best.direction.toLowerCase()}`}>{directionLabels[best.direction]}</span><b>{best.symbol.replace("USDT", "")} · {best.timeframe}</b><StatePill state={best.status} /><em>{rr(best.primaryRiskReward)}</em></div><ul className="checklist">{best.reasons.slice(0, 3).map((reason) => <li className="done" key={reason}>✓ {reason}</li>)}{best.missingConditions.slice(0, 3).map((reason) => <li key={reason}>— {reason}</li>)}</ul><button className="secondary-terminal-button" type="button" onClick={() => onOpenChart(best.symbol, best.timeframe, best.strategy)}>查看圖表與計畫 →</button></> : <div className="inline-empty">資料不足，不做判定。</div>}</article>;
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
      <article className="terminal-panel strategy-plan decision-plan-card"><div className="panel-heading"><div><p>TRADE PLAN</p><h2>{setup ? strategyLabels[setup.strategy] : "策略資料不足"}</h2></div>{setup && <StatePill state={setup.status} />}</div>{setup ? <><div className="plan-regime"><span className={`direction ${setup.direction.toLowerCase()}`}>{directionLabels[setup.direction]}</span><b>{setup.timeframe}</b><em>{setup.conditionsMet}/{setup.conditionsTotal} 條件</em></div><div className="plan-levels"><span>進場區<b>{formatPrice(setup.entryLow)}–{formatPrice(setup.entryHigh)}</b><small>最不利邊界計算</small></span><span>結構 Stop<b>{formatPrice(setup.stop)}</b></span><span>TP1 / TP2 / TP3<b>{formatPrice(setup.tp1)} / {formatPrice(setup.tp2)} / {formatPrice(setup.tp3)}</b><small>淨 RR {rr(setup.riskRewardTp1)} / {rr(setup.riskRewardTp2)} / {rr(setup.riskRewardTp3)}</small></span><span>{setup.primaryTarget ?? "主要目標"} 淨 RR<b>{rr(setup.primaryRiskReward)}</b><small>手續費 {(setup.feeRate * 100).toFixed(3)}%／邊 · 滑價 {(setup.slippageRate * 100).toFixed(3)}%／邊</small></span></div><p className="plan-copy"><b>何時成立：</b>{setup.trigger}</p><p className="plan-copy"><b>何時失效：</b>{setup.invalidation}</p><p className="plan-copy"><b>目標依據：</b>{setup.targetBasis}</p><ul className="checklist">{setup.reasons.map((reason) => <li className="done" key={reason}>✓ {reason}</li>)}{setup.missingConditions.map((reason) => <li key={reason}>— {reason}</li>)}</ul><div className="formula-note"><b>策略說明</b><p>{strategyTips[setup.strategy]}</p></div></> : <div className="inline-empty">目前資料不足，先不產生計畫。</div>}</article>
    </section></div>;
}

export function ViewTitle({ eyebrow, title, copy }: { eyebrow: string; title: string; copy: string }) { return <section className="view-title"><p>{eyebrow}</p><h1>{title}</h1><span>{copy}</span></section>; }
export function EmptyState({ title, copy, actionLabel, onAction }: { title: string; copy: string; actionLabel?: string; onAction?: () => void }) { return <div className="empty-state"><span>—</span><h2>{title}</h2><p>{copy}</p>{actionLabel && onAction && <button className="secondary-terminal-button" type="button" onClick={onAction}>{actionLabel}</button>}</div>; }
