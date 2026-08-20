function getBaseUrl() {
  if (typeof window === "undefined") return "http://localhost:4040";
  if (process.env.NEXT_PUBLIC_API_BASE) return process.env.NEXT_PUBLIC_API_BASE;
  return `http://${window.location.hostname}:4040`;
}

function getWsUrl() {
  if (typeof window === "undefined") return "ws://localhost:4040/ws";
  if (process.env.NEXT_PUBLIC_WS_URL) return process.env.NEXT_PUBLIC_WS_URL;
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.hostname}:4040/ws`;
}

export const API_BASE = getBaseUrl();
export const WS_URL = getWsUrl();

export interface ApiError {
  error: string;
  detail?: string;
}

export async function api<T = unknown>(
  path: string,
  opts: {
    method?: string;
    body?: unknown;
    token?: string;
    apiKey?: string;
    form?: FormData;
  } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.apiKey) headers["x-api-key"] = opts.apiKey;
  if (opts.body !== undefined && !opts.form) {
    headers["content-type"] = "application/json";
  }

  const res = await fetch(`${API_BASE}${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.form ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
    cache: "no-store",
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw Object.assign(new Error(data?.error ?? `HTTP ${res.status}`), data);
  }
  return data as T;
}

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("mercatus_token");
}

export function setToken(token: string) {
  localStorage.setItem("mercatus_token", token);
}

export function clearToken() {
  localStorage.removeItem("mercatus_token");
}

export interface LiveTick {
  symbol: string;
  price: number;
  prev: number;
}

export interface OrderEvent {
  type: "order";
  orderId: number;
  status: "SUCCESS" | "REJECTED";
  reason: string | null;
  action: "BUY" | "SELL";
  symbol: string;
  quantity: number;
  priceExecuted: number | null;
  cashAfter: number;
  latencyMs: number;
  fee: number;
}

export interface STATUS {
  state: string;
  paused: boolean;
  credentialsRevealed: boolean;
  leaderboardFrozen: boolean;
  tickCount: number;
  startCapital: number;
  replaySpeed: number;
  volatility: number;
  symbols: string[];
  prices: Record<string, number>;
  datasetName: string | null;
  datasetStartAt: number | null;
  eventStartedAt: string | null;
  scheduledEndAt: string | null;
  apiFreezeAt: string | null;
  leaderboardFreezeAt: string | null;
  startWallMs: number;
}

export type PricesMap = Record<string, number>;

export interface BookLevel {
  price: number;
  size: number;
}

export interface Book {
  bids: BookLevel[];
  asks: BookLevel[];
}

export interface TradeEvent {
  type: "trade";
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  price: number;
  ts: number;
}

export interface CircuitEvent {
  type: "circuit";
  symbol: string;
  side: "upper" | "lower" | null;
  level: number | null;
}

const MAX_HISTORY = 14400;

export interface Tick {
  t: number;
  p: number;
}

export class LiveFeed {
  private ws: WebSocket | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<(prices: PricesMap) => void>();
  private orderListeners = new Set<(order: OrderEvent) => void>();
  private tradeListeners = new Set<(trade: TradeEvent) => void>();
  private depthListeners = new Set<(depth: Record<string, Book>) => void>();
  private circuitListeners = new Set<
    (circuits: Record<string, "upper" | "lower">) => void
  >();
  private last: PricesMap = {};
  private history: Record<string, Tick[]> = {};
  private depth: Record<string, Book> = {};
  private circuits: Record<string, "upper" | "lower"> = {};

  subscribe(fn: (prices: PricesMap) => void): () => void {
    this.listeners.add(fn);
    fn({ ...this.last });
    this.ensureConnected();
    return () => {
      this.listeners.delete(fn);
      if (this.listeners.size === 0) this.disconnect();
    };
  }

  onOrder(fn: (order: OrderEvent) => void): () => void {
    this.orderListeners.add(fn);
    this.ensureConnected();
    return () => this.orderListeners.delete(fn);
  }

  onTrade(fn: (trade: TradeEvent) => void): () => void {
    this.tradeListeners.add(fn);
    this.ensureConnected();
    return () => this.tradeListeners.delete(fn);
  }

  onDepth(fn: (depth: Record<string, Book>) => void): () => void {
    this.depthListeners.add(fn);
    this.ensureConnected();
    return () => this.depthListeners.delete(fn);
  }

  onCircuit(fn: (circuits: Record<string, "upper" | "lower">) => void): () => void {
    this.circuitListeners.add(fn);
    this.ensureConnected();
    return () => this.circuitListeners.delete(fn);
  }

  depthOf(symbol: string): Book | undefined {
    return this.depth[symbol];
  }

  circuitOf(symbol: string): "upper" | "lower" | undefined {
    return this.circuits[symbol];
  }

  historyOf(symbol: string): number[] {
    return this.history[symbol]?.map((h) => h.p) ?? [];
  }

  ticksOf(symbol: string): Tick[] {
    return this.history[symbol] ?? [];
  }

  seed(symbols: string[], prices: PricesMap) {
    for (const s of symbols) {
      const p = prices[s];
      if (typeof p === "number" && !(this.history[s]?.length)) {
        this.pushPrice(s, p);
      }
    }
  }

  private pushPrice(symbol: string, price: number, t?: number) {
    const arr = (this.history[symbol] ??= []);
    const now = t ?? Date.now();
    const last = arr[arr.length - 1];
    if (!last || last.p !== price) {
      arr.push({ t: now, p: price });
      if (arr.length > MAX_HISTORY) arr.shift();
    } else {
      last.t = now;
    }
  }

  private emit() {
    for (const fn of this.listeners) fn({ ...this.last });
  }

  private connect() {
    const token =
      typeof window !== "undefined" ? localStorage.getItem("mercatus_token") : null;
    try {
      const protocols = token ? [`mercatus.${token}`] : [];
      const ws = new WebSocket(WS_URL, protocols);
      this.ws = ws;
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === "tick" && Array.isArray(msg.prices)) {
            for (const t of msg.prices as LiveTick[]) {
              if (typeof t.price === "number") {
                this.last[t.symbol] = t.price;
                this.pushPrice(t.symbol, t.price);
              }
            }
            if (Array.isArray(msg.books)) {
              for (const b of msg.books as (Book & { symbol: string })[]) {
                if (b.symbol && b.bids && b.asks) this.depth[b.symbol] = b;
              }
              for (const fn of this.depthListeners) fn({ ...this.depth });
            }
            this.emit();
          }
          if (msg.type === "hello" && msg.payload?.prices) {
            this.last = { ...msg.payload.prices, ...this.last };
            if (Array.isArray(msg.payload.history)) {
              for (const snap of msg.payload.history as { t?: number; prices?: PricesMap }[]) {
                const t = Number(snap.t);
                if (!snap.prices || !Number.isFinite(t)) continue;
                for (const [s, p] of Object.entries(snap.prices)) {
                  this.pushPrice(s, Number(p), t);
                }
              }
            }
            for (const [s, p] of Object.entries(this.last)) {
              this.pushPrice(s, Number(p));
            }
            if (msg.payload.books) {
              for (const b of msg.payload.books as (Book & { symbol: string })[]) {
                if (b.symbol && b.bids && b.asks) this.depth[b.symbol] = b;
              }
              for (const fn of this.depthListeners) fn({ ...this.depth });
            }
            if (msg.payload.circuit) {
              this.circuits = { ...msg.payload.circuit };
              for (const fn of this.circuitListeners) fn({ ...this.circuits });
            }
            this.emit();
          }
          if (msg.type === "trade") {
            for (const fn of this.tradeListeners) fn(msg as TradeEvent);
          }
          if (msg.type === "circuit") {
            const ev = msg as CircuitEvent;
            if (ev.side) this.circuits[ev.symbol] = ev.side;
            else delete this.circuits[ev.symbol];
            for (const fn of this.circuitListeners) fn({ ...this.circuits });
          }
          if (msg.type === "order") {
            for (const fn of this.orderListeners) fn(msg as OrderEvent);
          }
        } catch {}
      };
      ws.onclose = () => {
        this.ws = null;
        if (this.listeners.size > 0 || this.orderListeners.size > 0) {
          this.reconnectTimer = setTimeout(() => this.connect(), 1500);
          this.startPolling();
        }
      };
      ws.onerror = () => ws.close();
    } catch {
      this.startPolling();
    }
  }

  private ensureConnected() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    this.connect();
  }

  private startPolling() {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(async () => {
      try {
        const snap = await api<{ prices: PricesMap }>("/api/market/snapshot");
        this.last = { ...snap.prices };
        for (const [s, p] of Object.entries(this.last)) this.pushPrice(s, Number(p));
        this.emit();
      } catch {}
    }, 1000);
  }

  private disconnect() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.ws?.close();
    this.ws = null;
  }
}

export const liveFeed = new LiveFeed();

export const STATE_LABEL: Record<string, string> = {
  PRE_LAUNCH: "PRE-LAUNCH",
  ACTIVE_MARKET: "MARKET OPEN",
  API_FROZEN: "API FROZEN",
  EVENT_CONCLUDED: "CONCLUDED",
};

export const fmt = (n: number | string | null | undefined, d = 2): string => {
  if (n === null || n === undefined) return "—";
  return Number(n).toLocaleString("en-US", {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  });
};

export const fmtUsd = (n: number | string | null | undefined, d = 2): string => {
  if (n === null || n === undefined) return "—";
  return Number(n).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  });
};

export const fmtInr = (n: number | string | null | undefined, d = 2): string => {
  if (n === null || n === undefined) return "—";
  return Number(n).toLocaleString("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  });
};
