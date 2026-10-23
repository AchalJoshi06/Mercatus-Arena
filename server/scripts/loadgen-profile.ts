/**
 * TEMPORARY PROFILING LOAD GENERATOR v3 (isolated from production behavior).
 *
 * Fixes the v2 generator defect: v2 sampled Windows process metrics with
 * execSync() inside the metrics interval, which BLOCKED the event loop for
 * hundreds of ms at a time and inflated every generator-side latency
 * measurement (observed 1.8-2.2s "event-loop lag"). v3 performs ZERO
 * blocking work: no execSync, no sync fs in the loop.
 *
 * Modes:
 *   MODE=mixed      realistic mix (default)
 *   MODE=tradeheavy trade-heavy for contention tests
 *   MODE=healthz    control test: healthz-only traffic
 *
 * Team placement:
 *   TEAMS=DISTINCT  one team per VU (default)
 *   TEAMS=<N>       VUs share N teams round-robin (same-team contention)
 *
 * Usage:
 *   VUS=50 DURATION_MS=60000 LABEL=run1 npx tsx scripts/loadgen-profile.ts
 */

import pg from "pg";
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { WebSocket } from "ws";
import jwt from "jsonwebtoken";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://mercatus:mercatus@localhost:5432/mercatus";
const API_BASE = process.env.API_BASE ?? "http://localhost:4040";
const WS_BASE = process.env.WS_BASE ?? "ws://localhost:4040/ws";
const JWT_SECRET = process.env.JWT_SECRET ?? "dev-secret-change-me";

const LABEL = process.env.LABEL ?? "run";
const MODE = process.env.MODE ?? "mixed";
const VUS = Number(process.env.VUS ?? 50);
const WARMUP_MS = Number(process.env.WARMUP_MS ?? 15_000);
const DURATION_MS = Number(process.env.DURATION_MS ?? 60_000);
const TEAMS_MODE = process.env.TEAMS ?? "DISTINCT"; // DISTINCT | <number>
const WS_CLIENTS = Number(process.env.WS_CLIENTS ?? 0);
const THINK_MIN = Number(process.env.THINK_MIN ?? 800);
const THINK_MAX = Number(process.env.THINK_MAX ?? 2500);
const BUY_PROB = Number(process.env.BUY_PROB ?? 0.55);
const QTY_MAX = Number(process.env.QTY_MAX ?? 15);

const MIX: Record<Kind, number> =
  MODE === "tradeheavy"
    ? { trade: 0.85, market: 0.05, portfolio: 0.04, mytrades: 0.02, leaderboard: 0.01, healthz: 0.03 }
    : MODE === "healthz"
      ? { trade: 0, market: 0, portfolio: 0, mytrades: 0, leaderboard: 0, healthz: 1 }
      : { trade: 0.32, market: 0.33, portfolio: 0.12, mytrades: 0.05, leaderboard: 0.03, healthz: 0.15 };

const OUT_DIR = path.resolve("..", "reports", "profiling");
fs.mkdirSync(OUT_DIR, { recursive: true });
const SUMMARY_PATH = path.join(OUT_DIR, `loadgen-${LABEL}-summary.json`);
const TRADES_PATH = path.join(OUT_DIR, `loadgen-${LABEL}-trades.csv`);

// ─── State ──────────────────────────────────────────────────────────────────

interface Team {
  teamId: number;
  apiKey: string;
  jwt: string;
  sourceIp: string;
  ws?: WebSocket;
}
let teams: Team[] = [];
let SYMBOLS: string[] = [];

interface TradeRec {
  ts: number;
  phase: string;
  teamId: number;
  action: string;
  symbol: string;
  qty: number;
  httpMs: number;
  serverMs: number | null;
  status: number;
  outcome: string;
}
let tradeRecs: TradeRec[] = [];

const counters = {
  reqs: 0,
  s2xx: 0,
  s429: 0,
  s422: 0,
  s4xxOther: 0,
  s5xx: 0,
  timeouts: 0,
  connErrs: 0,
  tradesAttempted: 0,
  tradesOk: 0,
  tradesRejected: 0,
};
const httpAll: number[] = [];
const httpTradeOk: number[] = [];
const serverTradeOk: number[] = [];
const lagSamples: number[] = [];
const rpsBySec: number[] = [];
let reqsThisSec = 0;

// ─── Provisioning (compact, idempotent) ─────────────────────────────────────

async function provision(): Promise<void> {
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
  const ev = await pool.query(`select state, paused from event_config where id = true`);
  if (ev.rows[0].state !== "ACTIVE_MARKET" || ev.rows[0].paused) {
    throw new Error(`market not active (${ev.rows[0].state})`);
  }
  const lp = await pool.query(`select symbol from live_prices order by symbol`);
  SYMBOLS = lp.rows.map((r) => String(r.symbol));

  let rows = (
    await pool.query(
      `select team_id, api_key, email from teams
       where email like 'lt_%@loadtest.local' and role='team' order by team_id`,
    )
  ).rows;
  if (rows.length < VUS) throw new Error(`need ${VUS} lt_ teams, found ${rows.length} — run loadtest-500-v2.ts once to provision`);
  rows = rows.slice(0, VUS);

  // Reset trading state for the teams we will use
  const ids = rows.map((r) => BigInt(r.team_id));
  await pool.query(
    `update teams set cash_balance=500000, starting_capital=500000,
     total_portfolio_value=500000, is_frozen=false, token_version=0
     where team_id = any($1::bigint[])`,
    [ids.map(String)],
  );
  await pool.query(`delete from order_logs where team_id = any($1::bigint[])`, [ids.map(String)]);
  await pool.query(`delete from request_logs where team_id = any($1::bigint[])`, [ids.map(String)]);
  await pool.query(`delete from holdings where team_id = any($1::bigint[])`, [ids.map(String)]);

  const prices = await pool.query(`select symbol, price from live_prices`);
  const pxOf = new Map(prices.rows.map((r) => [String(r.symbol), Number(r.price)]));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (let b = 0; b < ids.length; b += 25) {
      const slice = ids.slice(b, b + 25);
      const values: string[] = [];
      const params: unknown[] = [];
      let pi = 1;
      for (const tid of slice) {
        for (const sym of SYMBOLS) {
          values.push(`($${pi},$${pi+1},500,$${pi+2})`);
          params.push(tid.toString(), sym, pxOf.get(sym) ?? 100);
          pi += 3;
        }
      }
      await client.query(
        `insert into holdings (team_id, symbol, quantity, average_buy_price) values ${values.join(",")}`,
        params,
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }

  teams = rows.map((r, i) => ({
    teamId: Number(r.team_id),
    apiKey: String(r.api_key),
    jwt: jwt.sign(
      { team_id: Number(r.team_id), email: r.email, role: "team", ver: 0 },
      JWT_SECRET,
      { expiresIn: "24h" },
    ),
    sourceIp: `10.${Math.floor(i / 65025) % 256}.${Math.floor(i / 255) % 256}.${(i % 255) + 1}`,
  }));
  await pool.end();
}

// ─── HTTP ───────────────────────────────────────────────────────────────────

// Deployed targets are HTTPS; local runs stay on plain HTTP.
const httpMod = API_BASE.startsWith("https:") ? https : http;
const agent = new httpMod.Agent({ keepAlive: true, maxSockets: 1600 });

function httpRequest(
  method: string,
  p: string,
  opts: { body?: object; headers?: Record<string, string>; sourceIp?: string; timeoutMs?: number } = {},
): Promise<{ status: number; body: string; ms: number; timedOut: boolean; connErr: boolean }> {
  return new Promise((resolve) => {
    const url = new URL(p, API_BASE);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(opts.sourceIp ? { "X-Forwarded-For": opts.sourceIp } : {}),
      ...opts.headers,
    };
    const bodyStr = opts.body ? JSON.stringify(opts.body) : undefined;
    if (bodyStr) headers["Content-Length"] = Buffer.byteLength(bodyStr).toString();
    const t0 = performance.now();
    const req = httpMod.request(url, { method, headers, agent, timeout: opts.timeoutMs ?? 10_000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
          ms: performance.now() - t0,
          timedOut: false,
          connErr: false,
        }),
      );
    });
    req.on("timeout", () => {
      req.destroy();
      resolve({ status: 0, body: "", ms: performance.now() - t0, timedOut: true, connErr: false });
    });
    req.on("error", (e) =>
      resolve({ status: 0, body: e.message, ms: performance.now() - t0, timedOut: false, connErr: true }),
    );
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ─── Workload ───────────────────────────────────────────────────────────────

type Kind = "trade" | "market" | "portfolio" | "mytrades" | "leaderboard" | "healthz";
const MARKET_PATHS = ["/api/market/snapshot", "/api/market/status", "/api/market/depth", "/api/market/symbols"];

function pickKind(): Kind {
  const r = Math.random();
  let acc = 0;
  for (const k of ["trade", "market", "portfolio", "mytrades", "leaderboard", "healthz"] as Kind[]) {
    acc += MIX[k];
    if (r < acc) return k;
  }
  return "healthz";
}

let seq = 0;

async function doAction(team: Team, phase: string): Promise<void> {
  const kind = pickKind();
  counters.reqs++;
  reqsThisSec++;
  try {
    if (kind === "trade") {
      const action = Math.random() < BUY_PROB ? "BUY" : "SELL";
      const symbol = SYMBOLS[(Math.random() * SYMBOLS.length) | 0];
      const qty = 1 + ((Math.random() * QTY_MAX) | 0);
      const res = await httpRequest(
        "POST",
        action === "BUY" ? "/api/trade/buy" : "/api/trade/sell",
        {
          body: { symbol, quantity: qty, client_ref: `pf-${team.teamId}-${++seq}` },
          headers: { "x-api-key": team.apiKey },
          sourceIp: team.sourceIp,
        },
      );
      classify(res);
      httpAll.push(res.ms);
      counters.tradesAttempted++;
      let serverMs: number | null = null;
      let outcome: string;
      if (res.timedOut) outcome = "TIMEOUT";
      else if (res.connErr) outcome = "CONN_ERROR";
      else {
        try {
          const j = JSON.parse(res.body);
          if (typeof j.latencyMs === "number") serverMs = j.latencyMs;
          outcome =
            res.status === 200 && j.status === "SUCCESS"
              ? "SUCCESS"
              : res.status === 422
                ? `REJECTED:${j.reason ?? "?"}`
                : `HTTP_${res.status}`;
        } catch {
          outcome = `HTTP_${res.status}`;
        }
      }
      if (outcome === "SUCCESS") {
        counters.tradesOk++;
        httpTradeOk.push(res.ms);
        if (serverMs !== null) serverTradeOk.push(serverMs);
      } else if (res.status === 422) counters.tradesRejected++;
      tradeRecs.push({
        ts: Date.now(), phase, teamId: team.teamId, action, symbol, qty,
        httpMs: res.ms, serverMs, status: res.status, outcome,
      });
    } else {
      let p = "/healthz";
      const headers: Record<string, string> = {};
      if (kind === "market") p = MARKET_PATHS[(Math.random() * MARKET_PATHS.length) | 0];
      else if (kind === "portfolio") {
        p = "/api/team/portfolio";
        headers.Authorization = `Bearer ${team.jwt}`;
      } else if (kind === "mytrades") {
        p = "/api/team/trades?limit=50";
        headers.Authorization = `Bearer ${team.jwt}`;
      } else if (kind === "leaderboard") p = "/api/market/leaderboard";
      const res = await httpRequest("GET", p, { headers, sourceIp: team.sourceIp });
      classify(res);
      httpAll.push(res.ms);
    }
  } catch {
    counters.connErrs++;
  }
}

function classify(res: { status: number; timedOut: boolean; connErr: boolean }) {
  if (res.timedOut) counters.timeouts++;
  else if (res.connErr || res.status === 0) counters.connErrs++;
  else if (res.status >= 200 && res.status < 300) counters.s2xx++;
  else if (res.status === 429) counters.s429++;
  else if (res.status === 422) counters.s422++;
  else if (res.status < 500) counters.s4xxOther++;
  else counters.s5xx++;
}

async function virtualUser(team: Team, endAt: number): Promise<void> {
  while (Date.now() < endAt) {
    await doAction(team, "measured");
    const think = THINK_MIN + Math.random() * (THINK_MAX - THINK_MIN);
    await sleep(think);
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Trustworthy event-loop lag monitor (nothing else blocks this loop).
function startLagMonitor(): void {
  let expected = performance.now() + 100;
  setInterval(() => {
    const now = performance.now();
    lagSamples.push(now - expected);
    expected = now + 100;
    if (lagSamples.length > 20_000) lagSamples.shift();
  }, 100).unref();
}

// ─── WebSocket clients ──────────────────────────────────────────────────────

const wsStats = { opened: 0, closed: 0, errors: 0, messages: 0 };

async function connectWs(n: number): Promise<void> {
  for (let i = 0; i < Math.min(n, teams.length); i += 25) {
    await Promise.all(
      teams.slice(i, i + 25).map(
        (t) =>
          new Promise<void>((resolve) => {
            let done = false;
            const fin = () => {
              if (!done) (done = true), resolve();
            };
            const ws = new WebSocket(WS_BASE, {
              headers: { Authorization: `Bearer ${t.jwt}` },
              perMessageDeflate: false,
            });
            t.ws = ws;
            const to = setTimeout(fin, 5000);
            ws.on("open", () => {
              wsStats.opened++;
              clearTimeout(to);
              fin();
            });
            ws.on("error", () => {
              wsStats.errors++;
              clearTimeout(to);
              fin();
            });
            ws.on("close", () => wsStats.closed++);
            ws.on("message", () => wsStats.messages++);
          }),
      ),
    );
    await sleep(30);
  }
}

// ─── Stats helpers ──────────────────────────────────────────────────────────

function pct(a: number[], p: number): number {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
}
function statBlock(a: number[]) {
  if (!a.length) return { n: 0 };
  const s = [...a].sort((x, y) => x - y);
  return {
    n: s.length,
    min: r2(s[0]),
    mean: r2(a.reduce((x, y) => x + y, 0) / a.length),
    p50: r2(pct(a, 50)),
    p90: r2(pct(a, 90)),
    p95: r2(pct(a, 95)),
    p99: r2(pct(a, 99)),
    p999: r2(pct(a, 99.9)),
    max: r2(s[s.length - 1]),
  };
}
const r2 = (n: number) => Math.round(n * 100) / 100;

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log(
    `[loadgen:${LABEL}] mode=${MODE} vus=${VUS} teams=${TEAMS_MODE} ws=${WS_CLIENTS} ` +
    `warmup=${WARMUP_MS}ms measured=${DURATION_MS}ms think=[${THINK_MIN},${THINK_MAX}]`,
  );

  const h = await httpRequest("GET", "/healthz");
  if (h.status !== 200) throw new Error(`server unhealthy: ${h.status}`);
  console.log(`[loadgen:${LABEL}] preflight ok`);

  await provision();
  startLagMonitor();

  // Assign teams: distinct or shared round-robin over N teams
  const nTeamsForVus =
    TEAMS_MODE === "DISTINCT" ? teams.length : Math.max(1, Number(TEAMS_MODE));
  const assigned: Team[] = [];
  for (let i = 0; i < VUS; i++) {
    assigned.push(teams[i % nTeamsForVus]);
  }

  if (WS_CLIENTS > 0) await connectWs(WS_CLIENTS);

  // Warm-up (discarded)
  if (WARMUP_MS > 0) {
    const warmEnd = Date.now() + WARMUP_MS;
    await Promise.all(
      assigned.slice(0, Math.min(VUS, 50)).map(async (t) => {
        while (Date.now() < warmEnd) {
          await doAction(t, "warmup");
          await sleep(THINK_MIN + Math.random() * (THINK_MAX - THINK_MIN));
        }
      }),
    );
  }

  // Reset accumulators for measured phase
  counters.reqs = 0; counters.s2xx = 0; counters.s429 = 0; counters.s422 = 0;
  counters.s4xxOther = 0; counters.s5xx = 0; counters.timeouts = 0; counters.connErrs = 0;
  counters.tradesAttempted = 0; counters.tradesOk = 0; counters.tradesRejected = 0;
  httpAll.length = 0; httpTradeOk.length = 0; serverTradeOk.length = 0;
  tradeRecs = []; lagSamples.length = 0; rpsBySec.length = 0;

  const startWall = Date.now();
  const endAt = startWall + DURATION_MS;
  const rpsTimer = setInterval(() => {
    rpsBySec.push(reqsThisSec);
    reqsThisSec = 0;
  }, 1000);
  const progress = setInterval(() => {
    const el = ((Date.now() - startWall) / 1000).toFixed(0);
    process.stdout.write(
      `\r[${LABEL}] ${el}s/${DURATION_MS / 1000}s reqs=${counters.reqs} okTrades=${counters.tradesOk} rej=${counters.tradesRejected} 429=${counters.s429} 5xx=${counters.s5xx}   `,
    );
  }, 3000);

  await Promise.all(assigned.map((t) => virtualUser(t, endAt)));

  clearInterval(progress);
  clearInterval(rpsTimer);
  const actualMs = Date.now() - startWall;
  const el = actualMs / 1000;

  fs.writeFileSync(
    TRADES_PATH,
    "ts,phase,team_id,action,symbol,qty,http_ms,server_ms,status,outcome\n" +
      tradeRecs.map((r) => `${r.ts},${r.phase},${r.teamId},${r.action},${r.symbol},${r.qty},${r.httpMs.toFixed(2)},${r.serverMs ?? ""},${r.status},${r.outcome}`).join("\n"),
  );

  const summary = {
    label: LABEL,
    mode: MODE,
    config: {
      vus: VUS, teamsMode: TEAMS_MODE, wsClients: WS_CLIENTS,
      warmupMs: WARMUP_MS, requestedDurationMs: DURATION_MS, actualDurationMs: actualMs,
      thinkMs: [THINK_MIN, THINK_MAX], mix: MIX, buyProb: BUY_PROB, qtyMax: QTY_MAX,
    },
    counters,
    httpAll: statBlock(httpAll),
    httpTradeSuccess: statBlock(httpTradeOk),
    serverTradeSuccess: statBlock(serverTradeOk),
    generatorEventLoopLagMs: {
      p50: r2(pct(lagSamples, 50)),
      p95: r2(pct(lagSamples, 95)),
      p99: r2(pct(lagSamples, 99)),
      max: lagSamples.length ? r2(Math.max(...lagSamples)) : 0,
    },
    throughput: {
      avgRps: r2(counters.reqs / el),
      peakRps: rpsBySec.length ? Math.max(...rpsBySec) : 0,
      tradesPerSec: r2(counters.tradesOk / el),
    },
    ws: wsStats,
  };
  fs.writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 1));
  console.log(`\n[loadgen:${LABEL}] done in ${el.toFixed(1)}s -> ${SUMMARY_PATH}`);
  console.log(
    `[loadgen:${LABEL}] trades ok=${counters.tradesOk} rej=${counters.tradesRejected} 429=${counters.s429} | ` +
    `srv P50=${summary.serverTradeSuccess.p50 ?? "NA"} P95=${summary.serverTradeSuccess.p95 ?? "NA"} | ` +
    `genLagMax=${summary.generatorEventLoopLagMs.max}ms`,
  );

  agent.destroy();
  process.exit(0);
}

main().catch((e) => {
  console.error("[fatal]", e);
  process.exit(1);
});
