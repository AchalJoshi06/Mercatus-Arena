"use client";

import { useMemo, useState } from "react";
import { liveFeed, PricesMap, fmt } from "@/lib/api";

/**
 * Watchlist. On xl screens it fills the height of its (relatively positioned) parent
 * and scrolls internally; below xl it is a collapsible block with a capped height.
 */
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
  state?: string;
}) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);

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
  const shown = q.trim() ? rows.filter((r) => r.s.toLowerCase().includes(q.trim().toLowerCase())) : rows;

  return (
    <aside className="flex min-h-0 flex-col border border-line bg-panel xl:absolute xl:inset-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex min-h-[40px] items-center justify-between gap-3 border-b border-line bg-panel2/60 px-4 py-2 text-left xl:pointer-events-none"
        aria-expanded={open}
      >
        <span className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted">
          Watchlist <span className="num ml-1 text-dim">{symbols.length}</span>
        </span>
        <span className="text-[11px] text-dim xl:hidden">{open ? "Hide ▲" : "Show ▼"}</span>
      </button>

      <div className={`${open ? "flex" : "hidden"} min-h-0 flex-1 flex-col xl:flex`}>
        <div className="border-b border-line p-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search symbol…"
            aria-label="Search symbols"
            className="w-full border border-line bg-panel2 px-3 py-1.5 text-[12px] text-ink outline-none placeholder:text-dim focus:border-acc/60"
          />
        </div>
        <div className="grid grid-cols-[1fr_auto_58px] gap-x-3 border-b border-line bg-panel2/40 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-dim">
          <span>Symbol</span>
          <span className="text-right">LTP</span>
          <span className="text-right">% Chg</span>
        </div>
        <div className="max-h-[360px] min-h-0 flex-1 overflow-y-auto xl:max-h-none">
          {shown.map(({ s, p, chg }) => {
            const isActive = s === active;
            return (
              <button
                key={s}
                onClick={() => onSelect(s)}
                className={`grid w-full grid-cols-[1fr_auto_58px] items-center gap-x-3 border-l-2 px-3 py-[7px] text-left transition-colors ${
                  isActive
                    ? "border-acc bg-acc/10 text-ink"
                    : "border-transparent text-muted hover:bg-panel2/60 hover:text-ink"
                }`}
              >
                <span className="truncate font-mono text-[12px] font-bold">{s}</span>
                <span className="num text-[12px] font-semibold text-ink">{p != null ? fmt(p) : "—"}</span>
                <span
                  className={`num text-right text-[11px] font-semibold ${
                    p == null ? "text-dim" : chg >= 0 ? "text-buy" : "text-sell"
                  }`}
                >
                  {p != null ? `${chg >= 0 ? "+" : ""}${chg.toFixed(2)}%` : "—"}
                </span>
              </button>
            );
          })}
          {shown.length === 0 && <div className="px-3 py-6 text-center text-[12px] text-dim">No matching symbol.</div>}
        </div>
      </div>
    </aside>
  );
}
