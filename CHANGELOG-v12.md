# Cheese&Egg v12

## 相對你提供的決策 TV 包，v12 實際改動

### 行情（必看）
- **刪除** `lib/market/providers/binance.ts`
- `lib/market/hub.ts`：只打 OKX（stage = `using-okx`）
- `lib/market/merge.ts`：OKX 為 primary
- `lib/market/providers/okx.ts`：接上大戶多空比
  `GET /api/v5/rubik/stat/contracts/long-short-account-ratio-contract-top-trader`

### 文案／健康頁
- 載入與資料健康改為 OKX 主行情（不再寫 Binance 備援）
- 衍生品頁說明標註資料來自 OKX

### 未改動（依你要求）
- `TradingViewWidget.tsx`
- 決策頁 ChartView／TV 版面（維持你改好的）

## 自檢
```bash
ls lib/market/providers/          # 應只有 okx.ts
grep getBinanceData lib/market/hub.ts   # 應無輸出
grep top-trader lib/market/providers/okx.ts  # 應有命中
```
