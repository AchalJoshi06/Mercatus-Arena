function getBaseUrl() {
  if (typeof window === "undefined") {
    return process.env.API_BASE || process.env.NEXT_PUBLIC_API_BASE || "http://localhost:4040";
  }
  const envBase = process.env.NEXT_PUBLIC_API_BASE;
  if (envBase && !envBase.includes("localhost") && !envBase.includes("127.0.0.1")) {
    return envBase;
  }
  if (window.location.hostname && window.location.hostname !== "localhost" && window.location.hostname !== "127.0.0.1") {
    const proto = window.location.protocol === "https:" ? "https:" : "http:";
    return `${proto}//${window.location.hostname}:4040`;
  }
  return envBase || `http://${window.location.hostname}:4040`;
}

function getWsUrl() {
  if (typeof window === "undefined") {
    return process.env.WS_URL || process.env.NEXT_PUBLIC_WS_URL || "ws://localhost:4040/ws";
  }
  const envWs = process.env.NEXT_PUBLIC_WS_URL;
  if (envWs && !envWs.includes("localhost") && !envWs.includes("127.0.0.1")) {
    return envWs;
  }
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  if (window.location.hostname && window.location.hostname !== "localhost" && window.location.hostname !== "127.0.0.1") {
    return `${proto}//${window.location.hostname}:4040/ws`;
  }
  return envWs || `${proto}//${window.location.hostname}:4040/ws`;
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
    const err = Object.assign(new Error(data?.error ?? `HTTP ${res.status}`), data);
    (err as unknown as { status: number }).status = res.status;
    throw err;
  }
  return data as T;
}

export interface Account {
  team_id: number;
  token: string;
  team_name: string;
  email: string;
  role: string;
}

const ACCOUNTS_KEY = "mercatus_accounts";
const ACTIVE_KEY = "mercatus_active";
const ACTIVE_TAB_KEY = "mercatus_active_tab";

function readAccounts(): Account[] {
  if (typeof window === "undefined") return [];
  try {
    const list: Account[] = JSON.parse(localStorage.getItem(ACCOUNTS_KEY) || "[]");
    if (list.length === 0) {
      // One-time migration from the legacy single-token key.
      const legacy = localStorage.getItem("mercatus_token");
      if (legacy) {
        const d = decodeJwt(legacy);
        localStorage.removeItem("mercatus_token");
        if (d && d.team_id) {
          const acc: Account = {
            team_id: d.team_id,
            token: legacy,
            team_name: d.email ?? "account",
            email: d.email ?? "",
            role: d.role ?? "team",
          };
          writeAccounts([acc]);
          localStorage.setItem(ACTIVE_KEY, String(acc.team_id));
          return [acc];
        }
      }
    }
    return list;
  } catch {
    return [];
  }
}

function writeAccounts(list: Account[]) {
  if (typeof window === "undefined") return;
  localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(list));
}

function decodeJwt(token: string): { team_id?: number; email?: string; role?: string } | null {
  try {
    const payload = token.split(".")[1];
    const json = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    return json;
  } catch {
    return null;
  }
}

export function getAccounts(): Account[] {
  return readAccounts();
}

export function getActive(role?: string): Account | null {
  const list = readAccounts();
  if (list.length === 0) return null;
  // 1. Per-tab override: check if this tab has an active account stored in sessionStorage
  if (typeof window !== "undefined" && window.sessionStorage) {
    const tabId = window.sessionStorage.getItem(ACTIVE_TAB_KEY);
    if (tabId != null) {
      const t = list.find((a) => String(a.team_id) === tabId);
      if (t && (!role || t.role === role)) return t;
    }
  }
  // 2. If a specific role is requested (e.g. 'admin'), ONLY return an account matching that role
  if (role) {
    return list.find((a) => a.role === role) ?? null;
  }
  // 3. Fallback to localStorage active key or last saved account
  const activeId = typeof window !== "undefined" ? localStorage.getItem(ACTIVE_KEY) : null;
  const match = list.find((a) => String(a.team_id) === activeId);
  return match ?? list[list.length - 1] ?? null;
}

export function getToken(role?: string): string | null {
  return getActive(role)?.token ?? null;
}

export function setToken(token: string): Account | null {
  const decoded = decodeJwt(token);
  if (!decoded || !decoded.team_id) return null;
  const account: Account = {
    team_id: decoded.team_id,
    token,
    team_name: decoded.email ?? "account",
    email: decoded.email ?? "",
    role: decoded.role ?? "team",
  };
  const list = readAccounts().filter((a) => a.team_id !== account.team_id);
  list.push(account);
  writeAccounts(list);
  localStorage.setItem(ACTIVE_KEY, String(account.team_id));
  if (typeof window !== "undefined" && window.sessionStorage) {
    window.sessionStorage.setItem(ACTIVE_TAB_KEY, String(account.team_id));
  }
  // enrich profile (team_name) without blocking the caller
  api<{ team_name: string; email?: string }>("/api/auth/me", { token })
    .then((me) => {
      const cur = readAccounts();
      const idx = cur.findIndex((a) => a.team_id === account.team_id);
      if (idx >= 0) {
        cur[idx] = { ...cur[idx], team_name: me.team_name, email: me.email ?? cur[idx].email };
        writeAccounts(cur);
      }
    })
    .catch(() => {});
  return account;
}

export function switchAccount(teamId: number) {
  if (readAccounts().some((a) => a.team_id === teamId)) {
    if (typeof window !== "undefined" && window.sessionStorage) {
      window.sessionStorage.setItem(ACTIVE_TAB_KEY, String(teamId));
    } else {
      localStorage.setItem(ACTIVE_KEY, String(teamId));
    }
  }
}

export function removeAccount(teamId: number) {
  const list = readAccounts().filter((a) => a.team_id !== teamId);
  writeAccounts(list);
  if (typeof window !== "undefined" && window.sessionStorage) {
    if (window.sessionStorage.getItem(ACTIVE_TAB_KEY) === String(teamId)) {
      if (list.length) window.sessionStorage.setItem(ACTIVE_TAB_KEY, String(list[list.length - 1].team_id));
      else window.sessionStorage.removeItem(ACTIVE_TAB_KEY);
    }
  }
  const globalKey = localStorage.getItem(ACTIVE_KEY);
  if (globalKey != null && globalKey === String(teamId)) {
    if (list.length) localStorage.setItem(ACTIVE_KEY, String(list[list.length - 1].team_id));
    else {
      localStorage.removeItem(ACTIVE_KEY);
      localStorage.removeItem(ACCOUNTS_KEY);
    }
  }
}

export function logoutActive() {
  const a = getActive();
  if (a) removeAccount(a.team_id);
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
  // Coalesce price pushes so the UI repaints at most ~every MIN_EMIT_MS even
  // when the tape prints faster (replay_speed can push ticks <100ms apart).
  private lastEmit = 0;
  private emitTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly MIN_EMIT_MS = 220;

  // Returns true if any listener across all categories is still active.
  // Used by every unsubscribe callback and the onclose reconnect guard so a
  // component that only subscribes to e.g. onTrade (never to subscribe()) still
  // keeps the WebSocket alive for as long as it needs it.
  private hasAnyListeners(): boolean {
    return (
      this.listeners.size > 0 ||
      this.orderListeners.size > 0 ||
      this.tradeListeners.size > 0 ||
      this.depthListeners.size > 0 ||
      this.circuitListeners.size > 0
    );
  }

  subscribe(fn: (prices: PricesMap) => void): () => void {
    this.listeners.add(fn);
    fn({ ...this.last });
    this.ensureConnected();
    return () => {
      this.listeners.delete(fn);
      if (!this.hasAnyListeners()) this.disconnect();
    };
  }

  onOrder(fn: (order: OrderEvent) => void): () => void {
    this.orderListeners.add(fn);
    this.ensureConnected();
    return () => {
      this.orderListeners.delete(fn);
      if (!this.hasAnyListeners()) this.disconnect();
    };
  }

  onTrade(fn: (trade: TradeEvent) => void): () => void {
    this.tradeListeners.add(fn);
    this.ensureConnected();
    return () => {
      this.tradeListeners.delete(fn);
      if (!this.hasAnyListeners()) this.disconnect();
    };
  }

  onDepth(fn: (depth: Record<string, Book>) => void): () => void {
    this.depthListeners.add(fn);
    this.ensureConnected();
    return () => {
      this.depthListeners.delete(fn);
      if (!this.hasAnyListeners()) this.disconnect();
    };
  }

  onCircuit(fn: (circuits: Record<string, "upper" | "lower">) => void): () => void {
    this.circuitListeners.add(fn);
    this.ensureConnected();
    return () => {
      this.circuitListeners.delete(fn);
      if (!this.hasAnyListeners()) this.disconnect();
    };
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
    const now = Date.now();
    const since = now - this.lastEmit;
    if (since >= LiveFeed.MIN_EMIT_MS) {
      this.lastEmit = now;
      const snap = { ...this.last };
      for (const fn of this.listeners) fn(snap);
      return;
    }
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      this.lastEmit = Date.now();
      const snap = { ...this.last };
      for (const fn of this.listeners) fn(snap);
    }, LiveFeed.MIN_EMIT_MS - since);
  }

  private connect() {
    const token = getToken();
    try {
      const protocols = token ? [`mercatus.${token}`] : [];
      const ws = new WebSocket(WS_URL, protocols);
      this.ws = ws;
      ws.onopen = () => {
        this.stopPolling();
      };
      ws.onmessage = (ev) => {
        this.stopPolling();
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
          if (msg.type === "state" && msg.state === "ACTIVE_MARKET") {
            this.history = {};
          }
        } catch {}
      };
      ws.onclose = () => {
        this.ws = null;
        // Reconnect only if listeners are active.
        if (this.hasAnyListeners()) {
          this.reconnectTimer = setTimeout(() => this.connect(), 1500);
          this.startPolling();
        } else {
          this.stopPolling();
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
    }, 2000);
  }

  private stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private disconnect() {
    if (this.emitTimer) clearTimeout(this.emitTimer);
    this.emitTimer = null;
    this.stopPolling();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.ws) {
      const socket = this.ws;
      this.ws = null;
      socket.onclose = null;
      socket.onerror = null;
      socket.close();
    }
  }
}

export const liveFeed = new LiveFeed();


export const fmt = (n: number | string | null | undefined, d = 2): string => {
  if (n === null || n === undefined) return "—";
  return Number(n).toLocaleString("en-US", {
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
