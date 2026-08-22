# Cheese&Egg · 本機開發 → Git → Vercel

這份專案已調成 **以 Next.js + Vercel 為主**。  
（原本的 OpenAI Sites / vinext 仍可用：`npm run dev:sites` / `npm run build:sites`）

## 你會得到什麼

| 功能 | Vercel 上 |
|------|-----------|
| 市場行情（Binance / OKX） | ✅ 正常 |
| 策略、圖表、掃描器、風險、日誌 UI | ✅ 正常 |
| 警報、自選、設定、日誌儲存 | ✅ 存在**瀏覽器本機**（僅此裝置） |
| 跨裝置雲端同步（D1） | ❌ 需要 OpenAI Sites |

## 一、在自己電腦跑起來

需求：Node.js **22.x**（見 `.nvmrc`）

```bash
# 1. 解壓後進入資料夾
cd cheese-egg-desk   # 或你的資料夾名

# 2. 安裝
npm install

# 3. 本機開發
npm run dev
# 開 http://localhost:3000
```

## 二、丟上 GitHub

```bash
git init
git add .
git commit -m "Cheese&Egg workbench ready for Vercel"
# 在 GitHub 新建空 repo 後：
git branch -M main
git remote add origin https://github.com/你的帳號/你的repo.git
git push -u origin main
```

（若 repo 已存在，把檔案覆蓋進去再 `git add -A && git commit && git push` 即可。）

## 三、接 Vercel

1. 開 [vercel.com](https://vercel.com) → Import 該 GitHub repo  
2. Framework 選 **Next.js**（或讓它自動偵測）  
3. Build Command 應為 `npm run build`（`vercel.json` 已寫好）  
4. Node.js Version 選 **22.x**  
5. Deploy  

不需要填 API Key（公開行情）。  
環境變數可不設；有 `NEXT_PUBLIC_SITE_URL` 可選填正式網址。

## 四、部署後預期畫面

- 行情、策略、圖表可看  
- 上方或橫幅可能顯示「保存在這台裝置」→ 正常  
- 重新整理後自選／警報仍在（同一瀏覽器）

## 常見錯誤

| 狀況 | 處理 |
|------|------|
| Build 用了 vinext / Cloudflare 錯 | 確認跑的是 `npm run build`，不是 `build:sites` |
| `cloudflare:workers` 找不到 | `next.config.ts` 已 shim，拉最新程式再 deploy |
| Node 版本警告 | Project Settings → Node.js → 22.x |
| 想要跨裝置同步 | 需回到 OpenAI Sites + D1，不是純 Vercel |

## 給其他 AI 的提示（可直接貼）

> 這是 Next.js 16 + React 19 的加密貨幣工作台。  
> 本機用 `npm run dev`，上線用 `npm run build` + Vercel。  
> 不要改成跑 vinext，除非我明確說要 OpenAI Sites。  
> 使用者資料在 Vercel 上走 localStorage 降級，行情走 `/api/crypto`。
