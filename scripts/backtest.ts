import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { runBacktest, type BacktestDataset } from "../lib/backtest/engine";
import { TIMEFRAMES, type Candle, type CandleMap, type Timeframe } from "../lib/market/types";

const duration: Record<Timeframe, number> = { "1m": 60_000, "5m": 300_000, "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000 };

function deterministicCandles(timeframe: Timeframe, count: number): Candle[] {
  const start = Date.UTC(2025, 0, 1);
  const interval = duration[timeframe];
  return Array.from({ length: count }, (_, index) => {
    const cycle = Math.sin(index / 13) * 2.4 + Math.sin(index / 37) * 4.8;
    const regime = index < count * 0.42 ? index * 0.045 : index < count * 0.7 ? count * 0.019 : count * 0.019 - (index - count * 0.7) * 0.038;
    const close = 100 + regime + cycle;
    const previous = index === 0 ? close : 100 + (index - 1 < count * 0.42 ? (index - 1) * 0.045 : index - 1 < count * 0.7 ? count * 0.019 : count * 0.019 - (index - 1 - count * 0.7) * 0.038) + Math.sin((index - 1) / 13) * 2.4 + Math.sin((index - 1) / 37) * 4.8;
    const spread = 0.35 + Math.abs(Math.sin(index / 5)) * 0.45;
    return { time: start + index * interval, open: previous, high: Math.max(previous, close) + spread, low: Math.min(previous, close) - spread, close, volume: 100 + (index % 19 === 0 ? 180 : 0) + Math.abs(Math.sin(index / 7)) * 35 };
  });
}

function smokeFixture(): BacktestDataset[] {
  const candlesByTimeframe = Object.fromEntries(TIMEFRAMES.map((timeframe) => [timeframe, deterministicCandles(timeframe, timeframe === "1d" ? 180 : timeframe === "4h" ? 220 : 420)])) as CandleMap;
  return [{ symbol: "BTCUSDT", candlesByTimeframe }];
}

function argValue(args: string[], name: string) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export async function main(args: string[]) {
  const inputPath = argValue(args, "--input");
  const outputPath = resolve(argValue(args, "--output") ?? "reports/backtest-v13-sample.json");
  const datasets = inputPath
    ? JSON.parse(await readFile(resolve(inputPath), "utf8")) as BacktestDataset[]
    : smokeFixture();
  const report = runBacktest(datasets);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify({
    dataset: inputPath ? resolve(inputPath) : "deterministic-smoke-fixture (synthetic; not evidence of profitability)",
    report,
  }, null, 2)}\n`, "utf8");
  return { outputPath, comparisons: report.comparisons.map((row) => ({ strategy: row.strategy, minimumNetRr: row.minimumNetRr, ...row.metrics })) };
}
