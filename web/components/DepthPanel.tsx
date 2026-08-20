"use client";

import { useEffect, useState } from "react";
import { liveFeed, type BookLevel, fmtInr } from "@/lib/api";

function SideBar({
  levels,
  side,
}: {
  levels: BookLevel[];
  side: "bid" | "ask";
}) {
  const total = levels.reduce((s, l) => s + l.size, 0);
  const max = levels.length ? Math.max(...levels.map((l) => l.size)) : 1;
  const color = side === "bid" ? "text-buy" : "text-sell";
  const bar = side === "bid" ? "bg-buy" : "bg-sell";

  return (
    <div className="flex-1">
      {levels.map((lvl, i) => {
        const pct = (lvl.size / max) * 100;
        return (
          <div
            key={`${side}${i}`}
            className="relative flex h-[22px] items-center justify-between px-2 text-[11px] leading-[22px]"
          >
            <div
              className={`absolute inset-y-0 ${side === "bid" ? "left-0" : "right-0"} transition-[width] duration-200 ${bar}/15`}
              style={{ width: `${pct}%` }}
            />
            <span className={`num relative font-semibold ${color}`}>
              {lvl.price.toFixed(2)}
            </span>
            <span className="num relative text-muted">{lvl.size}</span>
          </div>
        );
      })}
      {levels.length === 0 && (
        <div className="px-2 py-2 text-[10px] text-dim">waiting…</div>
      )}
      <div className="flex items-center justify-between border-t border-line/60 bg-panel2/60 px-2 py-1 text-[10px]">
        <span className={`num font-bold ${color}`}>
          {side === "bid" ? "BID" : "ASK"}
        </span>
        <span className="num font-bold text-ink">{total}</span>
      </div>
    </div>
  );
}

export function DepthPanel({
  symbol,
  last,
}: {
  symbol: string;
  last?: number;
}) {
  const [, bump] = useState(0);

  useEffect(() => {
    const unDepth = liveFeed.onDepth(() => bump((x) => x + 1));
    const unCircuit = liveFeed.onCircuit(() => bump((x) => x + 1));
    return () => {
      unDepth();
      unCircuit();
    };
  }, []);

  const book = liveFeed.depthOf(symbol);
  const circuit = liveFeed.circuitOf(symbol);
  const bids = book?.bids ?? [];
  const asks = book?.asks ?? [];
  const spread =
    bids.length && asks.length ? asks[0].price - bids[0].price : null;

  return (
    <div className="w-full shrink-0 overflow-hidden border border-line bg-panel lg:w-[224px]">
      <div className="flex items-center justify-between border-b border-line bg-panel2/70 px-2 py-1.5">
        <span className="text-[9px] font-bold uppercase tracking-[0.14em] text-dim">
          Depth · {symbol}
        </span>
        <span className="flex items-center gap-1.5">
          {circuit === "upper" && (
            <span className="text-[9px] font-bold uppercase tracking-wider text-buy">
              ▲ Upper circuit
            </span>
          )}
          {circuit === "lower" && (
            <span className="text-[9px] font-bold uppercase tracking-wider text-sell">
              ▼ Lower circuit
            </span>
          )}
          {spread != null && (
            <span className="num text-[9px] text-dim">spread {spread.toFixed(2)}</span>
          )}
        </span>
      </div>

      <div className="flex">
        <SideBar levels={bids} side="bid" />
        <div className="w-px bg-line" />
        <SideBar levels={asks} side="ask" />
      </div>

      <div className="border-t border-line bg-panel2/70 px-2 py-1 text-center">
        {last != null ? (
          <span className="num text-[13px] font-black text-ink">{fmtInr(last)}</span>
        ) : (
          <span className="text-[11px] text-dim">—</span>
        )}
      </div>
    </div>
  );
}