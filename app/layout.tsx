import type { Metadata } from "next";
import "./globals.css";
import "./warm-editorial.css";

const productionHost = process.env.VERCEL_PROJECT_PRODUCTION_URL;
const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? (productionHost ? `https://${productionHost}` : "https://cheese-and-egg.runningman2014shine.chatgpt.site");

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: "Cheese&Egg｜日內量化決策台",
  description: "整合 OKX 已收盤永續 K 線、三套日內策略、結構目標、淨 RR、風控與資料健康的量化決策台。",
  openGraph: {
    title: "Cheese&Egg｜日內量化決策台",
    description: "交易總攬、三套策略、真實結構目標與淨 RR；沒有好機會時，等待也是交易決策。",
    url: siteUrl,
    siteName: "Cheese&Egg",
    locale: "zh_TW",
    type: "website",
    images: [{
      url: "/og.jpg",
      width: 1200,
      height: 630,
      alt: "Cheese&Egg 日內量化決策台",
    }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Cheese&Egg｜日內量化決策台",
    description: "OKX 已收盤行情、三套日內策略、結構目標與淨 RR。",
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
            __html: "try{var t=localStorage.getItem('ce-theme-v1');var m=t==='dark'?'dark':'light';document.documentElement.dataset.theme=m;document.documentElement.style.colorScheme=m}catch(e){}",
          }}
        />
      </head>
      <body>
        {children}
      </body>
    </html>
  );
}

