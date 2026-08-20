"use client";

import { useMemo } from "react";
import { liveFeed, PricesMap, fmt } from "@/lib/api";
import { DepthPanel } from "./DepthPanel";

export function TradingSidebar({
  symbols,
  prices,
  active,
  onSelect,
}: {
  symbols: string[];
  prices: PricesMap;
  active: string;
  onSelect: (symbol: string) => void;
}) {
  const rows = useMemo(
    () =>
      symbols.map((s) => {
        const p = prices[s];
        const hist = liveFeed.historyOf(s);
        const base = hist.length ? hist[0] : p;
        const chg = p && base ? ((p - base) / base) * 100 : 0;
        return { s, p, chg };
      }),
    [symbols, prices],
  );

  return (
    <aside className="flex w-[320px] shrink-0 flex-col border border-line bg-panel">
      <div className="border-b border-line bg-panel2/40 px-3 py-1.5">
        <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-dim">
          Watchlist
        </span>
      </div>

      <div className="grid grid-cols-[1fr_auto_auto] gap-x-3 border-b border-line bg-panel2/60 px-3 py-1 text-[9px] font-bold uppercase tracking-wider text-dim">
        <span>Symbol</span>
        <span className="text-right">LTP</span>
        <span className="w-[64px] text-right">% Chg</span>
      </div>

      <div className="max-h-[300px] overflow-y-auto">
        {rows.map(({ s, p, chg }) => {
          const isActive = s === active;
          return (
            <button
              key={s}
              onClick={() => onSelect(s)}
              className={`grid w-full grid-cols-[1fr_auto_auto] gap-x-3 px-3 py-[5px] text-left transition-colors ${
                isActive ? "bg-buy/10 text-ink" : "text-muted hover:bg-panel2/50 hover:text-ink"
              }`}
            >
              <span className="truncate font-mono text-[12px] font-bold">
                {isActive && <span className="mr-1.5 inline-block h-1.5 w-1.5 bg-buy" />}
                {s}
              </span>
              <span className="num text-[12px] font-semibold text-ink">{p != null ? fmt(p) : "—"}</span>
              <span
                className={`num w-[64px] text-right text-[11px] font-semibold ${
                  p == null ? "text-dim" : chg >= 0 ? "text-buy" : "text-sell"
                }`}
              >
                {p != null ? `${chg >= 0 ? "+" : ""}${chg.toFixed(2)}%` : "—"}
              </span>
            </button>
          );
        })}
      </div>

      <div className="mt-1 flex-1 px-2 pb-2">
        <DepthPanel symbol={active} last={prices[active]} />
      </div>
    </aside>
  );
}