"use client";

import { useMemo, useState } from "react";
import { calculateJournalAnalytics } from "../../lib/journal/analytics";
import { TIMEFRAMES, type MarketHubPayload, type StrategyName, type Timeframe } from "../../lib/market/types";
import { CORE_SYMBOLS } from "../../lib/market/symbols";
import { calculateAllocation } from "../../lib/risk/calculator";
import { prioritizeByWatchlist } from "../../lib/workbench/watchlist";
import type { AlertEvent, AlertRule, AlertType, JournalEntry, WorkbenchSettings } from "./types";
import { formatPrice, ViewTitle } from "./MarketViews";

const strategyNames: StrategyName[] = ["Trend Pullback", "Breakout", "Volatility Squeeze", "Funding Mean Reversion", "Positioning Divergence", "ICT Liquidity Sweep", "Range Mean Reversion"];
const alertLabels: Record<AlertType, string> = {
  price_target: "價格到價", price_range: "進入價格區間", breakout: "突破近期區間", funding: "資金費率超過門檻", oi_change: "未平倉量一小時變化", positioning_reversal: "多空傾向反轉", strategy_eligible: "策略條件完成", liquidity_sweep: "掃過流動性價位", risk_reward: "報酬風險比達標", provider_health: "資料來源異常",
};
const alertStatusLabels: Record<string, string> = { watching: "觀察中", triggered: "已觸發", cooldown: "暫停提醒", missing: "資料不足", disabled: "已關閉" };
const dataStateLabels: Record<string, string> = { live: "即時", stale: "稍早資料", missing: "資料不足", eligible: "可規劃", waiting: "等待", invalid: "不合", triggered: "已觸發", cooldown: "暫停提醒", disabled: "已關閉" };
const channelLabels: Record<string, string> = { in_app: "站內", browser: "瀏覽器", telegram: "Telegram" };
const deliveryLabels: Record<string, string> = { delivered: "已送達", pending: "等待中", failed: "未送達", not_configured: "尚未設定" };
const formatSeconds = (milliseconds: number | null) => milliseconds === null ? "未使用" : `${(milliseconds / 1000).toFixed(1)} 秒`;

export function AlertsView({ data, alerts, events, watchlist, persistence, onUpsert, onDelete }: { data: MarketHubPayload | null; alerts: AlertRule[]; events: AlertEvent[]; watchlist: string[]; persistence: "d1" | "device"; onUpsert: (rule: AlertRule) => void; onDelete: (id: string) => void }) {
  const [symbol, setSymbol] = useState("BTCUSDT");
  const [type, setType] = useState<AlertType>("price_target");
  const [timeframe, setTimeframe] = useState<Timeframe>("1h");
  const [strategy, setStrategy] = useState<StrategyName>("Trend Pullback");
  const [operator, setOperator] = useState<"above" | "below" | "inside">("above");
  const current = data?.assets.find((asset) => asset.symbol === symbol)?.price.value ?? null;
  const [threshold, setThreshold] = useState<number | "">("");
  const [thresholdUpper, setThresholdUpper] = useState<number | null>(null);
  const [cooldownMinutes, setCooldownMinutes] = useState(60);
  const symbolOptions = data ? prioritizeByWatchlist(data.assets, watchlist) : [];
  const marketAvailable = symbolOptions.length > 0;
  const addAlert = () => {
    if (!data || threshold === "" || !Number.isFinite(threshold)) return;
    const now = new Date().toISOString();
    const asset = data.assets.find((item) => item.symbol === symbol);
    onUpsert({ id: crypto.randomUUID(), symbol, type, timeframe, strategy: ["strategy_eligible", "risk_reward"].includes(type) ? strategy : null, operator: type === "price_range" ? "inside" : operator, threshold, thresholdUpper: type === "price_range" ? thresholdUpper : null, referenceValue: type === "positioning_reversal" ? asset?.positioning.value ?? null : null, enabled: true, cooldownMinutes, dedupeKey: null, lastEvaluatedAt: null, lastTriggeredAt: null, triggerCount: 0, currentStatus: "watching", lastReason: "等待首次評估", createdAt: now });
  };
  const enableBrowser = async () => { if ("Notification" in window) await Notification.requestPermission(); };
  return <div className="view-stack"><ViewTitle eyebrow="ALERT CENTER" title="只在條件真的完成時打擾你。" copy="頁面開啟時會跟著行情檢查；同一條件在你設定的時間內只提醒一次。" />
    <div className="data-banner warning-banner"><span>!</span><p><b>僅分頁開啟時評估</b>外部 cron 可呼叫 <code>/api/alerts/evaluate</code>。本輪不實作 Telegram 推送。</p></div>
    {!marketAvailable && <div className="data-banner warning-banner"><span>!</span><p><b>目前沒有可用行情</b>既有規則與觸發歷史仍可查看；建立依賴行情的新警報會暫停。</p></div>}
    <section className="tool-split"><article className="terminal-panel form-panel"><div className="panel-heading"><div><p>NEW ALERT</p><h2>建立條件警報</h2></div><span>{persistence === "d1" ? "私人同步" : "保存在此裝置"}</span></div><fieldset disabled={!marketAvailable}><div className="form-grid two-column"><label>幣種<select value={symbol} onChange={(event) => { const next = event.target.value; setSymbol(next); setThreshold(data?.assets.find((asset) => asset.symbol === next)?.price.value ?? ""); }}>{symbolOptions.map((asset) => <option key={asset.symbol} value={asset.symbol}>{watchlist.includes(asset.symbol) ? `★ ${asset.symbol}` : asset.symbol}</option>)}</select></label><label>條件<select value={type} onChange={(event) => setType(event.target.value as AlertType)}>{Object.entries(alertLabels).map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select></label><label>週期<select value={timeframe} onChange={(event) => setTimeframe(event.target.value as Timeframe)}>{TIMEFRAMES.map((item) => <option key={item}>{item}</option>)}</select></label><label>運算<select value={operator} onChange={(event) => setOperator(event.target.value as "above" | "below" | "inside")}><option value="above">高於／突破</option><option value="below">低於／跌破</option><option value="inside">進入區間</option></select></label>{["strategy_eligible", "risk_reward"].includes(type) && <label>策略<select value={strategy} onChange={(event) => setStrategy(event.target.value as StrategyName)}>{strategyNames.map((item) => <option key={item}>{item}</option>)}</select></label>}<label>{type === "funding" ? "資金費率門檻 %" : type === "risk_reward" ? "最低報酬風險比" : "門檻"}<input type="number" step="any" value={threshold} onChange={(event) => setThreshold(event.target.value === "" ? "" : Number(event.target.value))} /></label>{type === "price_range" && <label>區間上限<input type="number" value={thresholdUpper ?? ""} onChange={(event) => setThresholdUpper(event.target.value ? Number(event.target.value) : null)} /></label>}<label>多久後可再次提醒（分鐘）<input type="number" min="0" value={cooldownMinutes} onChange={(event) => setCooldownMinutes(Number(event.target.value))} /></label></div><button className="primary-terminal-button" type="button" onClick={addAlert} disabled={!marketAvailable}>建立警報 <span>＋</span></button></fieldset><div className="notification-options"><button type="button" onClick={enableBrowser}>啟用瀏覽器通知</button><span>站內通知 · 可用</span></div></article>
      <article className="terminal-panel alert-context"><div className="panel-heading"><div><p>ALERT PREVIEW</p><h2>這個警報會怎麼判斷</h2></div></div><dl><div><dt>幣種／週期</dt><dd>{marketAvailable ? `${symbol} · ${timeframe}` : "N/A"}</dd></div><div><dt>觸發原因</dt><dd>{alertLabels[type]}</dd></div><div><dt>現價</dt><dd>{formatPrice(current)}</dd></div><div><dt>門檻</dt><dd>{threshold === "" ? "N/A" : threshold}{thresholdUpper !== null ? `–${thresholdUpper}` : ""}</dd></div><div><dt>再次提醒</dt><dd>{cooldownMinutes} 分鐘內不重複</dd></div><div><dt>行情時間</dt><dd>{data ? new Date(data.updatedAt).toLocaleTimeString("zh-TW") : "N/A"}</dd></div></dl></article></section>
    <section className="terminal-panel"><div className="panel-heading"><div><p>ACTIVE RULES</p><h2>{alerts.length} 個警報規則</h2></div><span>{persistence === "d1" ? "私人同步" : "保存在此裝置"}</span></div><div className="alert-list">{alerts.length ? alerts.map((alert) => <div key={alert.id}><button aria-label={alert.enabled ? "停用警報" : "啟用警報"} className={alert.enabled ? "toggle on" : "toggle"} type="button" onClick={() => onUpsert({ ...alert, enabled: !alert.enabled, currentStatus: alert.enabled ? "disabled" : "watching" })}><i /></button><b>{alert.symbol.replace("USDT", "")} · {alert.timeframe}</b><span>{alertLabels[alert.type]}</span><em><span className={`metric-state ${alert.currentStatus}`}>{alertStatusLabels[alert.currentStatus] ?? alert.currentStatus}</span></em><small>{alert.lastReason}</small><button aria-label="刪除警報" className="delete-rule" type="button" onClick={() => onDelete(alert.id)}>×</button></div>) : <div className="inline-empty">還沒有警報。從上方建立第一個條件。</div>}</div></section>
    <section className="terminal-panel"><div className="panel-heading"><div><p>EVENT HISTORY</p><h2>最近觸發</h2></div><span>{events.length} 筆</span></div><div className="journal-table alert-history">{events.length ? events.slice(0, 30).map((event) => <div key={event.id}><span data-label="幣種／時間"><b>{event.symbol.replace("USDT", "")}</b><small>{new Date(event.triggeredAt).toLocaleString("zh-TW")}</small></span><span data-label="原因">{event.reason}</span><span data-label="數值">{event.value ?? "N/A"}</span><span data-label="管道" className="positive">{channelLabels[event.channel] ?? event.channel}</span><span data-label="狀態">{deliveryLabels[event.deliveryStatus] ?? event.deliveryStatus}</span></div>) : <div className="inline-empty">尚無觸發事件。</div>}</div></section>
  </div>;
}

export function RiskView({ settings }: { settings: WorkbenchSettings }) {
  const [totalCapital, setTotalCapital] = useState(10_000);
  const [contractRatioPercent, setContractRatioPercent] = useState(30);
  const [slots, setSlots] = useState(5);
  const [perTradeStopPercent, setPerTradeStopPercent] = useState(settings.defaultRiskPercent || 1);
  const [dailyStopPercent, setDailyStopPercent] = useState(3);
  const [rewardRisk, setRewardRisk] = useState(2);
  const plan = calculateAllocation({
    totalCapital,
    contractRatioPercent,
    slots,
    perTradeStopPercent,
    dailyStopPercent,
    rewardRisk,
  });
  const fmt = (v: number | null) => (v === null || !Number.isFinite(v) ? "—" : formatPrice(v));
  return (
    <div className="view-stack">
      <ViewTitle eyebrow="RISK MANAGER" title="加密合約分倉試算" copy="依總資金與風險比例，算出合約帳戶、分倉保證金與單筆／當日止損上限。缺值顯示「—」。" />
      <section className="risk-calculator">
        <article className="terminal-panel calculator-input">
          <div className="panel-heading">
            <div>
              <p>輸入參數</p>
              <h2>分倉試算設定</h2>
            </div>
          </div>
          <div className="form-grid two-column">
            <label>
              總資金 (U)
              <input type="number" min="0" step="100" value={totalCapital} onChange={(e) => setTotalCapital(Number(e.target.value))} />
            </label>
            <label>
              合約帳戶比例 (%)
              <input type="number" min="1" max="100" step="1" value={contractRatioPercent} onChange={(e) => setContractRatioPercent(Number(e.target.value))} />
            </label>
            <label>
              分倉數
              <input type="number" min="1" step="1" value={slots} onChange={(e) => setSlots(Math.max(1, Math.floor(Number(e.target.value) || 1)))} />
            </label>
            <label>
              單筆止損 %（佔總資金）
              <input type="number" min="0.1" max="20" step="0.1" value={perTradeStopPercent} onChange={(e) => setPerTradeStopPercent(Number(e.target.value))} />
            </label>
            <label>
              當日止損 %（佔總資金）
              <input type="number" min="0.1" max="50" step="0.1" value={dailyStopPercent} onChange={(e) => setDailyStopPercent(Number(e.target.value))} />
            </label>
            <label>
              獲利目標 RR
              <input type="number" min="0.25" step="0.25" value={rewardRisk} onChange={(e) => setRewardRisk(Number(e.target.value))} />
            </label>
          </div>
          {plan.reason && (
            <div className="liquidation-note">
              <span>!</span>
              {plan.reason}
            </div>
          )}
        </article>
        <article className="terminal-panel calculator-output">
          <div className="panel-heading">
            <div>
              <p>試算結果</p>
              <h2>分倉與風險上限</h2>
            </div>
            <span className={plan.valid ? "positive" : "negative"}>{plan.valid ? "有效" : "無效"}</span>
          </div>
          <div className="output-grid">
            <span>
              合約帳戶資金
              <b>{fmt(plan.valid ? plan.contractCapital : null)}</b>
            </span>
            <span>
              現貨／備用金
              <b>{fmt(plan.valid ? plan.spotReserve : null)}</b>
            </span>
            <span>
              單筆保證金
              <b>{fmt(plan.valid ? plan.marginPerSlot : null)}</b>
            </span>
            <span>
              單筆最大虧損
              <b className="negative">{fmt(plan.valid ? plan.maxLossPerTrade : null)}</b>
            </span>
            <span>
              當日止損上限
              <b className="negative">{fmt(plan.valid ? plan.dailyLossLimit : null)}</b>
            </span>
            <span>
              單筆獲利目標
              <b className="positive">{fmt(plan.valid ? plan.profitTargetPerTrade : null)}</b>
            </span>
          </div>
        </article>
      </section>
    </div>
  );
}

export function JournalView({ journal, persistence, onUpsert, onDelete }: { journal: JournalEntry[]; persistence: "d1" | "device"; onUpsert: (entry: JournalEntry) => void; onDelete: (id: string) => void }) {
  const [showForm, setShowForm] = useState(false);
  const now = new Date();
  const [draft, setDraft] = useState({ symbol: "BTC", side: "Long" as "Long" | "Short", strategy: "Trend Pullback" as StrategyName, timeframe: "4h" as Timeframe, reason: "", entry: 0, stop: 0, target: 0, exit: 0, quantity: 0.01, fees: 0, fundingCost: 0, followed: true, mistake: "無", notes: "", chartNote: "", tradeDate: now.toISOString().slice(0, 10), entryTime: now.toISOString(), exitTime: now.toISOString() });
  const analytics = useMemo(() => calculateJournalAnalytics(journal), [journal]);
  const addEntry = () => {
    if (!draft.entry || !draft.stop || !draft.exit || draft.quantity <= 0) return;
    const direction = draft.side === "Long" ? 1 : -1;
    const grossPnl = direction * (draft.exit - draft.entry) * draft.quantity;
    const actualPnl = grossPnl - draft.fees - draft.fundingCost;
    const initialRisk = Math.abs(draft.entry - draft.stop) * draft.quantity + draft.fees + draft.fundingCost;
    const rMultiple = initialRisk ? actualPnl / initialRisk : 0;
    onUpsert({ ...draft, id: crypto.randomUUID(), actualPnl, rMultiple, createdAt: new Date().toISOString() });
    setShowForm(false);
  };
  return <div className="view-stack"><section className="view-title with-action"><div><p>TRADING JOURNAL</p><h1>把交易變成可以改進的資料。</h1><span>{persistence === "d1" ? "交易紀錄已開啟私人同步；我們不會要求你的交易所金鑰。" : "交易紀錄會保存在這台裝置；我們不會要求你的交易所金鑰。"}</span></div><button className="primary-terminal-button" type="button" onClick={() => setShowForm(!showForm)}>新增交易 ＋</button></section>
    {showForm && <section className="terminal-panel journal-form"><div className="form-grid journal-fields"><label>幣種<input value={draft.symbol} onChange={(event) => setDraft({ ...draft, symbol: event.target.value.toUpperCase() })} /></label><label>方向<select value={draft.side} onChange={(event) => setDraft({ ...draft, side: event.target.value as "Long" | "Short" })}><option>Long</option><option>Short</option></select></label><label>策略<select value={draft.strategy} onChange={(event) => setDraft({ ...draft, strategy: event.target.value as StrategyName })}>{strategyNames.map((item) => <option key={item}>{item}</option>)}</select></label><label>週期<select value={draft.timeframe} onChange={(event) => setDraft({ ...draft, timeframe: event.target.value as Timeframe })}>{TIMEFRAMES.map((item) => <option key={item}>{item}</option>)}</select></label><label>交易日期<input type="date" value={draft.tradeDate} onChange={(event) => setDraft({ ...draft, tradeDate: event.target.value })} /></label><label>數量<input type="number" step="any" value={draft.quantity} onChange={(event) => setDraft({ ...draft, quantity: Number(event.target.value) })} /></label><label>進場<input type="number" value={draft.entry || ""} onChange={(event) => setDraft({ ...draft, entry: Number(event.target.value) })} /></label><label>停損<input type="number" value={draft.stop || ""} onChange={(event) => setDraft({ ...draft, stop: Number(event.target.value) })} /></label><label>目標<input type="number" value={draft.target || ""} onChange={(event) => setDraft({ ...draft, target: Number(event.target.value) })} /></label><label>實際出場<input type="number" value={draft.exit || ""} onChange={(event) => setDraft({ ...draft, exit: Number(event.target.value) })} /></label><label>手續費<input type="number" step="any" value={draft.fees} onChange={(event) => setDraft({ ...draft, fees: Number(event.target.value) })} /></label><label>Funding 成本<input type="number" step="any" value={draft.fundingCost} onChange={(event) => setDraft({ ...draft, fundingCost: Number(event.target.value) })} /></label><label className="wide-field">進場原因<textarea value={draft.reason} onChange={(event) => setDraft({ ...draft, reason: event.target.value })} /></label><label>是否遵守策略<select value={draft.followed ? "是" : "否"} onChange={(event) => setDraft({ ...draft, followed: event.target.value === "是" })}><option>是</option><option>否</option></select></label><label>犯錯分類<select value={draft.mistake} onChange={(event) => setDraft({ ...draft, mistake: event.target.value })}>{["無","追價","提前進場","移動停損","過度槓桿","報復交易"].map((item) => <option key={item}>{item}</option>)}</select></label><label className="wide-field">圖表註記／截圖連結<textarea value={draft.chartNote} onChange={(event) => setDraft({ ...draft, chartNote: event.target.value })} /></label><label className="wide-field">復盤筆記<textarea value={draft.notes} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} /></label></div><button className="primary-terminal-button" type="button" onClick={addEntry}>儲存交易</button></section>}
    <section className="journal-stats"><article><span>勝率</span><b>{analytics.winRate === null ? "—" : `${analytics.winRate.toFixed(1)}%`}</b></article><article><span>獲利因子</span><b>{analytics.profitFactor === null ? "—" : analytics.profitFactor.toFixed(2)}</b></article><article><span>平均 R</span><b className={(analytics.averageR ?? 0) >= 0 ? "positive" : "negative"}>{analytics.averageR === null ? "—" : `${analytics.averageR.toFixed(2)}R`}</b></article><article><span>最大回撤</span><b>{analytics.maxDrawdown === null ? "—" : formatPrice(analytics.maxDrawdown)}</b></article><article><span>最大連敗</span><b>{analytics.maxLosingStreak}</b></article><article><span>累計淨損益</span><b className={analytics.totalPnl >= 0 ? "positive" : "negative"}>{formatPrice(analytics.totalPnl)}</b></article></section>
    <section className="terminal-panel"><div className="panel-heading"><div><p>績效拆解</p><h2>哪些做法真的有效</h2></div><span>只計算已完成交易</span></div><div className="breakdown-grid">{[{ title: "策略", rows: analytics.byStrategy }, { title: "方向", rows: analytics.bySide }, { title: "週期", rows: analytics.byTimeframe }, { title: "紀律", rows: analytics.byDiscipline }].map((group) => <div key={group.title}><b>{group.title}</b>{group.rows.length ? group.rows.map((row) => <span key={row.label}>{row.label}<em>{row.trades} 筆 · {row.averageR?.toFixed(2) ?? "—"}R · {formatPrice(row.totalPnl)}</em></span>) : <small>尚無資料</small>}</div>)}</div></section>
    <section className="terminal-panel"><div className="panel-heading"><div><p>TRADE LOG</p><h2>最近交易</h2></div><span>{persistence === "d1" ? "私人同步" : "保存在此裝置"}</span></div><div className="journal-table trade-log">{journal.length ? journal.map((entry) => <div key={entry.id}><span data-label="交易"><b>{entry.symbol}</b><small>{entry.strategy} · {entry.timeframe} · {entry.tradeDate}</small></span><span data-label="方向" className={`direction ${entry.side.toLowerCase()}`}>{entry.side}</span><span data-label="進出場"><b>{formatPrice(entry.entry)}</b><small>→ {formatPrice(entry.exit)}</small></span><span data-label="結果" className={entry.rMultiple >= 0 ? "positive" : "negative"}>{entry.rMultiple.toFixed(2)}R · {formatPrice(entry.actualPnl)}</span><span data-label="紀律">{entry.followed ? "有遵守" : entry.mistake}</span><button aria-label={`刪除 ${entry.symbol} 交易`} type="button" onClick={() => onDelete(entry.id)}>×</button></div>) : <div className="inline-empty">尚無交易紀錄。先記錄一筆真實交易，統計才會開始。</div>}</div></section>
  </div>;
}

export function HealthView({ data, refreshing, onRefresh }: { data: MarketHubPayload | null; refreshing: boolean; onRefresh: () => void }) {
  return <div className="view-stack"><section className="view-title with-action"><div><p>DATA HEALTH</p><h1>每個數字，都知道從哪裡來。</h1><span>OKX 是唯一市場資料來源；即時、稍早資料與暫缺分開標示，拿不到就顯示 N/A，不會假裝是零。</span></div><button className="secondary-terminal-button" type="button" onClick={onRefresh} disabled={refreshing}>{refreshing ? "正在重新整理 OKX…" : "重新整理 OKX"}</button></section>
    {refreshing && <section className="refresh-progress" aria-live="polite"><i /><div><b>正在向 OKX 重新抓取</b><span>目前畫面會保留，不會因更新而變成空白。</span></div></section>}
    {!data ? <section className="terminal-panel unavailable-panel"><div className="panel-heading"><div><p>MARKET SERVICE</p><h2>目前沒有可用行情</h2></div><span className="metric-state missing">資料不足</span></div><p>資料健康頁仍可開啟；OKX 行情、Funding、OI、多空比與 K 線目前皆標示 N/A。請稍後重新嘗試。</p></section> : <>
      <section className="pipeline-summary"><article><span>目前使用方式</span><b>OKX 主行情</b></article><article><span>整體更新時間</span><b>{formatSeconds(data.pipeline.marketApiDurationMs)}</b></article><article><span>最後成功資料</span><b>{new Date(data.updatedAt).toLocaleString("zh-TW")}</b></article></section>
      {data.recentErrors.length > 0 && <section className="terminal-panel"><div className="panel-heading"><div><p>RECENT ISSUES</p><h2>最近遇到的資料問題</h2></div><span>{data.recentErrors.length} 項</span></div><ul className="risk-list"><li><span>!</span>部分來源暫時無法更新；系統已保留可用欄位，內部錯誤細節不會顯示在介面。</li></ul></section>}
      <section className="health-grid">{data.health.map((provider) => <article key={provider.name}><header><b>{provider.name}</b><span className={`metric-state ${provider.state}`}>{dataStateLabels[provider.state] ?? provider.state}</span></header><strong>{formatSeconds(provider.latencyMs)}</strong><p>最近成功 {provider.lastSuccessAt ? new Date(provider.lastSuccessAt).toLocaleTimeString("zh-TW") : "N/A"}</p><dl><div><dt>即時報價</dt><dd>{provider.coverage.ticker}</dd></div><div><dt>資金費率</dt><dd>{provider.coverage.funding}</dd></div><div><dt>未平倉量</dt><dd>{provider.coverage.oi}</dd></div><div><dt>多空傾向</dt><dd>{provider.coverage.positioning}</dd></div><div><dt>K 線</dt><dd>{provider.coverage.candles}</dd></div></dl>{provider.errors.length > 0 && <small>此來源有 {provider.errors.length} 個暫時性錯誤，請稍後重試。</small>}<footer><span>連續失敗 {provider.consecutiveFailures} 次</span><span>{provider.circuitOpen ? "暫停重試" : "連線可用"}</span></footer></article>)}</section>
      <section className="terminal-panel"><div className="panel-heading"><div><p>FIELD COVERAGE</p><h2>各市場可用資料</h2></div><span>最後成功更新 {new Date(data.updatedAt).toLocaleTimeString("zh-TW")} · {data.pipeline.stage === "showing-stale" ? "稍早資料" : "即時資料"}</span></div><div className="coverage-table"><div className="coverage-row coverage-head"><span>幣種</span><span>價格</span><span>資金費率</span><span>未平倉量</span><span>多空傾向</span><span>各週期 K 線</span><span>成交量／原因</span></div>{data.assets.map((asset) => <div className="coverage-row" key={asset.symbol}><b data-label="幣種">{asset.symbol.replace("USDT", "")}</b><span data-label="價格"><MetricCell state={asset.price.state} source={asset.price.source} /></span><span data-label="資金費率"><MetricCell state={asset.funding.state} source={asset.funding.source} /></span><span data-label="未平倉量"><MetricCell state={asset.openInterest.state} source={asset.openInterest.source} /></span><span data-label="多空傾向"><MetricCell state={asset.positioning.state} source={asset.positioning.source} /></span><span data-label="K 線">{TIMEFRAMES.map((timeframe) => `${timeframe}:${asset.timeframes[timeframe].candles.length}`).join(" · ")}</span><span data-label="資料狀態">{asset.quoteVolumeUnit ? `${asset.quoteVolumeUnit} · ${asset.quoteVolumeMethod}` : asset.price.reason ?? asset.funding.reason ?? asset.openInterest.reason ?? "N/A"}</span></div>)}</div></section>
    </>}
  </div>;
}

function MetricCell({ state, source }: { state: string; source: string }) { return <span><i className={`coverage-dot ${state}`} />{dataStateLabels[state] ?? state}<small>{source}</small></span>; }

export function SettingsView({ settings, persistence, onChange, data }: { settings: WorkbenchSettings; persistence: "d1" | "device"; onChange: (settings: WorkbenchSettings) => void; data: MarketHubPayload | null }) {
  const toggle = (symbol: string) => onChange({ ...settings, watchlist: settings.watchlist.includes(symbol) ? settings.watchlist.filter((item) => item !== symbol) : [...settings.watchlist, symbol] });
  const symbols = data?.assets.map((asset) => ({ symbol: asset.symbol, price: asset.price.value })) ?? CORE_SYMBOLS.map((symbol) => ({ symbol, price: null }));
  return <div className="view-stack"><ViewTitle eyebrow="SETTINGS" title="讓工作台配合你的交易節奏。" copy={persistence === "d1" ? "偏好與自選清單已開啟私人同步。" : "偏好與自選清單會保存在這台裝置。"} />
    {!data && <div className="data-banner warning-banner"><span>!</span><p><b>行情暫時不可用</b>所有設定仍可修改與保存；自選清單價格暫時顯示 N/A。</p></div>}
    <section className="settings-grid"><article className="terminal-panel form-panel"><div className="panel-heading"><div><p>DATA PREFERENCE</p><h2>更新與風險預設</h2></div><span>{persistence === "d1" ? "私人同步" : "保存在此裝置"}</span></div><div className="form-grid two-column"><label>自動更新<select value={settings.refreshSeconds} onChange={(event) => onChange({ ...settings, refreshSeconds: Number(event.target.value) })}>{[30,60,120,300].map((seconds) => <option value={seconds} key={seconds}>{seconds} 秒</option>)}</select></label><label>預設單筆風險 %<input type="number" step="0.1" value={settings.defaultRiskPercent} onChange={(event) => onChange({ ...settings, defaultRiskPercent: Number(event.target.value) })} /></label><label>每日最大虧損 USDT<input type="number" value={settings.dailyLossLimit} onChange={(event) => onChange({ ...settings, dailyLossLimit: Number(event.target.value) })} /></label><label>預設單邊手續費率<input type="number" step="0.0001" value={settings.defaultFeeRate} onChange={(event) => onChange({ ...settings, defaultFeeRate: Number(event.target.value) })} /></label></div><div className="security-note"><span>✓</span><p><b>不需要交易權限</b><small>網站只讀公開行情，不需要交易所 API key。輸入停止後才保存設定，減少不必要的寫入。</small></p></div></article><article className="terminal-panel"><div className="panel-heading"><div><p>WATCHLIST</p><h2>自選永續合約</h2></div><span>已選 {settings.watchlist.length} 個</span></div>{settings.watchlist.length === 0 && <div className="watchlist-empty">目前沒有自選項目；駕駛艙不會假裝全部市場都是自選。</div>}<div className="watchlist-settings">{symbols.map((asset) => <button type="button" className={settings.watchlist.includes(asset.symbol) ? "selected" : ""} key={asset.symbol} onClick={() => toggle(asset.symbol)}><span>{asset.symbol.replace("USDT", "")}</span><b>{asset.price === null ? "N/A" : formatPrice(asset.price)}</b><em>{settings.watchlist.includes(asset.symbol) ? "✓" : "+"}</em></button>)}</div></article></section>
    <section className="terminal-panel formula-note"><div className="panel-heading"><div><p>STRATEGY CATALOG</p><h2>七套規則清楚的策略</h2></div><span>只用真實價格</span></div><div>{strategyNames.map((item, index) => <span key={item}><b>0{index + 1}</b>{item}<em>已啟用 · 四個週期</em></span>)}</div></section>
  </div>;
}
