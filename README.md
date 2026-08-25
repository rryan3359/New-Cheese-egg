# Cheese&Egg v12

Cheese&Egg 是以繁體中文呈現的加密交易決策工作台。專案保留七套策略、Trade Plan、風險計算、警報、交易日誌、D1、TradingView 版面與既有 Cheese／Egg 品牌。

## 資料信任原則

- Market Data Hub 僅使用 OKX 公開永續合約資料；不需要交易所 API key。
- 價格、Funding、OI、多空比、K 線或衍生指標缺少時顯示 `N/A`／資料不足，不會補成 0，也不會據此產生方向訊號。
- 最近成功快照可在短暫故障時以 stale 狀態保留，畫面會標示最後成功時間。
- `provider=okx` 只為舊網址相容而保留，和一般請求使用相同 OKX 管線與 tier 快取，不是備援測試。
- TradingView Widget 目前可能顯示 `BINANCE:<symbol>` 圖表；策略數字仍來自 OKX Market Data Hub。兩者不保證完全一致，Entry、Stop、TP 與 RR 一律以 Trade Plan 為準。

## 環境需求

- Node.js 22.x（見 `.nvmrc` 與 `package.json#engines`）
- npm

首次安裝：

```bash
npm ci
```

## 主要執行路徑：Next.js／Vercel

```bash
npm run dev
npm run build
npm run start
```

本機開發預設為 `http://localhost:3000`。`vercel.json` 以 `npm ci` 安裝並執行 `npm run build`。

## 次要執行路徑：Sites／Vinext

```bash
npm run dev:sites
npm run build:sites
npm run start:sites
```

`.openai/hosting.json` 保留既有 Sites `project_id` 與 D1 `DB` binding。不要重新初始化 Sites 專案或替換該 metadata。

## 漸進式行情流程

1. L1 先取得優先市場關鍵行情，成功後立即顯示市場駕駛艙。
2. L2 與 L3 並行補齊衍生品和 K 線／策略資料。
3. 每個 tier 使用獨立 fresh cache、in-flight request coalescing 與 stale-good-data fallback。
4. 單一 tier 失敗時保留其他 tier 的成功結果；分頁隱藏時暫停更新，恢復可見後再安全刷新。
5. 警報使用畫面相同快照判定，但不阻塞第一批行情顯示。

行情完全不可用時，市場駕駛艙、掃描器、衍生品、策略與圖表顯示專屬 unavailable 狀態；設定、交易日誌、警報歷史、資料健康與離線風險試算仍可開啟。

## 使用者資料與 D1

- Sites 路徑可透過既有 D1 binding 保存使用者資料。
- Next.js／Vercel 沒有該 D1 binding 時會誠實降級為裝置端保存，不影響公開行情。
- D1 schema：`db/schema.ts`
- D1 migration：`drizzle/0000_user_workbench.sql`

## 環境變數

複製 `.env.example` 為本機 `.env.local`（如需覆寫）。市場資料只使用：

```text
OKX_BASE_URL=https://www.okx.com
```

Telegram 設定為選填且只能放在伺服器端。請勿提交 `.env`、token、cookie 或 API key。

## 正式驗證

使用 Node.js 22.x 依序執行：

```bash
npm ci
npx tsc --noEmit
npm test
npm run lint
npm run build
npm run build:sites
```

兩條 build 是不同執行路徑；Sites build 通過不能取代 TypeScript、測試、lint 或 Next.js build。

## 免責聲明

本專案僅供研究、紀錄與風險規劃，不構成投資建議，也不會要求交易權限。
