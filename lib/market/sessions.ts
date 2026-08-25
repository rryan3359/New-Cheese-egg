import { atr, bollinger, bollingerWidthPercentile, swingLevels } from "./indicators";
import type { Candle, CandleMap, MarketEvent, SessionContext, SessionLevel } from "./types";

type ZonedParts = { year: number; month: number; day: number; hour: number; minute: number; weekday: string };
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function zonedParts(date: Date, timeZone: string): ZonedParts {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      hourCycle: "h23",
    });
    formatterCache.set(timeZone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour), minute: Number(parts.minute), weekday: parts.weekday,
  };
}

/** Convert an IANA-zone wall clock to UTC without a third-party timezone database. */
function zonedToUtc(year: number, month: number, day: number, hour: number, timeZone: string) {
  const guess = Date.UTC(year, month - 1, day, hour);
  const observed = zonedParts(new Date(guess), timeZone);
  const observedAsUtc = Date.UTC(observed.year, observed.month - 1, observed.day, observed.hour, observed.minute);
  let resolved = guess - (observedAsUtc - guess);
  const second = zonedParts(new Date(resolved), timeZone);
  const secondAsUtc = Date.UTC(second.year, second.month - 1, second.day, second.hour, second.minute);
  resolved -= secondAsUtc - Date.UTC(year, month - 1, day, hour);
  return resolved;
}

function shiftLocalDate(parts: ZonedParts, days: number) {
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

type SessionDefinition = { name: SessionContext["name"]; label: string; timezone: string; openHour: number; closeHour: number };
const SESSIONS: SessionDefinition[] = [
  { name: "Asia", label: "亞洲盤", timezone: "UTC", openHour: 0, closeHour: 8 },
  { name: "London", label: "倫敦盤", timezone: "Europe/London", openHour: 8, closeHour: 16 },
  { name: "New York", label: "紐約盤", timezone: "America/New_York", openHour: 8, closeHour: 17 },
];

export function currentSession(now = new Date()): SessionContext {
  // Prefer the later liquidity window during overlaps.
  const active = [...SESSIONS].reverse().find((session) => {
    const local = zonedParts(now, session.timezone);
    return local.hour >= session.openHour && local.hour < session.closeHour;
  });
  if (!active) {
    const utc = zonedParts(now, "UTC");
    return { name: "Off-session", label: "主要時段外", timezone: "UTC", localTime: `${String(utc.hour).padStart(2, "0")}:${String(utc.minute).padStart(2, "0")} UTC`, opensAt: null, closesAt: null };
  }
  const local = zonedParts(now, active.timezone);
  const opensAt = zonedToUtc(local.year, local.month, local.day, active.openHour, active.timezone);
  const closesAt = zonedToUtc(local.year, local.month, local.day, active.closeHour, active.timezone);
  return {
    name: active.name,
    label: active.label,
    timezone: active.timezone,
    localTime: `${String(local.hour).padStart(2, "0")}:${String(local.minute).padStart(2, "0")} ${active.timezone}`,
    opensAt: new Date(opensAt).toISOString(),
    closesAt: new Date(closesAt).toISOString(),
  };
}

function rangeLevel(candles: Candle[], start: number, end: number, highKind: SessionLevel["kind"], lowKind: SessionLevel["kind"], label: string, sourceTimeframe: SessionLevel["sourceTimeframe"]): SessionLevel[] {
  const rows = candles.filter((candle) => candle.time >= start && candle.time < end);
  if (!rows.length) return [];
  return [
    { id: `${highKind}-${start}`, label: `${label} High`, kind: highKind, price: Math.max(...rows.map((row) => row.high)), startedAt: new Date(start).toISOString(), endedAt: new Date(end).toISOString(), sourceTimeframe },
    { id: `${lowKind}-${start}`, label: `${label} Low`, kind: lowKind, price: Math.min(...rows.map((row) => row.low)), startedAt: new Date(start).toISOString(), endedAt: new Date(end).toISOString(), sourceTimeframe },
  ];
}

function previousSessionInterval(now: Date, session: SessionDefinition) {
  const local = zonedParts(now, session.timezone);
  const todayStart = zonedToUtc(local.year, local.month, local.day, session.openHour, session.timezone);
  const todayEnd = zonedToUtc(local.year, local.month, local.day, session.closeHour, session.timezone);
  if (now.getTime() >= todayEnd) return { start: todayStart, end: todayEnd };
  const previous = shiftLocalDate(local, -1);
  return {
    start: zonedToUtc(previous.year, previous.month, previous.day, session.openHour, session.timezone),
    end: zonedToUtc(previous.year, previous.month, previous.day, session.closeHour, session.timezone),
  };
}

function equalHighLowLevels(candles: Candle[]): SessionLevel[] {
  const recent = candles.slice(-120);
  const tolerance = Math.max((recent.at(-1)?.close ?? 0) * 0.0004, (atr(recent) ?? 0) * 0.08);
  if (!tolerance) return [];
  const highs: Candle[] = [];
  const lows: Candle[] = [];
  for (let index = 2; index < recent.length - 2; index += 1) {
    const row = recent[index];
    const window = recent.slice(index - 2, index + 3);
    if (row.high === Math.max(...window.map((item) => item.high))) highs.push(row);
    if (row.low === Math.min(...window.map((item) => item.low))) lows.push(row);
  }
  const pair = (rows: Candle[], side: "high" | "low") => {
    for (let index = rows.length - 1; index > 0; index -= 1) {
      const current = rows[index][side];
      const previous = rows.slice(0, index).reverse().find((row) => Math.abs(row[side] - current) <= tolerance);
      if (previous) return { price: (previous[side] + current) / 2, start: previous.time, end: rows[index].time };
    }
    return null;
  };
  const eqh = pair(highs, "high");
  const eql = pair(lows, "low");
  return [
    ...(eqh ? [{ id: `EQH-${eqh.end}`, label: "Equal Highs", kind: "EQH" as const, price: eqh.price, startedAt: new Date(eqh.start).toISOString(), endedAt: new Date(eqh.end).toISOString(), sourceTimeframe: "5m" as const }] : []),
    ...(eql ? [{ id: `EQL-${eql.end}`, label: "Equal Lows", kind: "EQL" as const, price: eql.price, startedAt: new Date(eql.start).toISOString(), endedAt: new Date(eql.end).toISOString(), sourceTimeframe: "5m" as const }] : []),
  ];
}

export function buildSessionLevels(candles: CandleMap, now = new Date()): SessionLevel[] {
  const hourly = candles["1h"];
  const currentDayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const previousDayStart = currentDayStart - 86_400_000;
  const weekday = new Date(currentDayStart).getUTCDay() || 7;
  const currentWeekStart = currentDayStart - (weekday - 1) * 86_400_000;
  const previousWeekStart = currentWeekStart - 7 * 86_400_000;
  const levels: SessionLevel[] = [
    ...rangeLevel(hourly, previousDayStart, currentDayStart, "PDH", "PDL", "Previous Day", "1h"),
    ...rangeLevel(hourly, previousWeekStart, currentWeekStart, "PWH", "PWL", "Previous Week", "1h"),
  ];
  const kinds: Array<[SessionLevel["kind"], SessionLevel["kind"]]> = [["ASIA_HIGH", "ASIA_LOW"], ["LONDON_HIGH", "LONDON_LOW"], ["NEW_YORK_HIGH", "NEW_YORK_LOW"]];
  SESSIONS.forEach((session, index) => {
    const interval = previousSessionInterval(now, session);
    levels.push(...rangeLevel(candles["15m"], interval.start, interval.end, kinds[index][0], kinds[index][1], session.label, "15m"));
  });
  levels.push(...equalHighLowLevels(candles["5m"]));
  const swings = swingLevels(candles["5m"].slice(0, -1));
  if (swings) {
    const stamp = candles["5m"].at(-2)?.time ?? now.getTime();
    levels.push(
      { id: `SWING_HIGH-${stamp}`, label: "Swing High", kind: "SWING_HIGH", price: swings.high, startedAt: new Date(stamp).toISOString(), endedAt: new Date(stamp).toISOString(), sourceTimeframe: "5m" },
      { id: `SWING_LOW-${stamp}`, label: "Swing Low", kind: "SWING_LOW", price: swings.low, startedAt: new Date(stamp).toISOString(), endedAt: new Date(stamp).toISOString(), sourceTimeframe: "5m" },
    );
  }
  return levels.filter((level, index, all) => Number.isFinite(level.price) && all.findIndex((candidate) => candidate.kind === level.kind && Math.abs(candidate.price - level.price) < Number.EPSILON) === index);
}

export function buildMarketEvents(symbol: string, candles: CandleMap, levels: SessionLevel[], funding: number | null, oiChange1h: number | null): MarketEvent[] {
  const events: MarketEvent[] = [];
  const five = candles["5m"];
  const recent = five.slice(-12);
  for (let candleIndex = recent.length - 1; candleIndex >= 0; candleIndex -= 1) {
    const candle = recent[candleIndex];
    const sweptHigh = levels.find((level) => level.kind.endsWith("HIGH") || level.kind === "PDH" || level.kind === "PWH" || level.kind === "EQH" ? candle.high > level.price && candle.close < level.price : false);
    const sweptLow = levels.find((level) => level.kind.endsWith("LOW") || level.kind === "PDL" || level.kind === "PWL" || level.kind === "EQL" ? candle.low < level.price && candle.close > level.price : false);
    const swept = sweptHigh ?? sweptLow;
    if (swept) {
      const direction = sweptHigh ? "Short" : "Long";
      events.push({ id: `${symbol}-sweep-${candle.time}-${swept.id}`, symbol, kind: "liquidity_sweep", direction, headline: `${symbol.replace("USDT", "")} 掃過 ${swept.label}`, detail: `影線越過 ${swept.price} 後以已收盤 5m K 線收回。`, occurredAt: new Date(candle.time + 300_000).toISOString(), source: "Calculated", confidence: "high" });
      break;
    }
  }
  if (five.length >= 20) {
    const last = five.at(-1)!;
    const prior = swingLevels(five.slice(-40, -1));
    if (prior && last.close > prior.high) events.push({ id: `${symbol}-bos-up-${last.time}`, symbol, kind: "bos", direction: "Long", headline: `${symbol.replace("USDT", "")} 5m 收盤突破結構高點`, detail: `已收盤 K 線站上 ${prior.high}，標記為 BOS；不是單獨進場訊號。`, occurredAt: new Date(last.time + 300_000).toISOString(), source: "Calculated", confidence: "medium" });
    if (prior && last.close < prior.low) events.push({ id: `${symbol}-bos-down-${last.time}`, symbol, kind: "bos", direction: "Short", headline: `${symbol.replace("USDT", "")} 5m 收盤跌破結構低點`, detail: `已收盤 K 線跌破 ${prior.low}，標記為 BOS；不是單獨進場訊號。`, occurredAt: new Date(last.time + 300_000).toISOString(), source: "Calculated", confidence: "medium" });
  }
  const fifteen = candles["15m"];
  if (fifteen.length >= 45) {
    const current = bollinger(fifteen.map((row) => row.close));
    const previous = bollinger(fifteen.slice(0, -1).map((row) => row.close));
    const percentile = bollingerWidthPercentile(fifteen.slice(0, -1));
    if (current?.width && previous?.width && percentile !== null && percentile <= 20 && current.width > previous.width * 1.05) {
      const last = fifteen.at(-1)!;
      events.push({ id: `${symbol}-bb-${last.time}`, symbol, kind: "bb_expansion", direction: last.close > current.middle ? "Long" : "Short", headline: `${symbol.replace("USDT", "")} BB 壓縮後開始擴張`, detail: `前一根 BB Width 位於歷史 ${percentile.toFixed(0)} 百分位，現寬度正在增加。`, occurredAt: new Date(last.time + 900_000).toISOString(), source: "Calculated", confidence: "medium" });
    }
  }
  const eventTime = candles["1h"].at(-1)?.time ?? Date.now();
  if (funding !== null && Math.abs(funding) >= 0.0005) events.push({ id: `${symbol}-funding-${eventTime}`, symbol, kind: "funding_anomaly", direction: "Neutral", headline: `${symbol.replace("USDT", "")} Funding 異常`, detail: `Funding ${(funding * 100).toFixed(4)}%；僅作背景確認，不產生方向。`, occurredAt: new Date(eventTime).toISOString(), source: "OKX", confidence: "high" });
  if (oiChange1h !== null && Math.abs(oiChange1h) >= 4) events.push({ id: `${symbol}-oi-${eventTime}`, symbol, kind: "oi_anomaly", direction: "Neutral", headline: `${symbol.replace("USDT", "")} OI 1h 異常變化`, detail: `OI 1h ${oiChange1h.toFixed(2)}%；僅作背景確認，不產生方向。`, occurredAt: new Date(eventTime).toISOString(), source: "OKX", confidence: "high" });
  return events.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
}
