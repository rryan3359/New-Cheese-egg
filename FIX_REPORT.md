# Cheese&Egg v12 修正與驗證報告

日期：2026-08-25  
正式驗證環境：Node.js 22.23.2、npm 11.17.0  
部署狀態：依交付要求，未部署網站。

## 根因與主要修正

- `lib/market/hub.ts` 使用未定義的 `cacheKey`，使型別檢查、build、測試與 `/api/crypto` 中斷。現在使用 `okx:l1`、`okx:l2`、`okx:l3` 三個獨立快取鍵，並保留同 tier 的 fresh cache、in-flight coalescing、stale-good-data 與測試注入能力。
- 移除已失去意義的 `_forceOkx`、`lastOkxHealth`、`unique` 與假 fallback 狀態；`provider=okx` 僅作舊網址相容 alias，回應加上 `X-Cheese-Egg-Provider-Alias: okx-compat`。
- OKX 缺少 OI、Funding、多空比、K 線或指標時保留 `null`／`missing`／`N/A`，不再轉為 0、廣度或方向訊號。
- `/api/crypto` 對一般使用者只回傳安全錯誤 `MARKET_UNAVAILABLE`；內部錯誤只留在伺服器端日誌。
- `OKX_BASE_URL` 現在真正控制 OKX provider endpoint，可用於環境設定與可靠的失敗情境驗證。

## 快取、載入與失敗降級

- 市場 L1 與 `/api/user-data`／D1 獨立並行啟動；L1 成功就立即顯示。
- L2、L3 使用 `Promise.allSettled` 並行補齊，單一 tier 失敗不覆蓋其他成功 tier。
- 刷新具備 `AbortController`、request identity、卸載清理與同步 data ref；自動刷新在分頁隱藏時暫停，重新可見後安全更新。
- 首次與使用者手動刷新不會被背景分頁狀態誤擋；警報判定在首屏行情後非阻塞執行。
- 最後成功快照保留原更新時間並標成 stale；沒有快照時 PriceTicker 顯示「行情暫時不可用」，不會永久停在「載入中」。
- 行情失敗時，市場駕駛艙、掃描器、衍生品、策略與圖表各自顯示 unavailable；設定、交易日誌、警報歷史、資料健康與離線風險試算仍可開啟。

## 手機 UX、無障礙與資料信任

- 480px 以下的掃描器、衍生品、資料健康與日誌改為摘要卡片，保留 symbol、方向、狀態、信心、RR、Entry、Stop、更新時間與資料狀態；頁面無水平溢位。
- 手機底部面板：light `rgba(255,255,255,0.32)`、dark `rgba(22,26,22,0.38)`、`blur(26px) saturate(1.42)`；未選取文字／圖示使用 78% 視覺不透明度，按鈕最小高度 48px，保留 safe-area 與 112px 內容下方空間。
- 「更多功能」具備 dialog／modal ARIA、`aria-expanded`、`aria-controls`、Escape、焦點移入、雙向 focus trap、關閉後焦點還原、背景點擊關閉、背景捲動鎖定、`:focus-visible` 與 reduced-motion。
- TradingView Widget 保留 `BINANCE:<symbol>` 圖表來源，但明確標示策略來自 OKX Market Data Hub，兩者價格與 K 線不保證一致；Trade Plan 的 Entry、Stop、TP、RR 仍以 Market Data Hub 為準。

## 執行與文件

- Next.js／Vercel 主路徑：`npm run dev`、`npm run build`、`npm run start`。
- Sites／Vinext 次要路徑：`npm run dev:sites`、`npm run build:sites`、`npm run start:sites`。
- README、DEPLOY、`.env.example`、metadata、vercel 設定已統一為 OKX-only 市場來源；不存在的 `build:vercel`、`start:vercel` 與 `docs/*` 連結已移除。
- `package-lock.json` 由 Node.js 22 正式重建；`.openai/hosting.json` 原 project_id 與 D1 binding 的 SHA-256 前後一致。

## 最終正式驗證

依序從乾淨生成狀態執行：

1. `npm ci`：通過；安裝 475 個 packages。npm audit 報告 16 個相依套件問題（4 moderate、12 high），未以破壞性 `--force` 自動修改。
2. `npx tsc --noEmit`：通過，0 errors。
3. `npm test`：通過，22 pass、0 fail。
4. `npm run lint`：通過，0 errors、0 warnings。
5. `npm run build`：通過；Next.js 16.2.6 production build 與內建 TypeScript 檢查成功。
6. `npm run build:sites`：通過；Vinext build complete。保留 Vinext 對 `next.config` webpack 選項與部分 route 靜態分類能力的非阻斷警告。

瀏覽器驗證：

- 正常 OKX：`/api/crypto?tier=l1` 回傳 200、15 個 L1 assets、`stage=using-okx`；相容 alias 回傳 `okx-compat` header。
- 桌面 light／dark 與十個功能區均可開啟；390×844、430×932 的 light／dark 已在指定 responsive viewport 量測面板樣式與溢位。
- 四個手機尺寸／主題組合，以及桌面所有檢查點均為 `scrollWidth === clientWidth`。
- 行情失敗：API 回傳 503、`MARKET_UNAVAILABLE`，無 ReferenceError／stack 泄漏；設定、日誌、警報、風險與資料健康仍可使用。
- 更多選單鍵盤操作、焦點 trap／還原、背景關閉與 scroll lock 通過；互動後 browser console 無 React、Next、hydration error 或 warning。

## 修改檔案

`.env.example`、`README.md`、`DEPLOY.md`、`FIX_REPORT.md`、`package-lock.json`、`vercel.json`、`next.config.ts`、`next-env.d.ts`、`app/layout.tsx`、`app/CryptoWorkbench.tsx`、`app/globals.css`、`app/hooks/useMarketData.ts`、`app/api/crypto/route.ts`、`app/api/user-data/route.ts`、`app/workbench/MarketViews.tsx`、`ToolViews.tsx`、`TradingViewWidget.tsx`、`shell/DataBanners.tsx`、`MobileNav.tsx`、`PriceTicker.tsx`、`Sidebar.tsx`、`Topbar.tsx`、`lib/market/http.ts`、`hub.ts`、`merge.ts`、`snapshot.ts`、`symbols.ts`、`types.ts`、`providers/okx.ts`、`tests/workbench.test.ts`。

## 已知非阻斷事項

- npm audit 的 16 個間接相依套件問題仍需個別評估升級，未使用 `npm audit fix --force` 以避免破壞 Next／Vinext 相容性。
- npm 11 的 allow-scripts 提示列出 esbuild、sharp、workerd 等 6 個待審 install scripts；本次兩條 build 均已實際通過。
- TradingView 圖表仍可能是 Binance symbol；此差異已在 UI 明確揭露，沒有偽造與 OKX 策略資料一致。
- Windows 瀏覽器工具最初匯出的四張手機 PNG 只包含扣除傳統捲軸後的 client area（374×844、415×932）。已加入 480px 以下不保留 desktop-emulation scrollbar gutter 的 CSS，但重新擷取精確 390×844、430×932 PNG 時被瀏覽器安全策略阻擋，因此最後這一步無法再次視覺確認；原四張實測截圖仍隨交付目錄提供。
- 依要求未執行部署，因此沒有線上 URL 或遠端 hosting runtime 驗證。
