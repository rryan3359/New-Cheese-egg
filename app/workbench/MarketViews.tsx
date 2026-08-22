"use client";

import { useMemo, useState } from "react";
import { TIMEFRAMES, type AssetSnapshot, type MarketHubPayload, type StrategyName, type StrategyResult, type StrategyStatus, type Timeframe } from "../../lib/market/types";
import { cockpitAssets, prioritizeByWatchlist, watchlistAssets } from "../../lib/workbench/watchlist";
import TerminalChart from "./TerminalChart";

export type OpenChart = (symbol: string, timeframe?: Timeframe, strategy?: StrategyName) => void;

const strategyTips: Record<StrategyName, string> = {
  "Trend Pullback": "順著 EMA20／50 趨勢，等待價格回到均線區並由 RSI 與 ADX 確認，而不是追價。",
  Breakout: "前高／前低被收盤突破，並由成交量放大確認；沒有量能就只列為等待。",
  "Volatility Squeeze": "布林帶寬處於歷史低位後開始擴張，方向由均線與突破邊決定。",
  "Funding Mean Reversion": "Funding 極端代表單邊持倉成本擁擠，再以價格與 RSI 是否衰竭判斷反轉。",
  "Positioning Divergence": "價格和多空持倉分數背離時，尋找擁擠部位可能被迫平倉的方向。",
  "ICT Liquidity Sweep": "影線掃過近期 swing high／low 後收回；只有聚合 K 線時，FVG 會誠實標示缺失。",
  "Range Mean Reversion": "ADX 偏低且價格靠近布林帶／區間邊緣時，規劃回到均值的交易。",
};
const strategyLabels: Record<StrategyName, string> = {
  "Trend Pullback": "順勢回踩",
  Breakout: "區間突破",
  "Volatility Squeeze": "波動收斂後突破",
  "Funding Mean Reversion": "資金費率均值回歸",
  "Positioning Divergence": "多空傾向背離",
  "ICT Liquidity Sweep": "流動性掃單",
  "Range Mean Reversion": "區間均值回歸",
};
const stateLabels: Record<string, string> = { live: "即時", fallback: "備援", stale: "稍早資料", missing: "資料不足", eligible: "可規劃", waiting: "等待", invalid: "不合", triggered: "已觸發", cooldown: "暫停提醒", disabled: "已關閉" };
const directionLabels: Record<string, string> = { Long: "偏多", Short: "偏空", Neutral: "中性" };
const regimeLabels: Record<string, string> = { "Risk-Off": "風險偏高", Range: "區間整理", Trend: "趨勢行情" };
const layerLabels: Record<string, string> = { ema: "均線", volume: "成交量", structure: "市場結構", plan: "交易計畫" };

export function formatPrice(value: number | null, digits = 2) {
  if (value === null || !Number.isFinite(value)) return "—";
  return `$${new Intl.NumberFormat("en-US", { maximumFractionDigits: value < 10 ? 4 : digits, minimumFractionDigits: value < 10 ? 4 : digits }).format(value)}`;
}
export function formatPercent(value: number | null, digits = 2) {
  if (value === null) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}%`;
}
export function compact(value: number | null) {
  if (value === null) return "—";
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(value);
}
function tone(value: number | null) { return value === null ? "missing" : value >= 0 ? "positive" : "negative"; }
function StatePill({ state }: { state: string }) { return <span className={`metric-state ${state}`}>{stateLabels[state] ?? state}</span>; }
function rr(value: number | null) { return value === null ? "—" : `${value.toFixed(2)}R`; }

function SetupCompact({ setup, onOpen }: { setup: StrategyResult; onOpen: () => void }) {
  return <button className="setup-compact" type="button" onClick={onOpen}>
    <div><span className={`direction ${setup.direction.toLowerCase()}`}>{directionLabels[setup.direction] ?? setup.direction}</span><b>{setup.symbol.replace("USDT", "")}</b><em>{setup.timeframe}</em></div>
    <h3>{strategyLabels[setup.strategy]}</h3><p><StatePill state={setup.status} /> 信心 {setup.confidence}% · 完成 {setup.conditionsMet}/{setup.conditionsTotal} 個條件</p>
    <dl><div><dt>進場區</dt><dd>{formatPrice(setup.entryLow)}–{formatPrice(setup.entryHigh)}</dd></div><div><dt>停損</dt><dd>{formatPrice(setup.stop)}</dd></div><div><dt>{setup.primaryTarget ?? "主要目標"}</dt><dd>{rr(setup.primaryRiskReward)}</dd></div></dl>
    <small>{setup.reasons[0] ?? setup.missingConditions[0] ?? setup.trigger}</small>
  </button>;
}

export function CockpitView({ data, watchlist, onNavigate, onOpenChart }: { data: MarketHubPayload; watchlist: string[]; onNavigate: (view: string) => void; onOpenChart: OpenChart }) {
  const prioritized = cockpitAssets(data.assets, watchlist);
  const core = prioritized.slice(0, 2);
  const setups = prioritized.flatMap((asset) => asset.strategies).filter((setup) => setup.status === "eligible" || setup.status === "waiting").sort((a, b) => (Number(b.status === "eligible") - Number(a.status === "eligible")) || b.confidence - a.confidence).slice(0, 3);
  return <div className="view-stack">
    <section className="cockpit-heading view-heading"><div><p>MARKET COCKPIT</p><h1>先讀懂市場，<br /><i>再決定是否交易。</i></h1></div><button type="button" onClick={() => onNavigate("scanner")}>掃描交易機會 <span>↗</span></button></section>
    <div className={watchlist.length ? "watchlist-priority" : "watchlist-priority empty"}><b>{watchlist.length ? `自選優先 · ${watchlist.map((symbol) => symbol.replace("USDT", "")).join(" / ")}` : "尚未建立自選清單"}</b><span>{watchlist.length ? "駕駛艙、掃描器、圖表與警報已使用相同排序" : "前往設定加入幣種；目前市場資料仍完整顯示，但不會假裝全部都是自選。"}</span></div>
    <section className="regime-grid live-regime">
      <article className="regime-card"><div className="terminal-label"><span>市場節奏</span><StatePill state="live" /></div><strong>{regimeLabels[data.regime] ?? data.regime}</strong><p>{data.breadth.advancing}/{data.breadth.total} 個高流動性永續合約上漲；只用目前取得的真實資料判斷。</p><div className="regime-metrics"><span>上漲比例<b>{data.breadth.total ? Math.round(data.breadth.advancing / data.breadth.total * 100) : 0}%</b></span><span>市場情緒<b>{data.fearGreed.value?.value ?? "—"}</b></span><span>資料年齡<b>{Math.round(data.cacheAgeMs / 1000)} 秒</b></span></div><div className="regime-scale"><i style={{ left: data.regime === "Risk-Off" ? "15%" : data.regime === "Range" ? "50%" : "83%" }} /><span>風險偏高</span><span>區間</span><span>趨勢</span></div></article>
      {core.map((asset) => <button className="core-asset" key={asset.symbol} type="button" onClick={() => onOpenChart(asset.symbol, "1h")}><div><span className={`coin-mark ${asset.symbol.startsWith("BTC") ? "btc" : "eth"}`}>{asset.symbol[0]}</span><p><b>{asset.symbol.replace("USDT", " / USDT")}</b><small>{asset.name}</small></p><StatePill state={asset.price.state} /></div><strong>{formatPrice(asset.price.value)}</strong><p className={tone(asset.change24h.value)}>{formatPercent(asset.change24h.value)} · 24h</p><div className="timeframe-row"><span>15m <b className={tone(asset.change15m.value)}>{formatPercent(asset.change15m.value)}</b></span><span>1h <b className={tone(asset.change1h.value)}>{formatPercent(asset.change1h.value)}</b></span><span>4h <b className={tone(asset.change4h.value)}>{formatPercent(asset.change4h.value)}</b></span><span>1d <b className={tone(asset.change24h.value)}>{formatPercent(asset.change24h.value)}</b></span></div></button>)}
    </section>
    <section className="cockpit-split"><article className="terminal-panel"><div className="panel-heading"><div><p>DERIVATIVES SNAPSHOT</p><h2>市場是否太擁擠</h2></div><button type="button" onClick={() => onNavigate("derivatives")}>完整分析 →</button></div><div className="derivative-mini-grid">{core.map((asset) => <div key={asset.symbol}><span>{asset.symbol.replace("USDT", "")}</span><p>資金費率 <b>{asset.funding.value === null ? "—" : `${(asset.funding.value * 100).toFixed(4)}%`}</b></p><p>未平倉量 <b>{compact(asset.openInterest.value)}</b></p><p>多空傾向 <b>{asset.positioning.value?.toFixed(1) ?? "—"}</b></p></div>)}</div></article><article className="terminal-panel risk-panel"><div className="panel-heading"><div><p>RISK RADAR</p><h2>目前要小心</h2></div><span className="alert-count">{data.riskAlerts.length}</span></div>{data.riskAlerts.length ? <ul className="risk-list">{data.riskAlerts.map((alert) => <li key={alert}><span>!</span>{alert}</li>)}</ul> : <div className="quiet-state"><span>✓</span><p>暫無異常風險訊號<br /><small>仍需遵守單筆風險上限</small></p></div>}</article></section>
    <section className="terminal-panel opportunity-panel"><div className="panel-heading"><div><p>OPPORTUNITY QUEUE</p><h2>正在形成的交易機會</h2></div><span>真實 K 線 · 進場、停損、目標一併計算</span></div><div className="opportunity-grid">{setups.length ? setups.map((setup) => <SetupCompact key={setup.id} setup={setup} onOpen={() => onOpenChart(setup.symbol, setup.timeframe, setup.strategy)} />) : <div className="inline-empty">目前沒有條件完成或接近完成的設定；等待也是有效決策。</div>}</div></section>
  </div>;
}

type ScannerRow = { asset: AssetSnapshot; setup: StrategyResult };
export function ScannerView({ data, watchlist, onOpenChart }: { data: MarketHubPayload; watchlist: string[]; onOpenChart: OpenChart }) {
  const [search, setSearch] = useState("");
  const [timeframe, setTimeframe] = useState<Timeframe | "All">("All");
  const [strategy, setStrategy] = useState<StrategyName | "All">("All");
  const [direction, setDirection] = useState("All");
  const [status, setStatus] = useState<StrategyStatus | "All">("All");
  const [minimumConfidence, setMinimumConfidence] = useState(45);
  const [minimumRr, setMinimumRr] = useState(0);
  const [minimumVolumeZ, setMinimumVolumeZ] = useState(-3);
  const [onlyWatchlist, setOnlyWatchlist] = useState(false);
  const rows = useMemo(() => watchlistAssets(data.assets, watchlist, onlyWatchlist).flatMap((asset) => asset.strategies.map((setup): ScannerRow => ({ asset, setup }))).filter(({ asset, setup }) => {
    const volumeZ = asset.timeframes[setup.timeframe].volumeZScore.value;
    return asset.symbol.toLowerCase().includes(search.toLowerCase()) && (timeframe === "All" || setup.timeframe === timeframe) && (strategy === "All" || setup.strategy === strategy) && (direction === "All" || setup.direction === direction) && (status === "All" || setup.status === status) && setup.confidence >= minimumConfidence && (setup.primaryRiskReward ?? -Infinity) >= minimumRr && (volumeZ ?? -Infinity) >= minimumVolumeZ;
  }).sort((a, b) => (Number(b.setup.status === "eligible") - Number(a.setup.status === "eligible")) || b.setup.confidence - a.setup.confidence), [data.assets, direction, minimumConfidence, minimumRr, minimumVolumeZ, onlyWatchlist, search, status, strategy, timeframe, watchlist]);
  const strategies = Array.from(new Set(data.assets.flatMap((asset) => asset.strategies.map((item) => item.strategy))));
  return <div className="view-stack"><ViewTitle eyebrow="OPPORTUNITY SCANNER" title="從條件開始，不從方向開始。" copy="同時檢查七套策略與四個週期；資料不足時只會顯示不足，不會硬湊成買賣方向。" />
    <section className="filter-bar"><label>搜尋<input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="BTC, ETH, SOL…" /></label><label>週期<select value={timeframe} onChange={(event) => setTimeframe(event.target.value as Timeframe | "All")}><option value="All">全部</option>{TIMEFRAMES.map((item) => <option key={item}>{item}</option>)}</select></label><label>策略<select value={strategy} onChange={(event) => setStrategy(event.target.value as StrategyName | "All")}><option value="All">全部</option>{strategies.map((item) => <option key={item} value={item}>{strategyLabels[item]}</option>)}</select></label><label>方向<select value={direction} onChange={(event) => setDirection(event.target.value)}><option value="All">全部</option><option value="Long">偏多</option><option value="Short">偏空</option><option value="Neutral">中性</option></select></label><label>狀態<select value={status} onChange={(event) => setStatus(event.target.value as StrategyStatus | "All")}><option value="All">全部</option><option value="eligible">條件完成</option><option value="waiting">等待中</option><option value="invalid">不成立</option><option value="missing">資料不足</option></select></label><label>最低信心<input type="number" min="0" max="100" value={minimumConfidence} onChange={(event) => setMinimumConfidence(Number(event.target.value))} /></label><label>最低報酬風險比<input type="number" step="0.25" value={minimumRr} onChange={(event) => setMinimumRr(Number(event.target.value))} /></label><label>量能門檻（Z）<input type="number" step="0.25" value={minimumVolumeZ} onChange={(event) => setMinimumVolumeZ(Number(event.target.value))} /></label><button className={onlyWatchlist ? "watchlist-filter active" : "watchlist-filter"} type="button" aria-pressed={onlyWatchlist} onClick={() => setOnlyWatchlist((current) => !current)}>★ 只看自選</button><span>{rows.length} 個結果</span></section>
    {onlyWatchlist && watchlist.length === 0 && <div className="watchlist-empty">自選清單是空的。請先到「設定」加入幣種，這裡不會自動把全部市場當成自選。</div>}
    <section className="scanner-table"><div className="scanner-row scanner-head"><span>幣種／週期</span><span>價格／24 小時</span><span>市場狀態</span><span>未平倉量 1H</span><span>資金費率</span><span>策略</span><span>條件狀態</span><span>進場／停損</span><span>報酬風險比</span><span>信心</span></div>{rows.map(({ asset, setup }) => <button className="scanner-row" key={setup.id} type="button" onClick={() => onOpenChart(asset.symbol, setup.timeframe, setup.strategy)}><span className="symbol-cell"><b>{asset.symbol.replace("USDT", "")} · {setup.timeframe}</b><small>{asset.price.source}</small></span><span><b>{formatPrice(asset.price.value)}</b><small className={tone(asset.change24h.value)}>{formatPercent(asset.change24h.value)}</small></span><span>{asset.timeframes[setup.timeframe].trend.value ?? "—"}</span><span className={tone(asset.oiChange1h.value)}>{formatPercent(asset.oiChange1h.value)}</span><span>{asset.funding.value === null ? "—" : `${(asset.funding.value * 100).toFixed(4)}%`}</span><span>{strategyLabels[setup.strategy]}</span><span><StatePill state={setup.status} /><small>{setup.conditionsMet}/{setup.conditionsTotal} 個條件</small></span><span><b>{formatPrice(setup.entryLow)}</b><small>停損 {formatPrice(setup.stop)}</small></span><span><b>{rr(setup.primaryRiskReward)}</b><small>{setup.primaryTarget ?? "—"}</small></span><span className="confidence-cell"><b>{setup.confidence}%</b><i style={{ width: `${setup.confidence}%` }} /></span></button>)}</section>
  </div>;
}

export function DerivativesView({ data }: { data: MarketHubPayload }) {
  const withFunding = data.assets.filter((a) => a.funding.value !== null);
  const withOiChange = data.assets.filter((a) => a.oiChange1h.value !== null);
  const withPos = data.assets.filter((a) => a.positioning.value !== null);
  const extremeFunding = withFunding.filter((a) => Math.abs(a.funding.value!) >= 0.0005).length;
  const oiUp = withOiChange.filter((a) => a.oiChange1h.value! > 0).length;
  const extremePos = withPos.filter((a) => Math.abs(a.positioning.value!) >= 60).length;
  return (
    <div className="view-stack">
      <ViewTitle eyebrow="DERIVATIVES" title="看價格，也看誰正被擠在同一邊。" copy="資金費率、未平倉量與帳戶多空比會一起看；這裡顯示的是交易所帳戶多空傾向，不是真實持倉集中度。缺值顯示「—／資料不足」，不會填假 0。" />
      <section className="derivative-summary">
        <article>
          <span>資金費率明顯偏高或偏低</span>
          <b>{withFunding.length ? extremeFunding : "—"}</b>
          <small>{withFunding.length ? `絕對值 ≥ 0.05% · 樣本 ${withFunding.length}` : "資金費率資料不足"}</small>
        </article>
        <article>
          <span>未平倉量一小時增加</span>
          <b>{withOiChange.length ? oiUp : "—"}</b>
          <small>{withOiChange.length ? `有資料 ${withOiChange.length} 檔` : "OI 1h 變化資料不足"}</small>
        </article>
        <article>
          <span>帳戶多空傾向偏極端</span>
          <b>{withPos.length ? extremePos : "—"}</b>
          <small>{withPos.length ? `|分數| ≥ 60 · 樣本 ${withPos.length}` : "傾向分數資料不足"}</small>
        </article>
      </section>
      <section className="position-table">
        <div className="position-row position-head">
          <span>幣種</span><span>資金費率</span><span>未平倉量</span><span>一小時變化</span>
          <span>全體多空比</span><span>大戶多空比</span><span>傾向分數</span><span>資料狀態</span>
        </div>
        {data.assets.map((asset) => (
          <div className="position-row" key={asset.symbol}>
            <b>{asset.symbol.replace("USDT", "")}</b>
            <span title={asset.funding.reason ?? undefined}>{asset.funding.value === null ? "—" : `${(asset.funding.value * 100).toFixed(4)}%`}</span>
            <span title={asset.openInterest.reason ?? undefined}>{compact(asset.openInterest.value)}</span>
            <span className={tone(asset.oiChange1h.value)} title={asset.oiChange1h.reason ?? undefined}>{formatPercent(asset.oiChange1h.value)}</span>
            <span title={asset.globalRatio.reason ?? undefined}>{asset.globalRatio.value?.toFixed(2) ?? "—"}</span>
            <span title={asset.topRatio.reason ?? undefined}>{asset.topRatio.value?.toFixed(2) ?? "—"}</span>
            <span className={tone(asset.positioning.value)} title={asset.positioning.reason ?? undefined}>{asset.positioning.value?.toFixed(1) ?? "—"}</span>
            <StatePill state={asset.positioning.state === "missing" && (asset.oiChange1h.state === "missing" || asset.globalRatio.state === "missing") ? "missing" : asset.positioning.state} />
          </div>
        ))}
      </section>
    </div>
  );
}

export function StrategyView({ data, onOpenChart }: { data: MarketHubPayload; onOpenChart: OpenChart }) {
  const names = Object.keys(strategyTips) as StrategyName[];
  return <div className="view-stack"><ViewTitle eyebrow="STRATEGY DESK" title="每個條件，講清楚再出手。" copy="每套策略都遵守固定規則；資訊不足時只會標示資料不足，不會硬湊出交易訊號。" /><section className="strategy-desk">{names.map((name, index) => {
    const results = data.assets.flatMap((asset) => asset.strategies).filter((item) => item.strategy === name);
    const eligible = results.filter((item) => item.status === "eligible").sort((a, b) => b.confidence - a.confidence);
    const best = eligible[0] ?? results.filter((item) => item.status === "waiting").sort((a, b) => b.confidence - a.confidence)[0];
    return <article className="terminal-panel" key={name}><div className="panel-heading"><div><p>STRATEGY 0{index + 1}</p><h2>{strategyLabels[name]}</h2></div><span>{eligible.length} 個條件完成</span></div><p className="plan-copy">{strategyTips[name]}</p>{best ? <><div className="mini-plan"><span className={`direction ${best.direction.toLowerCase()}`}>{directionLabels[best.direction] ?? best.direction}</span><b>{best.symbol.replace("USDT", "")} · {best.timeframe}</b><StatePill state={best.status} /><em>{best.confidence}%</em></div><ul className="checklist">{best.reasons.slice(0, 3).map((reason) => <li className="done" key={reason}>✓ {reason}</li>)}{best.missingConditions.slice(0, 2).map((reason) => <li key={reason}>— {reason}</li>)}</ul><button className="secondary-terminal-button" type="button" onClick={() => onOpenChart(best.symbol, best.timeframe, best.strategy)}>查看圖表與計畫 →</button></> : <div className="inline-empty">目前資料不足，先不做判定。</div>}</article>;
  })}</section></div>;
}

export function ChartView({ data, symbol, initialTimeframe, initialStrategy, watchlist, onSymbolChange, theme = "dark" }: { data: MarketHubPayload; symbol: string; initialTimeframe: Timeframe; initialStrategy: StrategyName | null; watchlist: string[]; onSymbolChange: (symbol: string) => void; theme?: "light" | "dark" }) {
  const asset = data.assets.find((item) => item.symbol === symbol) ?? data.assets[0];
  const [timeframe, setTimeframe] = useState<Timeframe>(initialTimeframe);
  const [strategy, setStrategy] = useState<StrategyName>(initialStrategy ?? "Trend Pullback");
  const [layers, setLayers] = useState({ ema: true, volume: true, structure: true, plan: true });
  if (!asset) return <EmptyState title="沒有圖表資料" copy="目前沒有可用的市場行情，請稍後重新整理。" />;
  const snapshot = asset.timeframes[timeframe];
  const setup = asset.strategies.find((item) => item.timeframe === timeframe && item.strategy === strategy) ?? null;
  const symbolOptions = prioritizeByWatchlist(data.assets, watchlist);
  return <div className="view-stack"><section className="view-title with-action"><div><p>CHART WORKSPACE</p><h1>{asset.symbol.replace("USDT", "/USDT")} 決策圖表</h1><span>{timeframe} 真實 K 線 · 來源 {asset.price.source} · 共 {snapshot.candles.length} 根</span></div><div className="chart-toolbar"><select aria-label="選擇幣種" value={asset.symbol} onChange={(event) => onSymbolChange(event.target.value)}>{symbolOptions.map((item) => <option key={item.symbol} value={item.symbol}>{watchlist.includes(item.symbol) ? `★ ${item.symbol}` : item.symbol}</option>)}</select><select aria-label="選擇週期" value={timeframe} onChange={(event) => setTimeframe(event.target.value as Timeframe)}>{TIMEFRAMES.map((item) => <option key={item}>{item}</option>)}</select><select aria-label="選擇策略" value={strategy} onChange={(event) => setStrategy(event.target.value as StrategyName)}>{(Object.keys(strategyTips) as StrategyName[]).map((item) => <option key={item} value={item}>{strategyLabels[item]}</option>)}</select></div></section>
    <section className="chart-layout"><article className="terminal-panel chart-panel"><div className="chart-toolbar layer-toggles">{Object.entries(layers).map(([key, enabled]) => <button type="button" className={enabled ? "active" : ""} key={key} onClick={() => setLayers((current) => ({ ...current, [key]: !current[key as keyof typeof current] }))}>{layerLabels[key] ?? key}</button>)}</div><TerminalChart asset={asset} timeframe={timeframe} setup={setup} layers={layers} theme={theme} /><div className="chart-legend"><span>短期均線 EMA20 {formatPrice(snapshot.ema20.value)}</span><span>中期均線 EMA50 {formatPrice(snapshot.ema50.value)}</span><span>波動幅度 ATR {formatPrice(snapshot.atr.value)}</span><span>強弱 RSI {snapshot.rsi.value?.toFixed(1) ?? "—"}</span><span>趨勢 ADX {snapshot.adx.value?.toFixed(1) ?? "—"}</span><span>量能 Z {snapshot.volumeZScore.value?.toFixed(2) ?? "—"}</span></div></article>
      <article className="terminal-panel strategy-plan"><div className="panel-heading"><div><p>TRADE PLAN</p><h2>{setup ? strategyLabels[setup.strategy] : "策略資料不足"}</h2></div>{setup && <StatePill state={setup.status} />}</div>{setup ? <><div className="plan-regime"><span className={`direction ${setup.direction.toLowerCase()}`}>{directionLabels[setup.direction] ?? setup.direction}</span><b>{setup.timeframe}</b><em>完成 {setup.conditionsMet}/{setup.conditionsTotal} 個條件</em></div><div className="plan-levels"><span>進場區<b>{formatPrice(setup.entryLow)}–{formatPrice(setup.entryHigh)}</b><small>採較保守的邊界計算報酬風險比</small></span><span>停損<b>{formatPrice(setup.stop)}</b></span><span>目標一／二／三<b>{formatPrice(setup.tp1)} / {formatPrice(setup.tp2)} / {formatPrice(setup.tp3)}</b><small>{rr(setup.riskRewardTp1)} / {rr(setup.riskRewardTp2)} / {rr(setup.riskRewardTp3)}</small></span><span>{setup.primaryTarget ?? "主要目標"}<b>{rr(setup.primaryRiskReward)}</b></span></div><p className="plan-copy"><b>何時成立：</b>{setup.trigger}</p><p className="plan-copy"><b>何時失效：</b>{setup.invalidation}</p><ul className="checklist">{setup.reasons.map((reason) => <li className="done" key={reason}>✓ {reason}</li>)}{setup.missingConditions.map((reason) => <li key={reason}>— {reason}</li>)}</ul><div className="formula-note"><b>簡單教學</b><p>{strategyTips[setup.strategy]}</p></div></> : <div className="inline-empty">目前資料不足，先不產生交易計畫。</div>}</article>
    </section></div>;
}

export function ViewTitle({ eyebrow, title, copy }: { eyebrow: string; title: string; copy: string }) { return <section className="view-title"><p>{eyebrow}</p><h1>{title}</h1><span>{copy}</span></section>; }
export function EmptyState({ title, copy }: { title: string; copy: string }) { return <div className="empty-state"><span>—</span><h2>{title}</h2><p>{copy}</p></div>; }

