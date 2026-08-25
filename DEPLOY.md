# Cheese&Egg v13 執行與部署文件

本專案以 Next.js／Vercel 為主要路徑，Sites／Vinext 為保留 D1 能力的次要路徑。兩者共用同一份應用程式碼，但 build 指令與執行環境不同。

## 共同要求

- Node.js 22.x
- 使用已提交的 `package-lock.json`
- 安裝指令為 `npm ci`
- Market Data Hub 僅使用 OKX 公開端點
- 策略與圖表均使用 OKX K 線；Funding／OI／Positioning 僅為背景
- 伺服器秘密只放在平台環境變數，不提交 `.env`

正式檢查：

```bash
npm ci
npx tsc --noEmit
npm test
npm run lint
npm run build
npm run build:sites
```

任何一項失敗都要如實記錄；不能用其中一條 build 的成功取代其他檢查。

## 主要路徑：Next.js／Vercel

本機：

```bash
npm run dev
```

正式 build 與啟動：

```bash
npm run build
npm run start
```

`vercel.json` 已設定：

- framework：Next.js
- install command：`npm ci`
- build command：`npm run build`

Vercel 專案請選 Node.js 22.x。若沒有 Sites 的 D1 binding，設定、警報與日誌會明確降級為此裝置保存；公開 OKX 行情不受影響。

可選環境變數：

```text
OKX_BASE_URL=https://www.okx.com
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
```

Telegram 兩個值都未設定時，通知維持「尚未設定」。

## 次要路徑：Sites／Vinext

本機：

```bash
npm run dev:sites
```

正式 build 與啟動：

```bash
npm run build:sites
npm run start:sites
```

必須保留 `.openai/hosting.json` 既有的 `project_id` 與 D1 `DB` binding。不得為了本機驗證建立新 Sites 專案。D1 schema 與 migration 位於：

- `db/schema.ts`
- `drizzle/0000_user_workbench.sql`
- `drizzle/0001_v13_strategy_compat.sql`

## 發布前人工檢查

- `/api/crypto?tier=l1` 回傳 OKX live 或明確 stale 狀態，且不洩漏內部錯誤。
- 桌面、390×844、430×932；淺色與深色主題。
- 今日作戰台、掃描器、衍生品、三策略、圖表、警報、風險、日誌、資料健康與設定。
- Scanner 最低淨 RR 預設 1.5，無合格機會時明確顯示 No Trade。
- 行情失敗時，設定、日誌、警報歷史、資料健康與風險試算仍可操作。
- 手機更多選單支援 Escape、focus trap、焦點返回、背景點擊關閉與背景捲動鎖定。
- 頁面沒有水平溢位，瀏覽器沒有 React、Next、hydration 或 console error。

本文件描述部署方式，不代表某次交付已實際部署。每次交付都應另附當次真實驗證結果與 URL（若有部署）。
