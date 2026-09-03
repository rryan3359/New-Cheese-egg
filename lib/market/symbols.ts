/** Core OKX USDT perpetual symbols.
 *  ~30 high-liquidity USDT perps (by contract liquidity, not spot market-cap top 100).
 */
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
  "POL",
  "LTC",
  "ATOM",
  "NEAR",
  "APT",
  "ARB",
  "OP",
  "SUI",
  "INJ",
  "FIL",
  "UNI",
  "AAVE",
  "PEPE",
  "WIF",
  "TIA",
  "SEI",
  "HBAR",
  "TRX",
  "BCH",
  "ETC",
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
  POL: "Polygon Ecosystem Token",
  LTC: "Litecoin",
  ATOM: "Cosmos",
  NEAR: "NEAR",
  APT: "Aptos",
  ARB: "Arbitrum",
  OP: "Optimism",
  SUI: "Sui",
  INJ: "Injective",
  FIL: "Filecoin",
  UNI: "Uniswap",
  AAVE: "Aave",
  PEPE: "Pepe",
  WIF: "dogwifhat",
  TIA: "Celestia",
  SEI: "Sei",
  HBAR: "Hedera",
  TRX: "TRON",
  BCH: "Bitcoin Cash",
  ETC: "Ethereum Classic",
};

/**
 * Priority order for progressive / first-paint loading (L1).
 * Cockpit becomes usable once these have price + funding.
 */
export const PRIORITY_SYMBOLS = [
  "BTCUSDT",
  "ETHUSDT",
  "SOLUSDT",
  "BNBUSDT",
  "XRPUSDT",
  "DOGEUSDT",
  "ADAUSDT",
  "AVAXUSDT",
  "LINKUSDT",
  "DOTUSDT",
  "SUIUSDT",
  "ARBUSDT",
  "OPUSDT",
  "NEARUSDT",
  "APTUSDT",
] as const;

export type SymbolTier = "priority" | "core";

export function symbolsForTier(tier: "l1" | "l2" | "l3"): string[] {
  if (tier === "l1") return [...PRIORITY_SYMBOLS];
  return [...CORE_SYMBOLS];
}

export function isPrioritySymbol(symbol: string): boolean {
  return (PRIORITY_SYMBOLS as readonly string[]).includes(symbol);
}
