"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { api, liveFeed, PricesMap, fmtInr } from "@/lib/api";
import { MagicCard } from "./magicui/magic-card";
import { BorderBeam } from "./magicui/border-beam";
import { AnimatedGridPattern } from "./magicui/animated-grid-pattern";
import { MarketChart, colorOf, type TradeMarker } from "./MarketChart";
import { DepthPanel } from "./DepthPanel";
import { Badge } from "./ui";

export interface ExternalMarker {
  symbol: string;
  action: "BUY" | "SELL";
  price: number;
  ts: number;
}

export function MarketChartCard({
  symbols,
  initialPrices,
  state = "PRE_LAUNCH",
  title = "Market Simulation",
  showMarkers = false,
  externalMarkers,
  onActiveChange,
  loadHistory = false,
}: {
  symbols: string[];
  initialPrices: PricesMap;
  state?: string;
  title?: string;
  showMarkers?: boolean;
  externalMarkers?: ExternalMarker[];
  onActiveChange?: (symbol: string) => void;
  loadHistory?: boolean;
}) {
  const [prices, setPrices] = useState<PricesMap>({});
  const [mode, setMode] = useState<"single" | "compare">("single");
  const [active, setActive] = useState<string>(symbols[0] ?? "AAPL");
  const [, bump] = useState(0);
  const [markers, setMarkers] = useState<TradeMarker[]>([]);
  const idRef = useRef(0);
  const [histMap, setHistMap] = useState<Record<string, { t: number; p: number }[]>>({});

  useEffect(() => {
    liveFeed.seed(symbols, initialPrices);
    const un = liveFeed.subscribe((p) => {
      setPrices(p);
      bump((x) => x + 1);
    });
    return un;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!symbols.includes(active)) setActive(symbols[0] ?? "AAPL");
  }, [symbols, active]);

  useEffect(() => {
    if (!showMarkers) return;
    const un = liveFeed.onOrder((o) => {
      if (o.status !== "SUCCESS" || o.priceExecuted == null) return;
      const hist = liveFeed.historyOf(o.symbol);
      const index = Math.max(0, hist.length - 1);
      const price = o.priceExecuted;
      setMarkers((prev) => {
        const next = [
          ...prev,
          { symbol: o.symbol, action: o.action, price, index, id: ++idRef.current },
        ];
        return next.slice(-24);
      });
    });
    return un;
  }, [showMarkers]);

  useEffect(() => {
    const un = liveFeed.onCircuit(() => bump((x) => x + 1));
    return un;
  }, []);

  const merged = useMemo(() => ({ ...initialPrices, ...prices }), [initialPrices, prices]);

  // When loadHistory is on (admin console), pull the dataset's past so the line
  // chart shows the same history the candle chart does, and keep a rolling
  // recent window of merged history + live ticks (timestamped) so the x-axis is
  // real clock time — matching the candle chart's time scale.
  const WINDOW = 600;
  const { series, times } = useMemo(() => {
    const s: Record<string, number[]> = {};
    const t: Record<string, number[]> = {};
    for (const sym of symbols) {
      const hist = loadHistory ? (histMap[sym] ?? []) : [];
      const live = liveFeed.ticksOf(sym) ?? [];
      // Keep only history strictly before the first live tick (same boundary
      // as CandlesChart). If the stitch would still jump >0.3%, drop the
      // stale history tail so the line does not show a cliff.
      let trimmed = hist;
      if (live.length) {
        const firstLive = live[0];
        trimmed = hist.filter((h) => h.t < firstLive.t);
        const last = trimmed[trimmed.length - 1];
        if (last && last.p > 0 && Math.abs(last.p - firstLive.p) / firstLive.p > 0.003) {
          // Rebase history onto the live open instead of discarding it.
          const k = firstLive.p / last.p;
          trimmed = trimmed.map((h) => ({ ...h, p: h.p * k }));
        }
      }
      const mergedArr = [...trimmed, ...live].slice(-WINDOW);
      if (mergedArr.length) {
        s[sym] = mergedArr.map((p) => p.p);
        t[sym] = mergedArr.map((p) => p.t);
      } else if (merged[sym] != null) {
        s[sym] = [merged[sym]];
        t[sym] = [Date.now()];
      } else {
        s[sym] = [];
        t[sym] = [];
      }
    }
    return { series: s, times: loadHistory ? t : undefined };
  }, [symbols, merged, loadHistory, histMap]);

  useEffect(() => {
    if (!loadHistory) return;
    let cancelled = false;
    const res = mode === "compare" ? "1m" : "5s";
    Promise.all(
      symbols.map((sym) =>
        api<{ bars: { t: number; close: number }[] }>(
          `/api/market/history?symbol=${encodeURIComponent(sym)}&resolution=${res}&limit=${WINDOW}`,
        )
          .then((d) => [sym, (d.bars ?? []).map((b) => ({ t: b.t, p: b.close }))] as const)
          .catch(() => [sym, []] as const),
      ),
    ).then((entries) => {
      if (cancelled) return;
      const m: Record<string, { t: number; p: number }[]> = {};
      for (const [sym, bars] of entries) m[sym] = bars as { t: number; p: number }[];
      setHistMap(m);
    });
    return () => {
      cancelled = true;
    };
  }, [loadHistory, symbols.join(","), mode]);

  const activePx = merged[active];
  const activeSeries = series[active] ?? [activePx];
  const open = activeSeries[0] ?? activePx;

  const extMarkers = useMemo(() => {
    if (!externalMarkers?.length) return [];
    const len = Math.max(1, (series[active] ?? []).length);
    return externalMarkers
      .filter((m) => m.symbol === active)
      .map((m, i) => ({
        symbol: m.symbol,
        action: m.action,
        price: m.price,
        index: Math.max(0, Math.min(len - 1, len - 1 - Math.floor((Date.now() - m.ts) / 1000))),
        id: i,
      }));
  }, [externalMarkers, series, active]);
  const chg = activePx && open ? ((activePx - open) / open) * 100 : 0;
  const high = activeSeries.length ? Math.max(...activeSeries) : activePx;
  const low = activeSeries.length ? Math.min(...activeSeries) : activePx;

  return (
    <MagicCard
      mode="gradient"
      gradientColor="#2dd4bf"
      gradientOpacity={0.07}
      gradientFrom="#2dd4bf"
      gradientTo="#1c2735"
      gradientSize={340}
      className="rounded-xl border border-line bg-panel"
    >
      <BorderBeam
        size={120}
        duration={9}
        colorFrom="#2dd4bf"
        colorTo="#8b7cf6"
      />
      <AnimatedGridPattern
        className="opacity-[0.05]"
        numSquares={40}
        maxOpacity={0.4}
        duration={5}
      />

      <div className="relative z-40 p-4">
        <header className="mb-3 flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <span
              className={`h-1.5 w-1.5 rounded-full ${state === "ACTIVE_MARKET" ? "live-dot bg-buy" : state === "API_FROZEN" ? "bg-gold" : "bg-dim"}`}
            />
            <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted">
              {title}
            </span>
            <Badge color="#2dd4bf">{mode === "single" ? active : "compare"}</Badge>
            {mode === "single" && liveFeed.circuitOf(active) === "upper" && (
              <Badge color="#2dd4bf">▲ Upper circuit</Badge>
            )}
            {mode === "single" && liveFeed.circuitOf(active) === "lower" && (
              <Badge color="#f0514c">▼ Lower circuit</Badge>
            )}
          </div>
          <select
            value={active}
            onChange={(e) => {
              setActive(e.target.value);
              onActiveChange?.(e.target.value);
            }}
            className="cursor-pointer rounded-md border border-line bg-panel2 px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-muted outline-none transition-colors hover:text-ink focus:border-acc/60"
          >
            {symbols.map((s) => (
              <option key={s} value={s} className="bg-panel text-ink">
                {s}
              </option>
            ))}
          </select>

          <div className="ml-auto flex gap-1 rounded-lg border border-line bg-panel2 p-1">
            {(["single", "compare"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`rounded-md px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider transition-colors ${
                  mode === m ? "bg-acc text-bg" : "text-muted hover:text-ink"
                }`}
              >
                {m === "single" ? "Single" : "All %"}
              </button>
            ))}
          </div>
        </header>

        {mode === "single" && (
          <div className="mb-3 flex flex-wrap items-end gap-x-6 gap-y-2">
            <div>
              <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-dim">
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: colorOf(active) }} />
                {active}
              </div>
<div className="num mt-1 flex items-baseline gap-1 text-4xl font-black tracking-tight text-ink">
                  <span className="text-xl text-muted">₹</span>
                  <span className="tabular-nums">{fmtInr(activePx)}</span>
                </div>
              <div className={`num mt-1 text-sm font-bold ${chg >= 0 ? "text-buy" : "text-sell"}`}>
                {chg >= 0 ? "▲" : "▼"} {Math.abs(chg).toFixed(2)}%{" "}
                <span className="font-normal text-dim">since window start</span>
              </div>
            </div>
            <div className="ml-auto grid grid-cols-3 gap-6 text-right">
              {[
                ["High", fmtInr(high)],
                ["Low", fmtInr(low)],
                ["Open", fmtInr(open)],
              ].map(([l, v]) => (
                <div key={l}>
                  <div className="text-[10px] uppercase tracking-wider text-dim">{l}</div>
                  <div className="num text-sm font-semibold text-ink">{v}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="flex flex-col gap-3 lg:flex-row">
          <div className="min-w-0 flex-1">
            <MarketChart
              symbols={symbols}
              series={series}
              times={times}
              height={mode === "single" ? 420 : 420}
              tickSeconds={1}
              mode={mode}
              active={active}
              markers={showMarkers ? markers : extMarkers}
            />
          </div>
          {mode === "single" && (
            <DepthPanel symbol={active} last={activePx} state={state} />
          )}
        </div>
      </div>
    </MagicCard>
  );
}
