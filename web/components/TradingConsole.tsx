"use client";

import { useEffect, useRef, useState } from "react";
import { api, getToken, liveFeed, PricesMap, OrderEvent, fmt, fmtInr } from "@/lib/api";
import { Pill } from "./PPanel";
import type { Portfolio } from "./TradePanel";

interface Trade {
  order_id: number;
  action: "BUY" | "SELL";
  symbol: string;
  quantity: number;
  price_executed: string | null;
  status: "SUCCESS" | "REJECTED";
  reason: string | null;
  latency_ms: number | null;
  timestamp_ms: string;
}

export interface LogEntry {
  id: number;
  kind: "sent" | "fill" | "reject";
  action: "BUY" | "SELL";
  symbol: string;
  quantity: number;
  price: number | null;
  ms: number | null;
  text: string;
  time: number;
}

interface TradeResult {
  status: "SUCCESS" | "REJECTED";
  reason?: string;
  priceExecuted?: number | null;
  quantity: number;
  cashAfter: number;
  latencyMs: number;
}

export function useOrderLog() {
  const [log, setLog] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const idRef = useRef(0);

  useEffect(() => {
    const token = getToken();
    if (!token) return;
    let alive = true;
    api<{ trades: Trade[] }>("/api/team/trades?limit=50", { token })
      .then((d) => {
        if (!alive) return;
        setLog(
          d.trades.map((t) => ({
            id: t.order_id,
            kind: t.status === "SUCCESS" ? "fill" : "reject",
            action: t.action,
            symbol: t.symbol,
            quantity: t.quantity,
            price: t.price_executed != null ? Number(t.price_executed) : null,
            ms: t.latency_ms,
            text: t.reason ?? "",
            time: new Date(t.timestamp_ms).getTime(),
          })),
        );
      })
      .catch(() => {})
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const un = liveFeed.onOrder((o: OrderEvent) => {
      const kind: "fill" | "reject" = o.status === "SUCCESS" ? "fill" : "reject";
      setLog((prev) => {
        if (prev.some((e) => e.id === o.orderId)) {
          return prev.map((e) =>
            e.id === o.orderId
              ? { ...e, kind, price: o.priceExecuted ?? e.price, ms: o.latencyMs, text: o.reason ?? "" }
              : e,
          );
        }
        return [
          {
            id: o.orderId,
            kind,
            action: o.action,
            symbol: o.symbol,
            quantity: o.quantity,
            price: o.priceExecuted,
            ms: o.latencyMs,
            text: o.reason ?? "",
            time: Date.now(),
          },
          ...prev,
        ].slice(0, 60);
      });
    });
    return un;
  }, []);

  return { log, setLog, loading, idRef };
}

export type OrderLog = ReturnType<typeof useOrderLog>;

const LABEL = "mb-1 block text-[10px] font-semibold uppercase tracking-wider text-dim";
const FIELD =
  "num w-full border border-line bg-panel2 px-3 py-2 text-sm text-ink outline-none placeholder:text-dim focus:border-acc/60";

export function OrderTicket({
  portfolio,
  apiKey,
  symbol,
  symbols,
  onSymbolChange,
  orderLog,
  onTraded,
}: {
  portfolio: Portfolio;
  apiKey?: string | null;
  symbol: string;
  symbols: string[];
  onSymbolChange: (s: string) => void;
  orderLog: OrderLog;
  onTraded?: () => void;
}) {
  const { setLog, idRef } = orderLog;
  const [quantity, setQuantity] = useState(1);
  const [price, setPrice] = useState("");
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState<PricesMap>({});

  useEffect(() => {
    const un = liveFeed.subscribe((p) => setLive(p));
    return un;
  }, []);

  async function trade(action: "buy" | "sell") {
    if (!apiKey || !symbol) return;
    const qty = Math.max(1, Number(quantity) || 1);
    setBusy(true);
    setLog((prev) =>
      [
        {
          id: ++idRef.current,
          kind: "sent" as const,
          action: (action === "buy" ? "BUY" : "SELL") as "BUY" | "SELL",
          symbol,
          quantity: qty,
          price: price ? Number(price) : null,
          ms: null,
          text: "request sent",
          time: Date.now(),
        },
        ...prev,
      ].slice(0, 60),
    );
    try {
      const body: Record<string, unknown> = { symbol, quantity: qty };
      if (price) body.price = Number(price);
      const r = await api<TradeResult>(`/api/trade/${action}`, { method: "POST", body, apiKey });
      setLog((prev) =>
        prev.map((e) =>
          e.id === idRef.current
            ? {
                ...e,
                kind: r.status === "SUCCESS" ? "fill" : "reject",
                price: r.priceExecuted ?? e.price,
                ms: r.latencyMs,
                text: r.status === "SUCCESS" ? "filled" : (r.reason ?? "rejected"),
              }
            : e,
        ),
      );
      if (r.status === "SUCCESS") {
        setQuantity(1);
        setPrice("");
        onTraded?.();
      }
    } catch (e) {
      setLog((prev) =>
        prev.map((en) => (en.id === idRef.current ? { ...en, kind: "reject", text: (e as Error).message } : en)),
      );
    } finally {
      setBusy(false);
    }
  }

  const mid = live[symbol] ?? portfolio.livePrices[symbol];
  const cash = Number(portfolio.cash_balance);
  const held = portfolio.positions.find((p) => p.symbol === symbol)?.quantity ?? 0;
  const locked = !apiKey;

  return (
    <section className="border border-line bg-panel">
      <header className="flex min-h-[40px] items-center justify-between gap-3 border-b border-line bg-panel2/60 px-4 py-2">
        <h2 className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted">Order ticket</h2>
        <Pill color={locked ? "#f0b90b" : "#2dd4bf"}>{locked ? "locked" : "ready"}</Pill>
      </header>
      <div className="space-y-3 p-4">
        <label className="block">
          <span className={LABEL}>Symbol</span>
          <select
            value={symbol}
            onChange={(e) => onSymbolChange(e.target.value)}
            className="w-full border border-line bg-panel2 px-3 py-2 font-mono text-sm font-bold text-ink outline-none focus:border-acc/60"
          >
            {symbols.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>

        <div className="flex items-end justify-between gap-3 border border-line bg-bg/60 px-3 py-2.5">
          <span className="text-[10px] uppercase tracking-wider text-dim">Last price</span>
          <span className={`num text-xl font-bold leading-none ${mid ? "text-ink" : "text-dim"}`}>
            {mid ? fmtInr(mid) : "—"}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className={LABEL}>Quantity</span>
            <input
              type="number"
              min={1}
              value={quantity}
              onChange={(e) => setQuantity(Math.max(1, Number(e.target.value) || 1))}
              className={FIELD}
              aria-label="Quantity"
            />
          </label>
          <label className="block">
            <span className={LABEL}>Limit price</span>
            <input
              type="number"
              step="any"
              min={0}
              placeholder={mid ? mid.toFixed(2) : "market"}
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              className={FIELD}
              aria-label="Limit price, blank for market"
            />
          </label>
        </div>
        <p className="-mt-1 text-[11px] text-dim">Leave limit blank for a market order.</p>

        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            disabled={busy || locked}
            title={locked ? "API key sealed until launch" : undefined}
            onClick={() => trade("buy")}
            className="bg-buy py-3 text-sm font-black tracking-[0.14em] text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-35"
          >
            BUY
          </button>
          <button
            type="button"
            disabled={busy || locked}
            title={locked ? "API key sealed until launch" : undefined}
            onClick={() => trade("sell")}
            className="bg-sell py-3 text-sm font-black tracking-[0.14em] text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-35"
          >
            SELL
          </button>
        </div>

        {locked ? (
          <div className="border border-gold/30 bg-gold/10 px-3 py-2 text-[12px] leading-snug text-gold">
            Trading locked until launch. Your API key is revealed when the event starts.
          </div>
        ) : (
          mid && (
            <dl className="space-y-1 border-t border-line pt-3 text-[12px]">
              <div className="flex justify-between">
                <dt className="text-dim">Est. value</dt>
                <dd className="num text-ink">{fmtInr(mid * quantity)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-dim">Cash after buy</dt>
                <dd className={`num ${cash - mid * quantity < 0 ? "text-sell" : "text-ink"}`}>
                  {fmtInr(cash - mid * quantity)}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-dim">Held</dt>
                <dd className="num text-ink">{held}</dd>
              </div>
            </dl>
          )
        )}
      </div>
    </section>
  );
}

const TH = "px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-dim";

export function OrdersTable({ orderLog }: { orderLog: OrderLog }) {
  const { log, loading } = orderLog;
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return (
    <div className="max-h-[360px] overflow-auto">
      <table className="w-full min-w-[560px]">
        <thead className="sticky top-0 z-10 bg-panel">
          <tr className="border-b border-line bg-panel2/50">
            <th className={`${TH} text-left`}>Time</th>
            <th className={`${TH} text-left`}>Side</th>
            <th className={`${TH} text-left`}>Symbol</th>
            <th className={`${TH} text-right`}>Qty</th>
            <th className={`${TH} text-right`}>Price</th>
            <th className={`${TH} text-right`}>Latency</th>
            <th className={`${TH} text-left`}>Status</th>
          </tr>
        </thead>
        <tbody>
          {log.map((e) => (
            <tr key={e.id} className="border-b border-line/40 last:border-0">
              <td className="num whitespace-nowrap px-3 py-2 text-[12px] text-dim">
                {mounted ? new Date(e.time).toLocaleTimeString("en-GB", { hour12: false }) : ""}
              </td>
              <td className="px-3 py-2">
                <span className={`text-[11px] font-black ${e.action === "BUY" ? "text-buy" : "text-sell"}`}>
                  {e.action}
                </span>
              </td>
              <td className="px-3 py-2 font-mono text-[12px] font-bold text-ink">{e.symbol}</td>
              <td className="num px-3 py-2 text-right text-[12px] text-ink">{e.quantity}</td>
              <td className="num px-3 py-2 text-right text-[12px] text-ink">{e.price != null ? fmt(e.price) : "—"}</td>
              <td className="num px-3 py-2 text-right text-[12px] text-muted">{e.ms != null ? `${e.ms}ms` : "…"}</td>
              <td className="px-3 py-2">
                {e.kind === "sent" ? (
                  <span className="flex items-center gap-1.5 text-[11px] text-gold">
                    <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-gold" />
                    pending
                  </span>
                ) : (
                  <span className={`text-[11px] font-semibold ${e.kind === "fill" ? "text-buy" : "text-sell"}`}>
                    {e.kind === "fill" ? "FILLED" : "REJECTED"}
                    {e.text && e.kind !== "fill" ? <span className="text-dim"> · {e.text}</span> : null}
                  </span>
                )}
              </td>
            </tr>
          ))}
          {log.length === 0 && !loading && (
            <tr>
              <td colSpan={7} className="px-4 py-10 text-center text-sm text-dim">
                No orders yet. Place your first order from the ticket.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
