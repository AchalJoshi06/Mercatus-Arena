import pg from "pg";
import { config as dotenv } from "dotenv";
dotenv({ path: ".env" });

const BASE = process.env.BASE_URL ?? "http://localhost:4040";

const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const { rows: taster } = await c.query(
  `select team_id, team_name, email, api_key from teams where team_name = 'taster' and role = 'team'`,
);
if (taster.length === 0) {
  console.error("[optimal] taster account not found");
  process.exit(1);
}
const bot = taster[0];
console.log(`[optimal] linked to ${bot.team_name} (id=${bot.team_id}, email=${bot.email})`);

const { rows: symRows } = await c.query(`select symbol from live_prices order by symbol`);
const SYMBOLS = symRows.map((r) => r.symbol);
const priceDb = new pg.Pool({ connectionString: process.env.DATABASE_URL });
await c.end();

const history = new Map();
for (const s of SYMBOLS) history.set(s, []);

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

// "Optimal": trend-following MA crossover, only trades in the direction of the
// longer-term trend, with a max-position cap for diversification/risk control.
function optimalSignal(hist) {
  if (hist.length < 50) return "HOLD";
  const last = hist[hist.length - 1];
  const fast = mean(hist.slice(-5));
  const slow = mean(hist.slice(-20));
  const trend = mean(hist.slice(-50));
  if (last > trend) {
    if (fast > slow) return "BUY";
    if (fast < slow * 0.999) return "SELL";
  } else {
    if (fast < slow) return "SELL";
  }
  return "HOLD";
}

async function refresh() {
  try {
    const { rows } = await priceDb.query(`select symbol, price from live_prices`);
    for (const r of rows) {
      const p = Number(r.price);
      const h = history.get(r.symbol);
      if (h) { h.push(p); if (h.length > 80) h.shift(); }
    }
  } catch {}
}

const MAX_POS = 8;
const positions = new Map();
let orders = 0, buys = 0, sells = 0;

async function trade(symbol, side) {
  const qty = 20 + Math.floor(Math.random() * 30);
  try {
    const res = await fetch(`${BASE}/api/trade/${side}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": bot.api_key },
      body: JSON.stringify({ symbol, quantity: qty, client_ref: `optimal-${Date.now()}` }),
    });
    const j = await res.json();
    if (j.status === "SUCCESS") {
      orders++;
      if (side === "buy") { buys++; positions.set(symbol, (positions.get(symbol) || 0) + qty); }
      else { sells++; positions.delete(symbol); }
    }
  } catch {}
}

async function decide() {
  await refresh();
  const tracked = SYMBOLS;
  for (const symbol of tracked) {
    const h = history.get(symbol);
    if (!h || h.length < 50) continue;
    const sig = optimalSignal(h);
    if (sig === "BUY" && positions.size < MAX_POS && !positions.has(symbol)) {
      await trade(symbol, "buy");
      return;
    } else if (sig === "SELL" && positions.has(symbol)) {
      await trade(symbol, "sell");
      return;
    }
  }
}

const interval = 1500;
setInterval(() => void decide(), interval);
setInterval(() => {
  console.log(`[optimal heartbeat] orders=${orders} buys=${buys} sells=${sells} positions=${positions.size}`);
}, 30000);

console.log(`[optimal] started on ${SYMBOLS.length} symbols; api=${BASE}`);
