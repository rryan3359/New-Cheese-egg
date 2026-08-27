# Cheese&Egg v13

- 七策略縮減為 `EMA Trend`、`Bollinger Breakout`、`ICT / SMC`；衍生品只作背景。
- 新增 1m／5m K 線、已收盤過濾、PDH/PDL、PWH/PWL、三大時段、EQH/EQL、swing liquidity、FVG 與 OB 流程。
- 三策略拆分硬條件、加分條件與 missing；Confidence 不繞過硬條件，狀態統一為五階段。
- EMA 觸發改為重回 EMA／微型 BOS 二擇一；BB 回測改為加分；ICT／SMC 分反轉與延續，FVG／OB 二擇一，1m 只加分。
- 固定 ATR TP 改為結構／流動性目標；淨 RR 納入實際進出價雙邊費用與滑價，1.5–<2R 為 B、≥2R 為 A。
- 首頁改為今日作戰台，加入市場狀態、session、事件、三策略狀態、最多五個機會及 No Trade 決策。
- TradingView 改用 OKX 永續代號；策略位仍只由 Market Data Hub 已收盤 K 線生成。
- 同方向機會合併為 Confluence，反向衝突合併為 No Trade。
- 新增 repeatable backtest engine、1.5R／2R 門檻比較、分組統計與樣本不足標籤。
- D1 新增 strategy version／legacy／model／ruleset 欄位與非破壞 migration；不刪除舊警報或日誌。
- 保留原 `.openai/hosting.json` project_id 與 `DB` binding；未部署。
