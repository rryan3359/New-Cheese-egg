# Cheese&Egg v13

- 七策略縮減為 `EMA Trend`、`Bollinger Breakout`、`ICT / SMC`；衍生品只作背景。
- 新增 1m／5m K 線、已收盤過濾、PDH/PDL、PWH/PWL、三大時段、EQH/EQL、swing liquidity、FVG 與 OB 流程。
- 固定 ATR TP 改為結構／流動性目標；淨 RR 納入雙邊費用、滑價與 1.5／2.0 gate。
- 首頁改為今日作戰台，加入市場狀態、session、事件、三策略狀態、最多五個機會及 No Trade 決策。
- TradingView 改用 OKX 永續代號；策略位仍只由 Market Data Hub 已收盤 K 線生成。
- 新增 repeatable backtest engine、RR 門檻比較、分組統計與樣本不足標籤。
- D1 新增 strategy version／legacy 欄位與非破壞 migration；不刪除舊警報或日誌。
- 保留原 `.openai/hosting.json` project_id 與 `DB` binding；未部署。
