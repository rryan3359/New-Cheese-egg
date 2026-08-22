"use client";

import { useEffect, useRef } from "react";
import { emaSeries } from "../../lib/market/indicators";
import type { AssetSnapshot, StrategyResult, Timeframe } from "../../lib/market/types";

type Layers = { ema: boolean; volume: boolean; structure: boolean; plan: boolean };

export default function TerminalChart({ asset, timeframe, setup, layers, theme = "dark" }: { asset: AssetSnapshot; timeframe: Timeframe; setup: StrategyResult | null; layers: Layers; theme?: "light" | "dark" }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const layersKey = `${layers.ema}-${layers.volume}-${layers.structure}-${layers.plan}`;
  const setupKey = setup
    ? `${setup.id}:${setup.entryLow}:${setup.entryHigh}:${setup.stop}:${setup.tp1}:${setup.tp2}:${setup.tp3}:${setup.status}:${setup.direction}`
    : "none";
  const candlesKey = asset.timeframes[timeframe].candles.length
    ? `${asset.symbol}-${timeframe}-${asset.timeframes[timeframe].candles.at(-1)?.close}-${asset.timeframes[timeframe].candles.length}`
    : `${asset.symbol}-${timeframe}-empty`;

  useEffect(() => {
    const canvas = canvasRef.current;
    const allCandles = asset.timeframes[timeframe].candles;
    if (!canvas || allCandles.length < 3) return;

    let frame = 0;
    const draw = () => {
      const rect = canvas.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return;
      const ratio = window.devicePixelRatio || 1;
      const nextWidth = Math.round(rect.width * ratio);
      const nextHeight = Math.round(rect.height * ratio);
      if (canvas.width !== nextWidth || canvas.height !== nextHeight) {
        canvas.width = nextWidth;
        canvas.height = nextHeight;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      const width = rect.width;
      const height = rect.height;
      const isLight = theme === "light";
      const palette = isLight
        ? {
            grid: "rgba(30,36,29,.08)",
            upStroke: "#5a7a18",
            upFill: "#6f9420",
            downStroke: "#c44a36",
            downFill: "#d45540",
            volUp: "rgba(110,150,40,.35)",
            volDown: "rgba(200,80,60,.30)",
            ema20: "#8a9e20",
            ema50: "#c48420",
            label: "#5c6358",
            entry: "rgba(140,160,40,.12)",
          }
        : {
            grid: "rgba(255,255,255,.055)",
            upStroke: "#a8c53f",
            upFill: "#829c31",
            downStroke: "#db6650",
            downFill: "#bd5946",
            volUp: "rgba(152,181,60,.25)",
            volDown: "rgba(219,102,80,.23)",
            ema20: "#dbe954",
            ema50: "#efad4d",
            label: "#7a8276",
            entry: "rgba(219,234,84,.075)",
          };
      const candles = allCandles.slice(-90);
      const closes = candles.map((candle) => candle.close);
      const ema20 = emaSeries(closes, 20);
      const ema50 = emaSeries(closes, 50);
      const overlays = layers.plan && setup ? [setup.entryLow, setup.entryHigh, setup.stop, setup.tp1, setup.tp2, setup.tp3].filter((value): value is number => value !== null) : [];
      const low = Math.min(...candles.map((candle) => candle.low), ...overlays);
      const high = Math.max(...candles.map((candle) => candle.high), ...overlays);
      const spread = high - low || 1;
      const priceTop = 18;
      const volumeHeight = layers.volume ? Math.min(100, height * 0.2) : 0;
      const priceBottom = height - 25 - volumeHeight;
      const y = (value: number) => priceTop + ((high - value) / spread) * (priceBottom - priceTop);
      const slot = width / candles.length;
      ctx.clearRect(0, 0, width, height);
      ctx.strokeStyle = palette.grid;
      ctx.lineWidth = 1;
      for (let row = 1; row < 5; row += 1) {
        const lineY = priceTop + ((priceBottom - priceTop) / 5) * row;
        ctx.beginPath();
        ctx.moveTo(0, lineY);
        ctx.lineTo(width, lineY);
        ctx.stroke();
      }

      if (layers.plan && setup && setup.entryLow !== null && setup.entryHigh !== null) {
        ctx.fillStyle = palette.entry;
        ctx.fillRect(0, y(setup.entryHigh), width, Math.max(2, y(setup.entryLow) - y(setup.entryHigh)));
        const levels = [
          { value: setup.stop, color: "#e66c50" },
          { value: setup.tp1, color: "#7e9631" },
          { value: setup.tp2, color: "#9dbb3a" },
          { value: setup.tp3, color: "#c5e44b" },
        ];
        levels.forEach((level) => {
          if (level.value === null) return;
          ctx.setLineDash([5, 5]);
          ctx.strokeStyle = level.color;
          ctx.beginPath();
          ctx.moveTo(0, y(level.value));
          ctx.lineTo(width, y(level.value));
          ctx.stroke();
        });
        ctx.setLineDash([]);
      }

      if (layers.structure) {
        const swingHigh = asset.timeframes[timeframe].swingHigh.value;
        const swingLow = asset.timeframes[timeframe].swingLow.value;
        [
          { value: swingHigh, color: "rgba(241,187,80,.7)" },
          { value: swingLow, color: "rgba(91,183,154,.7)" },
        ].forEach((level) => {
          if (level.value === null) return;
          ctx.setLineDash([2, 6]);
          ctx.strokeStyle = level.color;
          ctx.beginPath();
          ctx.moveTo(0, y(level.value));
          ctx.lineTo(width, y(level.value));
          ctx.stroke();
          ctx.setLineDash([]);
        });
      }

      if (layers.volume) {
        const maxVolume = Math.max(...candles.map((candle) => candle.volume), 1);
        candles.forEach((candle, index) => {
          const barHeight = (candle.volume / maxVolume) * (volumeHeight - 12);
          ctx.fillStyle = candle.close >= candle.open ? palette.volUp : palette.volDown;
          ctx.fillRect(index * slot + 1, height - 24 - barHeight, Math.max(1, slot - 2), barHeight);
        });
      }

      candles.forEach((candle, index) => {
        const center = index * slot + slot / 2;
        const rising = candle.close >= candle.open;
        ctx.strokeStyle = rising ? palette.upStroke : palette.downStroke;
        ctx.fillStyle = rising ? palette.upFill : palette.downFill;
        ctx.beginPath();
        ctx.moveTo(center, y(candle.high));
        ctx.lineTo(center, y(candle.low));
        ctx.stroke();
        const bodyTop = y(Math.max(candle.open, candle.close));
        const bodyHeight = Math.max(1.5, Math.abs(y(candle.open) - y(candle.close)));
        ctx.fillRect(center - Math.max(1.5, slot * 0.26), bodyTop, Math.max(3, slot * 0.52), bodyHeight);
      });

      const plotLine = (series: Array<number | null>, color: string) => {
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        let started = false;
        series.forEach((value, index) => {
          if (value === null) return;
          const x = index * slot + slot / 2;
          if (!started) {
            ctx.moveTo(x, y(value));
            started = true;
          } else ctx.lineTo(x, y(value));
        });
        if (started) ctx.stroke();
      };
      if (layers.ema) {
        plotLine(ema20, palette.ema20);
        plotLine(ema50, palette.ema50);
      }

      if (layers.structure && setup?.strategy === "ICT Liquidity Sweep" && setup.status === "eligible") {
        const candle = candles.at(-1)!;
        const center = width - slot / 2;
        ctx.fillStyle = "#f1bb50";
        ctx.beginPath();
        if (setup.direction === "Long") {
          ctx.moveTo(center, y(candle.low) + 3);
          ctx.lineTo(center - 5, y(candle.low) + 11);
          ctx.lineTo(center + 5, y(candle.low) + 11);
        } else {
          ctx.moveTo(center, y(candle.high) - 3);
          ctx.lineTo(center - 5, y(candle.high) - 11);
          ctx.lineTo(center + 5, y(candle.high) - 11);
        }
        ctx.closePath();
        ctx.fill();
      }

    };

    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(draw);
    };

    schedule();
    const observer = new ResizeObserver(schedule);
    observer.observe(canvas);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [asset, candlesKey, layers, layersKey, setup, setupKey, timeframe, theme]);

  return <canvas ref={canvasRef} className="terminal-chart" role="img" aria-label={`${asset.symbol} ${timeframe} K 線、EMA、成交量與策略價位`} />;
}
