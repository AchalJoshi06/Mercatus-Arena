import pg from "pg";
import WebSocket from "ws";
import { config as dotenv } from "dotenv";
dotenv({ path: ".env" });

const BASE = process.env.BASE_URL ?? "http://localhost:4040";
const WS_URL = process.env.WS_URL ?? "ws://localhost:4040/ws";

const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();

const { rows: bots } = await c.query(
  `select team_id, team_name, api_key from teams where team_name like 'demo-%' order by team_id`,
);
const { rows: symRows } = await c.query(`select symbol from live_prices order by symbol`);
const SYMBOLS = symRows.map((r) => r.symbol);
// keep a live pool for per-cycle price polling (decoupled from WS rate)
const priceDb = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function refreshPrices() {
  try {
    const { rows } = await priceDb.query(`select symbol, price from live_prices`);
    for (const r of rows) {
      const p = Number(r.price);
      lastPrice.set(r.symbol, p);
      const h = history.get(r.symbol);
      if (h) { h.push(p); if (h.length > 60) h.shift(); }
    }
  } catch { /* ignore */ }
}

const lastPrice = new Map();
const history = new Map(); // symbol -> number[]
for (const s of SYMBOLS) history.set(s, []);

// ---- strategy signal functions: return "BUY" | "SELL" | "HOLD" ----
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const last = (a) => a[a.length - 1];

function momentum(a, thr = 0.004) {
  if (a.length < 12) return "HOLD";
  const r = last(a) / a[a.length - 12] - 1;
  if (r > thr) return "BUY";
  if (r < -thr) return "SELL";
  return "HOLD";
}
function meanReversion(a, thr = 0.006) {
  if (a.length < 20) return "HOLD";
  const m = mean(a);
  const p = last(a);
  if (p < m * (1 - thr)) return "BUY";
  if (p > m * (1 + thr)) return "SELL";
  return "HOLD";
}
function macCross(a) {
  if (a.length < 30) return "HOLD";
  const s = mean(a.slice(-5));
  const l = mean(a.slice(-25));
  if (s > l * 1.0008) return "BUY";
  if (s < l * 0.9992) return "SELL";
  return "HOLD";
}
function breakout(a, thr = 0.01) {
  if (a.length < 25) return "HOLD";
  const win = a.slice(-25);
  const p = last(a);
  if (p >= Math.max(...win) * (1 - thr)) return "BUY";
  if (p <= Math.min(...win) * (1 + thr)) return "SELL";
  return "HOLD";
}
function rsi(a) {
  if (a.length < 15) return "HOLD";
  let up = 0, down = 0;
  for (let i = 1; i < a.length; i++) {
    const d = a[i] - a[i - 1];
    if (d > 0) up += d; else down -= d;
  }
  const rs = up / (down || 1e-9);
  const v = 100 - 100 / (1 + rs);
  if (v < 35) return "BUY";
  if (v > 68) return "SELL";
  return "HOLD";
}
function bollinger(a, k = 2) {
  if (a.length < 20) return "HOLD";
  const m = mean(a);
  const sd = Math.sqrt(mean(a.map((x) => (x - m) ** 2)));
  const p = last(a);
  if (p < m - k * sd) return "BUY";
  if (p > m + k * sd) return "SELL";
  return "HOLD";
}
function trend(a) {
  if (a.length < 20) return "HOLD";
  const slope = a[a.length - 1] - a[a.length - 20];
  if (slope > 0) return "BUY";
  if (slope < 0) return "SELL";
  return "HOLD";
}
function pairs(a, b) {
  if (a.length < 15 || b.length < 15) return "HOLD";
  const ra = last(a) / a[0] - 1;
  const rb = last(b) / b[0] - 1;
  const spread = ra - rb;
  if (spread < -0.01) return "BUY";
  if (spread > 0.01) return "SELL";
  return "HOLD";
}

const REGISTRY = {
  "moving-average-crossover": (a) => macCross(a),
  "trend-following": (a) => trend(a),
  macd: (a) => macCross(a),
  rsi: (a) => rsi(a),
  "bollinger-bands": (a) => bollinger(a),
  "mean-reversion": (a) => meanReversion(a),
  momentum: (a) => momentum(a),
  breakout: (a) => breakout(a),
  "volatility-breakout": (a) => breakout(a, 0.015),
  "fibonacci-retracement": (a) => bollinger(a, 1.5),
  ichimoku: (a) => trend(a),
  renko: (a) => trend(a),
  "heikin-ashi": (a) => trend(a),
  "order-flow": (a) => momentum(a, 0.003),
  "liquidity-hunting": (a) => breakout(a, 0.012),
  scalping: (a) => meanReversion(a, 0.003),
  "swing-trading": (a) => trend(a),
  "grid-trading": (a) => meanReversion(a, 0.008),
  "machine-learning": (a) => macCross(a),
  "reinforcement-learning": (a) => momentum(a, 0.005),
  "market-making": (a) => bollinger(a, 1.2),
  sentiment: (a) => meanReversion(a),
  "news-based": (a) => meanReversion(a),
  "pairs-trading": "pairs",
  "statistical-arbitrage": "pairs",
  arbitrage: "pairs",
  "gamma-scalping": "pairs",
  "delta-neutral": "pairs",
  "volume-profile": (a) => bollinger(a, 2),
  vwap: (a) => meanReversion(a, 0.004),
};

function resolveFn(strategy) {
  const v = REGISTRY[strategy] ?? meanReversion;
  return typeof v === "function" ? v : "pairs";
}

// ---- build bot state ----
const agents = bots.map((b) => {
  const strategy = b.team_name.replace(/^demo-/, "");
  const pick = () => SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)];
  const tracked = new Set();
  const n = 3 + Math.floor(Math.random() * 3);
  for (let i = 0; i < n; i++) tracked.add(pick());
  // for pairs strategies pick two correlated symbols
  let pair = null;
  if (resolveFn(strategy) === "pairs") {
    const arr = [...tracked];
    pair = [arr[0] ?? pick(), arr[1] ?? pick()];
  }
  return {
    id: b.team_id,
    name: b.team_name,
    apiKey: b.api_key,
    strategy,
    fn: resolveFn(strategy),
    tracked,
    pair,
    positions: new Map(), // symbol -> qty
    qtyBase: 10 + Math.floor(Math.random() * 40),
  };
});

let orders = 0, buys = 0, sells = 0;

async function trade(agent, symbol, side) {
  const qty = agent.qtyBase + Math.floor(Math.random() * 15);
  try {
    const res = await fetch(`${BASE}/api/trade/${side}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": agent.apiKey },
      body: JSON.stringify({ symbol, quantity: qty, client_ref: `${agent.name}-${Date.now()}` }),
    });
    const j = await res.json();
    if (j.status === "SUCCESS") {
      orders++;
      if (side === "buy") { buys++; agent.positions.set(symbol, (agent.positions.get(symbol) || 0) + qty); }
      else { sells++; agent.positions.delete(symbol); }
    }
  } catch { /* ignore network blips */ }
}

async function decide(agent) {
  await refreshPrices();
  if (agent.fn === "pairs" && agent.pair) {
    const [s1, s2] = agent.pair;
    const a = history.get(s1), b = history.get(s2);
    if (!a || !b || a.length < 8) return;
    const sig = pairs(a, b);
    if (sig === "BUY" && !agent.positions.has(s1)) trade(agent, s1, "buy");
    if (sig === "SELL" && agent.positions.has(s1)) trade(agent, s1, "sell");
    return;
  }
  for (const symbol of agent.tracked) {
    const h = history.get(symbol);
    if (!h || h.length < 8) continue;
    const sig = agent.fn(h);
    if (sig === "BUY" && agent.positions.size < 4 && !agent.positions.has(symbol)) {
      trade(agent, symbol, "buy");
      return; // one order per cycle (rate-limit safe)
    } else if (sig === "SELL" && agent.positions.has(symbol)) {
      trade(agent, symbol, "sell");
      return;
    }
  }
}

// ---- market data feed ----
const ws = new WebSocket(WS_URL);
ws.on("message", (data) => {
  let msg;
  try { msg = JSON.parse(data.toString()); } catch { return; }
  if (msg.type === "tick" && Array.isArray(msg.prices)) {
    for (const p of msg.prices) {
      if (typeof p.price !== "number") continue;
      lastPrice.set(p.symbol, p.price);
      const h = history.get(p.symbol);
      if (h) { h.push(p.price); if (h.length > 60) h.shift(); }
    }
  }
  if (msg.type === "hello" && msg.payload?.prices) {
    for (const [sym, price] of Object.entries(msg.payload.prices)) {
      lastPrice.set(sym, price);
      const h = history.get(sym);
      if (h && h.length === 0) h.push(price);
    }
  }
});
ws.on("error", (e) => console.error("[ws] error", e.message));

// ---- per-bot decision loops ----
for (const agent of agents) {
  const interval = 1500 + Math.floor(Math.random() * 2000);
  setInterval(() => decide(agent), interval);
}

setInterval(() => {
  console.log(`[heartbeat] bots=${agents.length} orders=${orders} buys=${buys} sells=${sells} ws=${ws.readyState === 1 ? "open" : "down"}`);
}, 30000);

console.log(`[demo-bots] started ${agents.length} bots on ${SYMBOLS.length} symbols; market=${WS_URL}`);
