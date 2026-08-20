"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { api, liveFeed, type Tick, type TradeEvent, PricesMap, fmtInr } from "@/lib/api";
import { createChart, type IChartApi, type ISeriesApi, CandlestickSeries, HistogramSeries, LineSeries, AreaSeries } from "lightweight-charts";
import { Badge } from "./ui";

interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

const TIMEFRAMES = [
  { label: "1s", secs: 1 },
  { label: "5s", secs: 5 },
  { label: "15s", secs: 15 },
  { label: "30s", secs: 30 },
  { label: "1m", secs: 60 },
  { label: "5m", secs: 300 },
  { label: "15m", secs: 900 },
  { label: "30m", secs: 1800 },
  { label: "1h", secs: 3600 },
];

const UP = "#26a69a";
const DOWN = "#ef5350";

type ChartKind = "candle" | "line" | "area" | "volcandle";

const CHART_LABELS: Record<ChartKind, string> = {
  candle: "Candles",
  line: "Line",
  area: "Area",
  volcandle: "Vol Candles",
};

function aggregateCandles(ticks: Tick[], intervalSecs: number): Candle[] {
  if (ticks.length === 0) return [];
  const bucketMs = intervalSecs * 1000;
  const buckets = new Map<number, Candle>();

  for (const tick of ticks) {
    const bucketKey = Math.floor(tick.t / bucketMs) * bucketMs;
    const existing = buckets.get(bucketKey);
    if (!existing) {
      buckets.set(bucketKey, {
        time: Math.floor(bucketKey / 1000) as unknown as number,
        open: tick.p,
        high: tick.p,
        low: tick.p,
        close: tick.p,
      });
    } else {
      existing.high = Math.max(existing.high, tick.p);
      existing.low = Math.min(existing.low, tick.p);
      existing.close = tick.p;
    }
  }

  const sorted = Array.from(buckets.values()).sort((a, b) => a.time - b.time);
  // Drop the leading partial bucket so the leftmost candle is complete and static.
  if (sorted.length > 0 && ticks[0].t > sorted[0].time * 1000) {
    sorted.shift();
  }
  return sorted;
}

function aggregateBars(bars: Candle[], intervalSecs: number): Candle[] {
  if (bars.length === 0) return [];
  const bucketMs = intervalSecs * 1000;
  const buckets = new Map<number, Candle>();

  for (const bar of bars) {
    const bucketKey = Math.floor((bar.time * 1000) / bucketMs) * bucketMs;
    const existing = buckets.get(bucketKey);
    if (!existing) {
      buckets.set(bucketKey, {
        time: Math.floor(bucketKey / 1000),
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
      });
    } else {
      existing.high = Math.max(existing.high, bar.high);
      existing.low = Math.min(existing.low, bar.low);
      existing.close = bar.close;
    }
  }

  return Array.from(buckets.values()).sort((a, b) => a.time - b.time);
}

// History resolution supported by GET /api/market/history for a chart timeframe.
function historyResolution(tfSecs: number): string | null {
  if (tfSecs >= 3600) return "1h";
  if (tfSecs >= 900) return "15m";
  if (tfSecs >= 300) return "5m";
  if (tfSecs >= 60) return "1m";
  return null;
}

export function CandlesChart({
  symbols,
  initialPrices,
  state = "PRE_LAUNCH",
  height = 440,
  active,
  onActiveChange,
}: {
  symbols: string[];
  initialPrices: PricesMap;
  state?: string;
  height?: number;
  active: string;
  onActiveChange: (symbol: string) => void;
}) {
  const [prices, setPrices] = useState<PricesMap>({});
  const [tfIdx, setTfIdx] = useState(3);
  const [chartType, setChartType] = useState<ChartKind>("candle");
  const [tradesVersion, setTradesVersion] = useState(0);
  const tfSecs = TIMEFRAMES[tfIdx].secs;

  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick" | "Line" | "Area"> | null>(null);
  const volumeRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const tradesBySym = useRef<Record<string, TradeEvent[]>>({});
  const activeRef = useRef(active);
  const fitRef = useRef(true);
  const histCache = useRef<Record<string, Candle[]>>({});
  const [histVersion, setHistVersion] = useState(0);

  useEffect(() => {
    liveFeed.seed(symbols, initialPrices);
    const un = liveFeed.subscribe((p) => setPrices(p));
    return un;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const res = historyResolution(tfSecs);
    if (!res) return;
    const key = `${active}:${res}`;
    if (histCache.current[key]) return;
    let cancelled = false;
    api<{ bars: { t: number; open: number; high: number; low: number; close: number }[] }>(
      `/api/market/history?symbol=${encodeURIComponent(active)}&resolution=${res}&limit=10000`,
    )
      .then((d) => {
        if (cancelled || !Array.isArray(d.bars) || d.bars.length === 0) return;
        histCache.current[key] = d.bars.map((b) => ({
          time: Math.floor(b.t / 1000),
          open: b.open,
          high: b.high,
          low: b.low,
          close: b.close,
        }));
        setHistVersion((x) => x + 1);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [active, tfSecs]);

  useEffect(() => {
    const un = liveFeed.onTrade((t) => {
      const arr = (tradesBySym.current[t.symbol] ??= []);
      arr.push(t);
      if (arr.length > 4000) arr.splice(0, arr.length - 4000);
      setTradesVersion((x) => x + 1);
    });
    return un;
  }, []);

  useEffect(() => {
    if (!symbols.includes(active) && symbols.length) onActiveChange(symbols[0]);
  }, [symbols, active, onActiveChange]);

  const merged = useMemo(() => ({ ...initialPrices, ...prices }), [initialPrices, prices]);

  const ticks = useMemo(
    () => [...(liveFeed.ticksOf(active) ?? [])],
    [active, prices, merged],
  );
  const res = historyResolution(tfSecs);
  const histKey = res ? `${active}:${res}` : null;
  const pastCandles = useMemo(
    () => (histKey && histCache.current[histKey] ? aggregateBars(histCache.current[histKey], tfSecs) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [histKey, tfSecs, histVersion],
  );
  const liveCandles = useMemo(() => aggregateCandles(ticks, tfSecs), [ticks, tfSecs]);
  const firstLive = liveCandles[0]?.time;
  const candles = useMemo(() => {
    if (firstLive == null) return pastCandles;
    return [...pastCandles.filter((c) => c.time < firstLive), ...liveCandles];
  }, [pastCandles, liveCandles, firstLive]);

  const symTrades = tradesBySym.current[active] ?? [];
  const volumeByBucket = useMemo(() => {
    const map = new Map<number, number>();
    const bucketMs = tfSecs * 1000;
    for (const t of symTrades) {
      const k = Math.floor(t.ts / bucketMs) * bucketMs;
      map.set(k, (map.get(k) ?? 0) + t.qty);
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, tfSecs, tradesVersion]);

  const seriesData = useMemo(() => {
    if (chartType === "candle") return candles;
    if (chartType === "volcandle") {
      const maxVol = Math.max(
        1,
        ...candles.map((c) => volumeByBucket.get(c.time * 1000) ?? 0),
      );
      return candles.map((c) => {
        const vol = volumeByBucket.get(c.time * 1000) ?? 0;
        const alpha = 0.3 + 0.7 * (vol / maxVol);
        const base = c.close >= c.open ? UP : DOWN;
        const aHex = Math.round(alpha * 255).toString(16).padStart(2, "0");
        return { ...c, color: `${base}${aHex}` };
      });
    }
    return candles.map((c) => ({ time: c.time, value: c.close }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candles, chartType, volumeByBucket]);

  const activePx = merged[active];
  const first = candles[0]?.open;
  const last = candles[candles.length - 1]?.close;
  const chg = first && last ? ((last - first) / first) * 100 : 0;

  const open = candles[0]?.open ?? activePx;
  const high = candles.length ? Math.max(...candles.map((c) => c.high)) : activePx;
  const low = candles.length ? Math.min(...candles.map((c) => c.low)) : activePx;
  const close = last ?? activePx;

  const volData = useMemo(
    () =>
      candles.map((c) => ({
        time: c.time,
        value: volumeByBucket.get(c.time * 1000) ?? 0,
        color: c.close >= c.open ? `${UP}80` : `${DOWN}80`,
      })),
    [candles, volumeByBucket],
  );

  const totalVolume = symTrades.reduce((s, t) => s + t.qty, 0);
  const vwap =
    symTrades.length > 0
      ? symTrades.reduce((s, t) => s + t.price * t.qty, 0) / totalVolume
      : null;
  const prevClose = ticks[0]?.p ?? activePx;
  const ltt = symTrades.length
    ? new Date(symTrades[symTrades.length - 1].ts).toLocaleTimeString("en-US", { hour12: false })
    : ticks.length
      ? new Date(ticks[ticks.length - 1].t).toLocaleTimeString("en-US", { hour12: false })
      : "—";
  const circuit = liveFeed.circuitOf(active);

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height,
      layout: {
        background: { color: "transparent" },
        textColor: "#8fa0b5",
        fontFamily: "ui-monospace, monospace",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: "#1c2735", style: 1 },
        horzLines: { color: "#1c2735", style: 1 },
      },
      crosshair: {
        mode: 0,
        vertLine: { color: "#55657a", width: 1, style: 2, labelBackgroundColor: "#1c2735" },
        horzLine: { color: "#55657a", width: 1, style: 2, labelBackgroundColor: "#1c2735" },
      },
      rightPriceScale: {
        borderColor: "#1c2735",
        scaleMargins: { top: 0.08, bottom: 0.26 },
      },
      timeScale: {
        borderColor: "#1c2735",
        timeVisible: true,
        secondsVisible: tfSecs < 60,
      },
    });
    const series =
      chartType === "candle" || chartType === "volcandle"
        ? chart.addSeries(CandlestickSeries, {
            upColor: UP,
            downColor: DOWN,
            borderDownColor: DOWN,
            borderUpColor: UP,
            wickDownColor: DOWN,
            wickUpColor: UP,
          })
        : chart.addSeries(chartType === "line" ? LineSeries : AreaSeries, {
            color: UP,
            lineWidth: 2,
            priceLineVisible: false,
            lastValueVisible: true,
            crosshairMarkerVisible: true,
          });
    let volume: ISeriesApi<"Histogram"> | null = null;
    if (chartType === "candle" || chartType === "volcandle") {
      volume = chart.addSeries(HistogramSeries, {
        priceFormat: { type: "volume" },
        priceScaleId: "volume",
        lastValueVisible: false,
        priceLineVisible: false,
      });
      chart.priceScale("volume").applyOptions({
        scaleMargins: { top: 0.82, bottom: 0 },
      });
    }
    chartRef.current = chart;
    seriesRef.current = series;
    volumeRef.current = volume;
    activeRef.current = active;
    fitRef.current = true;

    const ro = new ResizeObserver(([entry]) => {
      if (entry && chartRef.current) {
        chartRef.current.applyOptions({ width: entry.contentRect.width });
      }
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      volumeRef.current = null;
    };
  }, [height, tfSecs, chartType]);

  useEffect(() => {
    seriesRef.current?.setData(seriesData as never);
    volumeRef.current?.setData(volData as never);
    const ts = chartRef.current?.timeScale();
    if (!ts) return;
    const isCandle = chartType === "candle" || chartType === "volcandle";
    // Fit only on chart recreation (timeframe/type) or symbol change; on live
    // ticks keep the user's zoom instead of resetting it every second.
    if (fitRef.current || activeRef.current !== active) {
      if (isCandle) ts.fitContent();
      else
        ts.setVisibleLogicalRange({
          from: Math.max(0, seriesData.length - 80),
          to: seriesData.length + 5,
        });
    }
    fitRef.current = false;
    activeRef.current = active;
  }, [seriesData, volData, chartType, active]);

  return (
    <div className="flex h-full min-w-0 flex-col border border-line bg-panel">
      <header className="flex flex-wrap items-center gap-3 border-b border-line bg-panel2/40 px-3 py-2">
        <div className="flex items-center gap-2">
          <span
            className={`h-1.5 w-1.5 ${state === "ACTIVE_MARKET" ? "live-dot bg-buy" : state === "API_FROZEN" ? "bg-gold" : "bg-dim"}`}
          />
          <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-muted">
            {CHART_LABELS[chartType]}
          </span>
          <Badge color="#f0b90b">{active}</Badge>
          {circuit === "upper" && <Badge color="#26a69a">▲ Upper circuit</Badge>}
          {circuit === "lower" && <Badge color="#ef5350">▼ Lower circuit</Badge>}
        </div>

        <select
          value={chartType}
          onChange={(e) => setChartType(e.target.value as ChartKind)}
          className="cursor-pointer rounded-md border border-line bg-panel2 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted outline-none transition-colors hover:text-ink focus:border-acc/60"
        >
          {(Object.keys(CHART_LABELS) as ChartKind[]).map((t) => (
            <option key={t} value={t} className="bg-panel text-ink">
              {CHART_LABELS[t]}
            </option>
          ))}
        </select>

        <div className="flex items-center gap-px border border-line bg-panel">
          {TIMEFRAMES.map((tf, i) => (
            <button
              key={tf.label}
              onClick={() => setTfIdx(i)}
              className={`px-2 py-1 text-[10px] font-semibold transition-colors ${
                i === tfIdx ? "bg-gold/15 text-gold" : "text-muted hover:text-ink"
              }`}
            >
              {tf.label}
            </button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-4 text-right">
          {[
            ["Open", open],
            ["High", high],
            ["Low", low],
            ["Close", close],
          ].map(([l, v]) => (
            <div key={l as string}>
              <div className="text-[9px] uppercase tracking-wider text-dim">{l}</div>
              <div className="num text-[12px] font-semibold text-ink">{fmtInr(v)}</div>
            </div>
          ))}
        </div>
      </header>

      <div ref={containerRef} className="w-full flex-1" style={{ height }} />

      <footer className="grid grid-cols-2 border-t border-line bg-panel2/40 text-[10px] sm:grid-cols-4">
        {[
          ["Prev Close", prevClose != null ? fmtInr(prevClose) : "—"],
          ["Volume", totalVolume > 0 ? totalVolume.toLocaleString("en-IN") : "—"],
          ["Avg Price", vwap != null ? fmtInr(vwap) : "—"],
          ["LTT", ltt],
        ].map(([l, v]) => (
          <div key={l as string} className="flex items-center justify-between gap-2 border-b border-line/60 px-3 py-1.5 sm:border-b-0 sm:border-r sm:last:border-r-0">
            <span className="uppercase tracking-wider text-dim">{l}</span>
            <span className="num font-semibold text-ink">{v}</span>
          </div>
        ))}
        <div className={`num flex items-center justify-between gap-2 border-t border-line/60 px-3 py-1.5 sm:col-span-4 sm:border-t-0 ${chg >= 0 ? "text-buy" : "text-sell"}`}>
          <span>
            window {chg >= 0 ? "▲" : "▼"} {Math.abs(chg).toFixed(2)}% · {TIMEFRAMES[tfIdx].label} {chartType === "candle" ? "candles" : chartType === "volcandle" ? "vol candles" : chartType} · {candles.length} intervals
          </span>
          <span className="text-dim">{active} · session</span>
        </div>
      </footer>
    </div>
  );
}