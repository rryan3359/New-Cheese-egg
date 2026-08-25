import { z } from "zod";
import type { MarketHubPayload } from "./types";

const metricSchema = z.object({
  value: z.unknown().nullable(),
  source: z.enum(["OKX", "Alternative.me", "Calculated"]),
  state: z.enum(["live", "stale", "missing"]),
  updatedAt: z.string().datetime(),
  latencyMs: z.number().nonnegative().nullable(),
  reason: z.string().nullable(),
}).passthrough();

const candleSchema = z.object({ time: z.number().finite(), open: z.number().finite(), high: z.number().finite(), low: z.number().finite(), close: z.number().finite(), volume: z.number().finite() }).strict();
const timeframeSchema = z.object({ timeframe: z.enum(["15m", "1h", "4h", "1d"]), candles: z.array(candleSchema).max(400) }).passthrough();
const strategySchema = z.object({
  id: z.string().min(1).max(200), symbol: z.string().regex(/^[A-Z0-9]{2,20}$/), timeframe: z.enum(["15m", "1h", "4h", "1d"]),
  strategy: z.enum(["Trend Pullback", "Breakout", "Volatility Squeeze", "Funding Mean Reversion", "Positioning Divergence", "ICT Liquidity Sweep", "Range Mean Reversion"]),
  status: z.enum(["eligible", "waiting", "invalid", "missing"]), primaryRiskReward: z.number().finite().nullable(), updatedAt: z.string().datetime(),
}).passthrough();
const assetSchema = z.object({
  symbol: z.string().regex(/^[A-Z0-9]{2,20}$/),
  price: metricSchema, funding: metricSchema, openInterest: metricSchema, oiChange1h: metricSchema, positioning: metricSchema,
  timeframes: z.object({ "15m": timeframeSchema, "1h": timeframeSchema, "4h": timeframeSchema, "1d": timeframeSchema }).strict(),
  strategies: z.array(strategySchema).max(40),
}).passthrough();

const snapshotSchema = z.object({
  success: z.literal(true),
  updatedAt: z.string().datetime(),
  staleExpiresAt: z.string().datetime().nullable(),
  assets: z.array(assetSchema).min(1).max(50),
  health: z.array(z.object({ name: z.enum(["OKX", "Alternative.me"]), state: z.enum(["live", "stale", "missing"]) }).passthrough()).min(1),
  pipeline: z.object({ mode: z.literal("normal"), marketApiDurationMs: z.number().nonnegative() }).passthrough(),
}).passthrough();

export function validateAlertSnapshot(input: unknown, now = Date.now()): MarketHubPayload {
  const parsed = snapshotSchema.parse(input);
  const snapshotTime = new Date(parsed.updatedAt).getTime();
  if (snapshotTime > now + 60_000) throw new Error("市場 snapshot 時間位於未來");
  const expiresAt = parsed.staleExpiresAt ? new Date(parsed.staleExpiresAt).getTime() : snapshotTime + 10 * 60_000;
  if (now > expiresAt) throw new Error("市場 snapshot 已超過 10 分鐘保留期限");
  return parsed as unknown as MarketHubPayload;
}

