# Cheese&Egg v13 · 日內量化決策台

Cheese&Egg v13 延續原有 Sidebar、手機導覽、深淺主題、OKX Market Hub、D1、警報、風控、日誌、資料健康與漸進載入。首頁「交易總攬」先呈現市場狀態、交易時段、事件與最多五個通過淨 RR 初篩的機會，再列出三套策略狀態。沒有合格機會時會明確顯示「目前不適合交易／等待也是交易決策」。

## 三套策略

1. `EMA Trend`（均線順勢）：1H／4H EMA20、EMA50 同向且斜率有效；5m／15m 回踩未破壞結構後，收盤重新站回 EMA 或微型 BOS 任一成立即可。
2. `Bollinger Breakout`（布林帶波動突破）：近 100 根 BB Width 低 20% 後開始擴張，必須收盤突破壓縮區間或 Band；回測、量能、EMA 與 OI 只加分，觸碰 Band 不產生方向。
3. `ICT / SMC`：反轉模型要求 Sweep、Displacement、收盤 MSS／CHOCH 與 FVG 或 OB；延續模型要求 1H／4H Bias、BOS／Displacement 與 FVG 或 OB 回踩，不強制 Sweep。主要判斷使用 5m／15m，1m 只作精細進場加分。

每套策略分為硬條件與加分條件；加分條件只改變 Confidence，不會阻止硬條件完整的機會，也不能令未通過硬條件的策略變成可執行。缺失欄位顯示 `missing`，不當成失敗或補成 0。狀態統一為 `不適用 → 形成中 → 等待觸發 → 可執行 → 失效／過期`。

Funding、OI、全體／大戶帳戶比及 Positioning 只作背景，不會成為第四套策略或單獨產生方向。舊七策略的警報與日誌不會被刪除：D1 migration 會標示 `strategy_version=12`、`strategy_legacy=1`；有合理對應者可由警報引擎相容映射，已退役者維持 legacy／missing，不再產生方向。

## RR 與機會語意

- 先建立進場區、結構失效 Stop、真實前高低／session／liquidity 目標，再算 RR。
- Long 使用進場區上緣、Short 使用下緣，採最不利價格。
- 淨 RR 扣除可設定的雙邊手續費與雙邊滑價；TP1／TP2／TP3 各自顯示實際淨 RR。
- 淨 RR `<1.5`：淘汰，不進 Scanner 機會榜。
- `1.5–<2`：硬條件完整時可執行，B 級。
- `≥2`：硬條件完整時可執行，A 級。
- 不以 ATR 倍數或人工拉遠 TP 湊足 2R。Scanner 最低淨 RR 預設並鎖定不低於 1.5。

## 資料信任原則

- 公開市場資料只使用 OKX USDT 永續；不需要交易所 API key。
- OKX `confirm=1` 的已收盤 K 線才可進入策略、session level 與回測。
- 策略與 TradingView 都指定 OKX 永續；策略位只由 Market Data Hub 生成，不使用 TradingView 畫面價格反推。
- 1m、5m、15m、1h、4h、1d 均保留 null／missing 語意；缺值不補 0、不推方向、不建立機會。
- PDH/PDL、PWH/PWL、亞洲／倫敦／紐約盤高低、EQH/EQL 與 swing liquidity 由 K 線計算。時間以 UTC 儲存，時段使用 IANA timezone（含紐約 DST）。
- 前端保留 stale-good-data、`AbortController`、request identity、`Promise.allSettled` 與分頁隱藏暫停刷新。

## 安裝與執行

需求：Node.js 22.x（`.nvmrc`／`package.json#engines`）與 npm。

```bash
npm ci
npm run dev
```

Sites／Vinext：

```bash
npm run dev:sites
npm run build:sites
```

`.openai/hosting.json` 保留原 `project_id` 與 D1 `DB` binding；不得重新初始化或替換。

## 可重複回測

```bash
npm run backtest
npm run backtest -- --input path/to/okx-candles.json --output reports/my-report.json
```

輸入是 `BacktestDataset[]`，每筆包含 `symbol` 與六週期 `candlesByTimeframe`。引擎逐根截斷資料，只在訊號後下一根起以最不利進場邊界成交；同一根同時碰 Stop／Target 時先計 Stop，並計入費用與滑價。輸出交易數、勝率、平均 R、Expectancy、Profit Factor、最大回撤，按幣種、週期、時段與市場狀態拆分，並比較最低 1.5R 與 2R。

未傳 `--input` 時只跑確定性 synthetic smoke fixture，產生 `reports/backtest-v13-sample.json`。它目前標示樣本不足，僅驗證引擎可重複執行，不是策略有效或獲利證據。真實結論必須使用足量、固定版本的 OKX 歷史資料；任何切片少於 30 筆都會標示不足。

## D1

- Schema：`db/schema.ts`
- 初始 migration：`drizzle/0000_user_workbench.sql`
- v13 相容 migration：`drizzle/0001_v13_strategy_compat.sql`
- v13.1 模型／規則集 migration：`drizzle/0002_v13_1_strategy_ruleset.sql`

Next.js／沒有 Sites 身分或 D1 時會誠實降級為裝置端保存。`.openai/hosting.json` 的 `project_id` 與 `DB` binding 維持不變。

## 正式驗證順序

```bash
npm ci
npx tsc --noEmit
npm test
npm run lint
npm run build
npm run build:sites
```

本專案只讀公開行情，不含自動下單、交易所私鑰或私有 API key。
