/** Shared core perpetual symbols — keep Binance & OKX in sync. */
export const CORE_BASES = [
  "BTC",
  "ETH",
  "SOL",
  "BNB",
  "XRP",
  "DOGE",
  "ADA",
  "AVAX",
  "LINK",
  "DOT",
  "MATIC",
  "LTC",
  "ATOM",
  "NEAR",
  "APT",
] as const;

export const CORE_SYMBOLS = CORE_BASES.map((base) => `${base}USDT`);

export const ASSET_NAMES: Record<string, string> = {
  BTC: "Bitcoin",
  ETH: "Ethereum",
  SOL: "Solana",
  BNB: "BNB",
  XRP: "XRP",
  DOGE: "Dogecoin",
  ADA: "Cardano",
  AVAX: "Avalanche",
  LINK: "Chainlink",
  DOT: "Polkadot",
  MATIC: "Polygon",
  LTC: "Litecoin",
  ATOM: "Cosmos",
  NEAR: "NEAR",
  APT: "Aptos",
};

/** Priority order for progressive / first-paint loading */
export const PRIORITY_SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT"] as const;
