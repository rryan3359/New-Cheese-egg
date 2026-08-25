# Cheese&Egg v13 實作與驗證報告

日期：2026-08-25  
交付基礎：僅使用 `cheese-egg-v12-fixed.zip` 的既有專案。  
部署狀態：依要求未部署。

## 核心改進

- 首頁改為「今日作戰台」：市場狀態、目前 session、重要價位、近期事件、三策略狀態、最多五個機會與明確 No Trade 決策。
- 七套策略停止產生新訊號，只保留均線順勢、布林帶波動突破、ICT／SMC；舊記錄以 `legacy`／相容映射保留。
- K 線擴充為 1m、5m、15m、1h、4h、1d；策略只使用 OKX 已收盤 K 線，圖表也改為 OKX 永續合約，不以 TradingView 價格生成策略位。
- RR 引擎改為「Entry 區最不利價 → 結構 Stop → 真實結構／流動性目標」，扣除雙邊手續費與滑價後再判定；`<1.5R` 淘汰、`1.5–2R` 觀察、`>=2R` 且條件完整才可執行。
- Session 與 level 使用 UTC 時間戳、IANA timezone 與紐約 DST；加入 PDH/PDL、PWH/PWL、亞洲／倫敦／紐約高低、EQH/EQL 與 swing liquidity。
- D1 schema 新增策略版本、legacy 與成本欄位；migration 只新增／標記，不刪除舊策略記錄。
- 保留 stale-good-data、AbortController、request identity、`Promise.allSettled` 與分頁隱藏暫停刷新；缺少資料維持 `null`／`missing`。
- 修正完整 L3 的節流時間，使 30 幣 × 6 週期可在 server deadline 內完成。

## 量化驗證

- `npm run backtest` 提供可重複、逐根已收盤 K 線的三策略回測。
- 訊號後使用下一根可成交價格，保守採同根先停損，納入手續費與滑價。
- 輸出 trades、win rate、average R、expectancy、profit factor、max drawdown，並按幣種、週期、session、市況與 0／1.5／2R 門檻拆分。
- 內附 deterministic smoke dataset 報告為 0 筆交易並明確標示樣本不足；不宣稱策略有效。可用 `--input` 匯入實際 OKX 歷史資料。

## 自動驗證

依要求依序執行：

1. `npm ci`：通過；475 packages。npm audit 仍報 16 個相依問題（4 moderate、12 high）。
2. `npx tsc --noEmit`：通過。
3. `npm test`：17 pass、0 fail。
4. `npm run lint`：通過。
5. `npm run build`：Next.js 16.2.6 production build 通過。
6. `npm run build:sites`：Vinext build 通過；保留其對 `next.config` webpack 與部分 route 靜態分類的非阻斷警告。

驗收執行環境實際為 Node.js 24.19.0；專案仍宣告並建議 Node.js 22.x，因此 `npm ci` 會顯示 engine warning。

## 瀏覽器驗收

- 桌面淺色與 390×844 深色畫面可用；手機 Sidebar 正確隱藏，底部導覽與「更多」dialog 可操作。
- 三策略補齊、Scanner 預設最低淨 RR 1.5、策略選項僅三套。
- 無合格機會時顯示「目前不適合交易」與「等待也是交易決策」。
- OKX 模擬來源下 L1 首屏與 L2／L3 漸進載入成功；L3 約 13.5 秒，低於 server deadline。
- 來源完全失敗時顯示 unavailable；已有成功快照時保留價格與功能、標示「過期資料／顯示最近資料」。
- 互動後無 browser console error 或 warning。

## 保留與限制

- `.openai/hosting.json` 的 `project_id` `appgprj_6a87002c4a4c8191a0a4732ea759664c` 與 D1 binding `DB` 未變更。
- Funding、OI、Top／Global Ratio、Positioning 僅為背景，不產生方向。
- 未加入自動下單、私鑰或秘密資料；未部署，沒有線上 URL。
- 回測框架已完成，但交付內只有 deterministic smoke dataset；需匯入足量真實歷史資料後，才可評估策略統計有效性。
- npm audit 間接相依問題未用破壞性的 `--force` 自動升級。
