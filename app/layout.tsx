import type { Metadata } from "next";
import "./globals.css";

const productionHost = process.env.VERCEL_PROJECT_PRODUCTION_URL;
const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? (productionHost ? `https://${productionHost}` : "https://cheese-and-egg.runningman2014shine.chatgpt.site");

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: "Cheese&Egg｜Crypto Decision Workbench",
  description: "整合 OKX 永續合約行情、交易所帳戶多空傾向、七套策略計畫、風險計算與資料健康的交易決策工作台。",
  openGraph: {
    title: "Cheese&Egg｜Crypto Decision Workbench",
    description: "真實行情、衍生品帳戶傾向、策略與風險管理，一個清楚的加密交易決策工作台。",
    url: siteUrl,
    siteName: "Cheese&Egg",
    locale: "zh_TW",
    type: "website",
    images: [{
      url: "/og.jpg",
      width: 1200,
      height: 630,
      alt: "Cheese&Egg Crypto Decision Workbench",
    }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Cheese&Egg｜Crypto Decision Workbench",
    description: "真實行情、交易所帳戶多空傾向、策略與風險管理工作台。",
    images: ["/og.jpg"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-Hant" data-theme="light" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: "try{var t=localStorage.getItem('ce-theme-v1');document.documentElement.dataset.theme=t==='dark'?'dark':'light'}catch(e){}",
          }}
        />
      </head>
      <body>
        {children}
      </body>
    </html>
  );
}

