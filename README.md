# Cheese&Egg · Crypto Decision Workbench

一個以「先判讀市場、再決定是否交易」為核心的加密貨幣永續合約決策工作台。介面延續 Cheese&Egg 的暖橘、酸橙綠與起司／蛋品牌意象，內容則改為深色專業交易終端。

## 已實作

- 市場駕駛艙：市場狀態、BTC／ETH 核心行情、衍生品快照、風險雷達與機會佇列。
- 機會掃描器：搜尋、週期、策略、方向、狀態、信心、RR、Volume Z 與圖表跳轉。
- 衍生品：Funding、OI、OI 變化、大戶／全網多空比與 Positioning 分數。
- 策略工作台：七套策略都在 15m／1h／4h／1d 執行確定性公式，回傳 `eligible`、`waiting`、`invalid` 或 `missing` 與完整交易計畫。
- 圖表決策：Trade Plan 卡片（進場／停損／TP／條件／教學）+ TradingView Widget（縮放、歷史、畫線）；數字以卡片為準，圖表源與策略源可解耦。
- 警報：在市場刷新時真正執行，具有 cooldown、資料快照去重、站內／瀏覽器事件紀錄；介面明確說明分頁關閉時不保證 24/7 執行。
- 風險管理：把來回手續費納入單筆最大損失，提供倉位、保證金、槓桿警告與 1R／2R／3R。
- 交易日誌：使用實際數量、費用與 Funding 成本計算淨損益、R、勝率、PF、最大連敗、最大回撤與分組統計。
- 市場行情主源：**OKX**（已移除 Binance，避免 AU／Vercel 地區封鎖）；Fear & Greed：Alternative.me。
- 市場畫面與警報引擎共用同一份經伺服器驗證的 snapshot，不會為警報再抓第二套行情。
- TP1／TP2／TP3 風報比使用實際 entry、stop、target 計算；自選清單會影響駕駛艙、掃描器、圖表與警報排序。
- 每個市場欄位保留 `source`、`state`、`updatedAt`、`latencyMs` 與 `reason`；缺值顯示 `missing`，不以 `0` 假裝有效。

## 快速啟動（本機 + Vercel）

需求：Node.js **22.x**（見 `.nvmrc`）。

```bash
npm install
npm run dev          # http://localhost:3000
```

建置與測試：

```bash
npm ci
npm run build        # Next.js（給 Vercel）
npm test
npm run lint
```

詳細上架步驟見 **[DEPLOY.md](./DEPLOY.md)**。

若要走原本的 OpenAI Sites / Cloudflare：

```bash
npm run dev:sites
npm run build:sites
```

公開市場資料不需要 API key。若未來接入交易帳戶或 Telegram，請只在伺服器環境變數保存憑證，不要放進瀏覽器或提交至 Git。

## 資料與保存

市場資料由伺服器端 `Market Data Hub` 取得與驗證。警報、事件、交易日誌、自選清單和風險偏好優先保存在 Cloudflare D1，所有讀寫都使用 Sites 注入的使用者 ID 在伺服器端隔離。若身分或 D1 暫不可用，前端會明確降級成版本化 localStorage 並顯示「僅此裝置」，不會假裝已跨裝置同步。Telegram 未設定，因此不會顯示假成功。

詳細文件：

- `docs/data-architecture.md`
- `docs/strategy-formulas.md`
- `docs/validation-report.md`

## 重要免責

本產品是研究與風險規劃工具，不構成投資建議，也不會自動下單。永續合約可能造成超過預期的快速損失；所有策略都必須搭配停損與個人風險上限。

## 部署說明

本專案有 **兩套執行路徑**，不要混用腳本：

### 1. 主要：OpenAI Sites / Cloudflare（推薦）

身分由 ChatGPT Sites 注入（`oai-authenticated-user-id`），使用者資料走 Cloudflare D1。

```bash
npm install
npm run dev      # vinext
npm run build    # vinext build
```

需要正確的 `.openai/hosting.json` D1 binding，以及 Sites 控制平面注入的環境。

### 2. 次要：Vercel（僅公開行情 + 本機偏好）

Vercel **沒有** Cloudflare D1 與 Sites 使用者身分，因此：

- 市場行情 API（OKX）可正常運作
- 警報、日誌、自選清單會降級為 **瀏覽器 localStorage（僅此裝置）**
- 不會出現「假同步成功」

部署時請使用：

```bash
npm run build:vercel   # 即 next build --webpack
npm run start:vercel
```

`vercel.json` 已指定 `buildCommand: npm run build:vercel`。  
Node 版本請固定 **22.x**（見 `package.json` engines 與 `.nvmrc`）。

若在 Vercel 看到 `cloudflare:workers` 相關錯誤，確認 `next.config.ts` 的 shim 有被套用（`VERCEL` 環境變數存在時會自動 alias）。

### 不建議

- 在 Vercel 上跑 `npm run build`（那是 vinext／Cloudflare 路徑）
- 期待 Vercel 上有跨裝置雲端同步（需 Sites + D1）
