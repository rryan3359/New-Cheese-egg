# Cheese&Egg v13 實作與驗證報告

日期：2026-08-27  
交付基礎：僅使用附帶的 `cheese-egg-v13-warm-editorial.zip` 既有專案，未建立新專案。  
部署狀態：依要求未部署。

## 核心改進

- 首頁改為「今日作戰台」：市場狀態、目前 session、重要價位、近期事件、三策略狀態、最多五個機會與明確 No Trade 決策。
- 三套策略均拆成硬條件、加分條件與 missing；加分只影響 Confidence，未通過硬條件不得變成可執行。狀態統一為不適用、形成中、等待觸發、可執行、失效／過期。
- 均線順勢允許「收盤重回 EMA」或「微型 BOS」二擇一；布林回測改為加分且觸碰 Band 不產生方向；ICT／SMC 拆成反轉與延續子模型，FVG／OB 二擇一，延續模型不強制 Sweep，1m 只加分。
- K 線擴充為 1m、5m、15m、1h、4h、1d；策略只使用 OKX 已收盤 K 線，圖表也改為 OKX 永續合約，不以 TradingView 價格生成策略位。
- RR 引擎使用「Entry 區最不利價 → 結構 Stop → 真實結構／流動性目標」，每一側按實際進出價格扣除手續費與滑價；`<1.5R` 淘汰、`1.5–<2R` 為可執行 B 級、`>=2R` 為可執行 A 級。
- 同幣種同方向合併成 Confluence；方向衝突只顯示一次「訊號衝突／不交易」。
- Session 與 level 使用 UTC 時間戳、IANA timezone 與紐約 DST；加入 PDH/PDL、PWH/PWL、亞洲／倫敦／紐約高低、EQH/EQL 與 swing liquidity。
- D1 schema 安全新增策略版本、legacy、ICT 子模型與 v13.1 ruleset；migration 只新增／標記，不刪除舊策略記錄。
- 保留 stale-good-data、AbortController、request identity、`Promise.allSettled` 與分頁隱藏暫停刷新；缺少資料維持 `null`／`missing`。
- 修正完整 L3 的節流時間，使 30 幣 × 6 週期可在 server deadline 內完成。

## 量化驗證

- `npm run backtest` 提供可重複、逐根已收盤 K 線的三策略回測。
- 訊號後使用下一根可成交價格，保守採同根先停損，納入手續費與滑價。
- 輸出 trades、win rate、average R、expectancy、profit factor、max drawdown，並按幣種、週期、session、市況拆分，比較最低 1.5R 與 2R。
- deterministic smoke dataset 中，EMA／ICT 為 0 筆；BB 在 1.5R／2R 門檻分別為 5／4 筆。全部少於 30 筆並標示樣本不足，不宣稱策略有效；可用 `--input` 匯入固定版本的實際 OKX 歷史資料。

## 自動驗證

依要求依序執行：

1. `npm ci`：通過；475 packages。npm audit 仍報 16 個相依問題（4 moderate、12 high）。
2. `npx tsc --noEmit`：通過。
3. `npm test`：19 pass、0 fail；涵蓋硬／加分／missing、B／A 級 RR、ICT 子模型、Confluence／衝突、No Trade、漸進載入、stale cache、警報、回測與 D1 相容。
4. `npm run lint`：通過。
5. `npm run build`：Next.js 16.2.6 production build 通過。
6. `npm run build:sites`：Vinext build 通過；保留其對 `next.config` webpack 與部分 route 靜態分類的非阻斷警告。

正式驗收使用 Node.js 22.23.2。另以記憶體 SQLite 依序實際套用 `0000`、`0001`、`0002` migrations，確認 alerts／journal 的 model 與 ruleset 欄位可安全新增。`drizzle-kit generate` 在此 Windows 主機受 `uv_os_get_passwd ENOMEM` 系統錯誤阻擋，因此保留經實際 migration smoke 驗證的手寫 additive migration，不宣稱 generate 通過。

## 瀏覽器驗收

- 桌面與 390×844 的深／淺色畫面均可用；390px 實測 body／main 為 390px、底部導覽 366px，Sidebar 正確隱藏，Scanner、策略與「更多」選單可操作。
- 三策略補齊、Scanner 預設最低淨 RR 1.5、策略選項僅三套。
- 無合格機會時顯示「目前沒有值得交易的設定」與「等待也是交易決策」。
- 本次主機無法連到 OKX；瀏覽器實際驗證來源完全失敗時的 unavailable／N/A，以及已有快照時保留最後資料並標示過期。L1/L2/L3 漸進合併與 stale cache 由自動測試驗證，不冒充 live OKX 成功。
- 可執行 B／A 級與方向衝突由 deterministic 測試驗證；因當時沒有真實合格市場設定，不宣稱完成這兩種狀態的 live market 視覺驗收。
- 互動後無 browser console error 或 warning。

## 保留與限制

- `.openai/hosting.json` 的 `project_id` `appgprj_6a87002c4a4c8191a0a4732ea759664c` 與 D1 binding `DB` 未變更。
- Funding、OI、Top／Global Ratio、Positioning 僅為背景，不產生方向。
- 未加入自動下單、私鑰或秘密資料；未部署，沒有線上 URL。
- 回測框架已完成，但交付內只有 deterministic smoke dataset；需匯入足量真實歷史資料後，才可評估策略統計有效性。
- 初次 lockfile 安裝曾回報 16 個相依問題（4 moderate、12 high）；未用破壞性的 `--force` 自動升級。
