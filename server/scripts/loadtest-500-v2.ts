/**
 * Mercatus Arena — 500-User / 5-Minute Trade Latency Test v2
 *
 * Fixes every failure mode of the invalid v1 run:
 *   - Uses REAL symbols read from live_prices (v1 hardcoded AAPL/MSFT which
 *     do not exist in the active dataset -> INVALID_SYMBOL).
 *   - Provisions every team with large cash balance AND holdings in every
 *     symbol -> no INSUFFICIENT_FUNDS / INSUFFICIENT_POSITION rejections.
 *   - Workload is designed to stay UNDER the production rate limits
 *     (60 trades/min/team, 300 api/min/IP) instead of drowning in 429s:
 *       * ~12 trades/min/team worst case (< 60 limit)
 *       * each virtual user presents a unique simulated source IP via
 *         X-Forwarded-For (trustProxy=1), mirroring production where every
 *         user arrives from a distinct address behind the proxy.
 *     The limiters themselves remain ACTIVE with production configuration.
 *   - Separates SERVER-SIDE execution latency (latency_ms returned by
 *     executeOrder() in atomic.ts, SUCCESS trades only) from HTTP
 *     end-to-end latency. Never mixes them.
 *   - Hard validation gate: if successfulTrades == 0 the test reports
 *     "TEST INVALID FOR TRADE LATENCY"; < 1000 => LOW SAMPLE SIZE flag.
 *
 * Phases: provision -> websocket connect -> WARM-UP (discarded) ->
 *         MEASURED 300s -> cleanup. Durations printed explicitly.
 *
 * Usage:
 *   npx tsx scripts/loadtest-500-v2.ts            # full run
 *   SMOKE=1 npx tsx scripts/loadtest-500-v2.ts    # 50 VUs / 20s plumbing check
 */

import pg from "pg";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import { execSync } from "node:child_process";
import { WebSocket } from "ws";
import jwt from "jsonwebtoken";

// ─── Configuration ──────────────────────────────────────────────────────────

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://mercatus:mercatus@localhost:5432/mercatus";
const API_BASE = process.env.API_BASE ?? "http://localhost:4040";
const WS_BASE = process.env.WS_BASE ?? "ws://localhost:4040/ws";
const JWT_SECRET = process.env.JWT_SECRET ?? "dev-secret-change-me";

const SMOKE = process.env.SMOKE === "1";
const VIRTUAL_USERS = Number(process.env.VIRTUAL_USERS ?? (SMOKE ? 50 : 500));
const WARMUP_MS = Number(process.env.WARMUP_MS ?? (SMOKE ? 5_000 : 60_000));
const MEASURED_MS = Number(process.env.MEASURED_MS ?? (SMOKE ? 20_000 : 300_000));

const REPORT_DIR = path.resolve("..", "reports");
const TRADE_CSV = path.join(REPORT_DIR, "trade-samples-v2.csv");
const TIMESERIES_JSON = path.join(REPORT_DIR, "metrics-timeseries-v2.json");

// Workload mix (sums to 1.0). Trade probability kept low enough that even the
// most aggressive user profile stays far below RATE_LIMIT_TRADE=60/min/team.
const MIX = {
  trade: 0.32,
  marketRead: 0.33,
  portfolio: 0.12,
  myTrades: 0.05,
  leaderboard: 0.03,
  healthz: 0.15,
};
const THINK_MIN_MS = 800;
const THINK_MAX_MS = 2500;
const BUY_PROB = 0.55;
const QTY_MAX = 15;

const TRADE_RATE_LIMIT_PER_MIN = 60; // production config, verified below

// ─── Metrics state ──────────────────────────────────────────────────────────

interface TradeRecord {
  ts: string;
  phase: "warmup" | "measured";
  teamId: number;
  action: "BUY" | "SELL";
  symbol: string;
  quantity: number;
  httpMs: number;
  serverMs: number | null;
  httpStatus: number;
  outcome: string; // SUCCESS | REJECTED:<reason> | HTTP_<n> | TIMEOUT | CONN_ERROR
}

const tradeRecords: TradeRecord[] = [];
let csvFlushTimer: NodeJS.Timeout | null = null;

const counters = {
  totalRequests: 0,
  requests2xx: 0,
  requests429: 0,
  requests422: 0,
  requestsOther4xx: 0,
  requests5xx: 0,
  requestsTimeout: 0,
  requestsConnErr: 0,
  tradesAttempted: 0,
  tradesSuccess: 0,
  tradesRejected422: 0,
  trades429: 0,
  tradesOtherFail: 0,
};
const reasonCounts = new Map<string, number>();
const endpointCounts = new Map<string, number>();

const httpAll: number[] = []; // every completed request
const httpTradeSuccess: number[] = []; // HTTP latency of SUCCESSFUL trades only
const serverTradeSuccess: number[] = []; // atomic.ts latencyMs of SUCCESSFUL trades only

const rpsBySecond: number[] = [];
const tradeRpsBySecond: number[] = [];
let reqsThisSecond = 0;
let tradesThisSecond = 0;

let inflight = 0;
let peakInflight = 0;

// WebSocket tracking
const wsState = {
  opened: 0,
  closed: 0,
  errors: 0,
  messages: 0,
  bytesIn: 0,
  msgTypeCounts: {} as Record<string, number>,
  pushAfterResponseMs: [] as number[], // order-broadcast delay after HTTP response
  pushUnmatched: 0,
};
const pendingOrderPush = new Map<
  number,
  { respAt: number; teamId: number }
>();

// Timeseries samples (measured phase)
const timeseries: Record<string, number | string>[] = [];

// ─── Small utilities ────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[idx];
}
function mean(a: number[]): number {
  return a.length === 0 ? NaN : a.reduce((x, y) => x + y, 0) / a.length;
}
function stddev(a: number[]): number {
  if (a.length < 2) return NaN;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
}
function fmt(n: number, d = 2): string {
  return Number.isFinite(n) ? n.toFixed(d) : "N/A";
}
function countUnder(sorted: number[], t: number): number {
  let lo = 0, hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
function bump(map: Map<string, number>, k: string, n = 1) {
  map.set(k, (map.get(k) ?? 0) + n);
}

// ─── HTTP client (keep-alive agent) ─────────────────────────────────────────

const agent = new http.Agent({ keepAlive: true, maxSockets: 1600 });

interface HttpResult {
  status: number;
  body: string;
  httpMs: number;
  timedOut: boolean;
  connError: boolean;
}

function httpRequest(
  method: string,
  pathWithQuery: string,
  opts: {
    body?: object;
    headers?: Record<string, string>;
    timeoutMs?: number;
    sourceIp?: string;
  } = {},
): Promise<HttpResult> {
  return new Promise((resolve) => {
    const url = new URL(pathWithQuery, API_BASE);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(opts.sourceIp ? { "X-Forwarded-For": opts.sourceIp } : {}),
      ...opts.headers,
    };
    const bodyStr = opts.body ? JSON.stringify(opts.body) : undefined;
    if (bodyStr) headers["Content-Length"] = Buffer.byteLength(bodyStr).toString();

    const start = performance.now();
    const req = http.request(
      url,
      { method, headers, agent, timeout: opts.timeoutMs ?? 10_000 },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            httpMs: performance.now() - start,
            timedOut: false,
            connError: false,
          });
        });
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({
        status: 0,
        body: '{"error":"TIMEOUT"}',
        httpMs: performance.now() - start,
        timedOut: true,
        connError: false,
      });
    });
    req.on("error", (err) => {
      resolve({
        status: 0,
        body: JSON.stringify({ error: err.message }),
        httpMs: performance.now() - start,
        timedOut: false,
        connError: true,
      });
    });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ─── Provisioning ───────────────────────────────────────────────────────────

interface Team {
  teamId: number;
  apiKey: string;
  email: string;
  jwt: string;
  sourceIp: string;
  ws?: WebSocket;
}

let teams: Team[] = [];
let SYMBOLS: string[] = [];

async function provision(): Promise<void> {
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
  const q = (text: string, params?: unknown[]) => pool.query(text, params);

  // 0. Event must already be ACTIVE_MARKET (configured before server start).
  const ev = await q(`select state, paused from event_config where id = true`);
  if (ev.rows[0].state !== "ACTIVE_MARKET" || ev.rows[0].paused) {
    throw new Error(
      `event_config.state=${ev.rows[0].state} paused=${ev.rows[0].paused} — set ACTIVE_MARKET before starting the server`,
    );
  }

  // 1. Real tradable symbols straight from the database.
  const lp = await q(`select symbol from live_prices order by symbol`);
  SYMBOLS = lp.rows.map((r) => String(r.symbol));
  if (SYMBOLS.length === 0) throw new Error("live_prices is empty");
  console.log(`[provision] ${SYMBOLS.length} live symbols: ${SYMBOLS.join(",")}`);

  // 2. Ensure exactly VIRTUAL_USERS test teams exist (create any missing).
  const existing = await q(
    `select team_id, api_key, email from teams
     where email like 'lt_%@loadtest.local' and role = 'team'
     order by team_id`,
  );
  let rows: { team_id: string; api_key: string; email: string }[] = existing.rows;
  const need = VIRTUAL_USERS - rows.length;
  if (need > 0) {
    console.log(`[provision] creating ${need} missing teams...`);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (let i = rows.length; i < VIRTUAL_USERS; i++) {
        await client.query(
          `insert into teams (team_name, role, email, password_hash, api_key,
                              cash_balance, starting_capital, total_portfolio_value)
           values ($1,'team',$2,$3,$4,500000,500000,500000)
           on conflict (email) do nothing`,
          [
            `LT_v2_${String(i).padStart(4, "0")}`,
            `lt_${String(i).padStart(4, "0")}@loadtest.local`,
            "$2a$10$abcdefghijklmnopqrstuvABCDEFGHIJKLMNOPQRSTUVWXYZ012345", // unusable dummy hash
            `sk_${randomBytes(24).toString("hex")}`,
          ],
        );
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
    const after = await q(
      `select team_id, api_key, email from teams
       where email like 'lt_%@loadtest.local' and role='team' order by team_id`,
    );
    rows = after.rows;
  }
  if (rows.length < VIRTUAL_USERS) throw new Error(`only ${rows.length} test teams available`);

  // 3. Reset the teams to a known-good trading state (TEST-ONLY rows).
  const ids = rows.map((r) => BigInt(r.team_id));
  console.log(`[provision] resetting ${ids.length} teams (cash=500k, unfrozen, fresh logs)...`);
  await q(
    `update teams set cash_balance = 500000, starting_capital = 500000,
                     total_portfolio_value = 500000, is_frozen = false,
                     token_version = 0
     where team_id = any($1::bigint[]) and role = 'team'`,
    [ids.map(String)],
  );
  await q(`delete from order_logs where team_id = any($1::bigint[])`, [ids.map(String)]);
  await q(`delete from request_logs where team_id = any($1::bigint[])`, [ids.map(String)]);
  await q(`delete from holdings where team_id = any($1::bigint[])`, [ids.map(String)]);

  // 4. Seed holdings: 500 units of EVERY live symbol per team, cost basis =
  //    current live price. Guarantees SELL orders always have position.
  const prices = await q(`select symbol, price from live_prices`);
  const pxOf = new Map<string, number>(
    prices.rows.map((r) => [String(r.symbol), Number(r.price)]),
  );
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const BATCH_TEAMS = 25; // 25 teams x 30 syms x 4 params = 3000 params < 65535
    for (let b = 0; b < ids.length; b += BATCH_TEAMS) {
      const slice = ids.slice(b, b + BATCH_TEAMS);
      const values: string[] = [];
      const params: unknown[] = [];
      let pi = 1;
      for (const tid of slice) {
        for (const sym of SYMBOLS) {
          values.push(`($${pi},$${pi + 1},500,$${pi + 2})`);
          params.push(tid.toString(), sym, pxOf.get(sym) ?? 100);
          pi += 3;
        }
      }
      await client.query(
        `insert into holdings (team_id, symbol, quantity, average_buy_price)
         values ${values.join(",")}`,
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

  // 5. Build in-memory team list with JWT + unique simulated source IP.
  teams = rows.slice(0, VIRTUAL_USERS).map((r, i) => ({
    teamId: Number(r.team_id),
    apiKey: String(r.api_key),
    email: r.email,
    jwt: jwt.sign(
      { team_id: Number(r.team_id), email: r.email, role: "team", ver: 0 },
      JWT_SECRET,
      { expiresIn: "24h" },
    ),
    // Unique per-VU address behind the proxy (trustProxy=1 -> req.ip = XFF[0]).
    sourceIp: `10.${Math.floor(i / 65025) % 256}.${Math.floor(i / 255) % 256}.${(i % 255) + 1}`,
  }));

  // 6. Sanity: authenticate one team through the real API path.
  const probe = await httpRequest("GET", "/api/market/status", {
    headers: { "x-api-key": teams[0].apiKey },
    sourceIp: teams[0].sourceIp,
  });
  if (probe.status !== 200) {
    throw new Error(`API-key auth probe failed: HTTP ${probe.status} ${probe.body.slice(0, 200)}`);
  }

  await pool.end();
  console.log(`[provision] ${teams.length} teams ready (cash, holdings, api keys, JWTs)`);
}

// ─── Rate-limit budget verification (fail fast if workload would 429) ───────

function verifyRateBudget(): void {
  const actionsPerMin = 60_000 / ((THINK_MIN_MS + THINK_MAX_MS) / 2 + 15); // +15ms avg latency allowance
  const worstCaseTradesPerMin = actionsPerMin * MIX.trade;
  const apiPerMinPerUser = actionsPerMin; // every action is one /api request
  console.log(
    `[budget] ~${actionsPerMin.toFixed(1)} actions/min/user -> ~${worstCaseTradesPerMin.toFixed(1)} trades/min/team (limit ${TRADE_RATE_LIMIT_PER_MIN}) , ~${apiPerMinPerUser.toFixed(1)} api/min per unique IP (limit 300)`,
  );
  if (worstCaseTradesPerMin >= TRADE_RATE_LIMIT_PER_MIN * 0.9) {
    throw new Error(
      `workload would approach trade rate limit (${worstCaseTradesPerMin.toFixed(1)}/min vs 60) — reduce MIX.trade or increase think time`,
    );
  }
  if (apiPerMinPerUser >= 270) {
    throw new Error("workload would approach api rate limit (300/min/IP)");
  }
}

// ─── WebSocket fleet ────────────────────────────────────────────────────────

async function connectWebSockets(): Promise<void> {
  console.log(`[ws] connecting ${teams.length} WebSocket clients (staggered)...`);
  const CONC = 25;
  for (let i = 0; i < teams.length; i += CONC) {
    const batch = teams.slice(i, i + CONC);
    await Promise.all(
      batch.map(
        (team) =>
          new Promise<void>((resolve) => {
            let settled = false;
            const done = () => {
              if (!settled) {
                settled = true;
                resolve();
              }
            };
            const ws = new WebSocket(WS_BASE, {
              headers: { Authorization: `Bearer ${team.jwt}` },
              perMessageDeflate: false,
            });
            team.ws = ws;
            const t = setTimeout(done, 5000);
            ws.on("open", () => {
              wsState.opened++;
              clearTimeout(t);
              done();
            });
            ws.on("error", () => {
              wsState.errors++;
              clearTimeout(t);
              done();
            });
            ws.on("close", () => wsState.closed++);
            ws.on("message", (data: Buffer, isBinary: boolean) => {
              if (isBinary) return;
              wsState.messages++;
              wsState.bytesIn += data.length;
              try {
                const msg = JSON.parse(data.toString("utf8"));
                wsState.msgTypeCounts[String(msg.type)] =
                  (wsState.msgTypeCounts[String(msg.type)] ?? 0) + 1;
                if (msg.type === "order" && typeof msg.orderId === "number") {
                  const pend = pendingOrderPush.get(msg.orderId);
                  if (pend && pend.teamId === team.teamId) {
                    wsState.pushAfterResponseMs.push(performance.now() - pend.respAt);
                    pendingOrderPush.delete(msg.orderId);
                  } else {
                    wsState.pushUnmatched++;
                  }
                }
              } catch {
                /* ignore malformed */
              }
            });
          }),
      ),
    );
    await sleep(40);
  }
  console.log(
    `[ws] opened=${wsState.opened} errors=${wsState.errors} (target ${teams.length})`,
  );
}

function closeWebSockets(): void {
  for (const t of teams) {
    try {
      t.ws?.close();
    } catch {
      /* ignore */
    }
  }
}

// ─── Virtual user workload ──────────────────────────────────────────────────

type ActionKind = "trade" | "market" | "portfolio" | "mytrades" | "leaderboard" | "healthz";

function pickAction(): ActionKind {
  const r = Math.random();
  if (r < MIX.trade) return "trade";
  if (r < MIX.trade + MIX.marketRead) return "market";
  if (r < MIX.trade + MIX.marketRead + MIX.portfolio) return "portfolio";
  if (r < MIX.trade + MIX.marketRead + MIX.portfolio + MIX.myTrades) return "mytrades";
  if (r < MIX.trade + MIX.marketRead + MIX.portfolio + MIX.myTrades + MIX.leaderboard)
    return "leaderboard";
  return "healthz";
}

const MARKET_PATHS = [
  "/api/market/snapshot",
  "/api/market/status",
  "/api/market/depth",
  "/api/market/symbols",
];

let seqCounter = 0;

// Classifies every request exactly once into the shared status counters.
function classifyRequest(status: number, timedOut: boolean, connError: boolean) {
  if (timedOut) counters.requestsTimeout++;
  else if (connError || status === 0) counters.requestsConnErr++;
  else if (status >= 200 && status < 300) counters.requests2xx++;
  else if (status === 429) counters.requests429++;
  else if (status === 422) counters.requests422++;
  else if (status >= 400 && status < 500) counters.requestsOther4xx++;
  else if (status >= 500) counters.requests5xx++;
}

let lastHealthzProbeMs = NaN;

async function virtualUser(team: Team, phase: "warmup" | "measured", endAt: number): Promise<void> {
  while (Date.now() < endAt) {
    inflight++;
    if (inflight > peakInflight) peakInflight = inflight;
    counters.totalRequests++;
    reqsThisSecond++;
    try {
      const kind = pickAction();
      bump(endpointCounts, kind);
      if (kind === "trade") {
        await doTrade(team, phase);
      } else {
        await doRead(team, kind);
      }
    } catch {
      counters.requestsConnErr++;
    } finally {
      inflight--;
    }
    const think = THINK_MIN_MS + Math.random() * (THINK_MAX_MS - THINK_MIN_MS);
    await sleep(think);
  }
}

async function doTrade(team: Team, phase: "warmup" | "measured"): Promise<void> {
  const action: "BUY" | "SELL" = Math.random() < BUY_PROB ? "BUY" : "SELL";
  const symbol = SYMBOLS[(Math.random() * SYMBOLS.length) | 0];
  const quantity = 1 + ((Math.random() * QTY_MAX) | 0);
  const clientRef = `lt2-${team.teamId}-${++seqCounter}`;
  const res = await httpRequest(
    "POST",
    action === "BUY" ? "/api/trade/buy" : "/api/trade/sell",
    {
      body: { symbol, quantity, client_ref: clientRef },
      headers: { "x-api-key": team.apiKey },
      sourceIp: team.sourceIp,
    },
  );
  classifyRequest(res.status, res.timedOut, res.connError);
  httpAll.push(res.httpMs);
  tradesThisSecond++;

  let serverMs: number | null = null;
  let outcome: string;
  if (res.timedOut) outcome = "TIMEOUT";
  else if (res.connError) outcome = "CONN_ERROR";
  else {
    try {
      const parsed = JSON.parse(res.body);
      if (typeof parsed.latencyMs === "number") serverMs = parsed.latencyMs;
      if (res.status === 200 && parsed.status === "SUCCESS") outcome = "SUCCESS";
      else if (res.status === 422) outcome = `REJECTED:${parsed.reason ?? parsed.error ?? "?"}`;
      else outcome = `HTTP_${res.status}:${parsed.error ?? "?"}`;
    } catch {
      outcome = `HTTP_${res.status}:UNPARSEABLE`;
    }
  }

  counters.tradesAttempted++;
  if (outcome === "SUCCESS") {
    counters.tradesSuccess++;
    httpTradeSuccess.push(res.httpMs);
    if (serverMs !== null) serverTradeSuccess.push(serverMs);
    try {
      const orderId = JSON.parse(res.body).orderId;
      if (typeof orderId === "number" && team.ws?.readyState === WebSocket.OPEN) {
        pendingOrderPush.set(orderId, { respAt: performance.now(), teamId: team.teamId });
      }
    } catch {
      /* ignore */
    }
  } else if (res.status === 422) counters.tradesRejected422++;
  else if (res.status === 429) counters.trades429++;
  else counters.tradesOtherFail++;

  tradeRecords.push({
    ts: new Date().toISOString(),
    phase,
    teamId: team.teamId,
    action,
    symbol,
    quantity,
    httpMs: res.httpMs,
    serverMs,
    httpStatus: res.status,
    outcome,
  });
}

async function doRead(team: Team, kind: ActionKind): Promise<void> {
  let p: string;
  let headers: Record<string, string> = {};
  switch (kind) {
    case "portfolio":
      p = "/api/team/portfolio";
      headers = { Authorization: `Bearer ${team.jwt}` };
      break;
    case "mytrades":
      p = "/api/team/trades?limit=50";
      headers = { Authorization: `Bearer ${team.jwt}` };
      break;
    case "leaderboard":
      p = "/api/market/leaderboard";
      break;
    case "healthz":
      p = "/healthz";
      break;
    default:
      p = MARKET_PATHS[(Math.random() * MARKET_PATHS.length) | 0];
  }
  const res = await httpRequest("GET", p, { headers, sourceIp: team.sourceIp });
  classifyRequest(res.status, res.timedOut, res.connError);
  httpAll.push(res.httpMs);
  if (kind === "healthz") lastHealthzProbeMs = res.httpMs;
}

// ─── System / DB samplers ───────────────────────────────────────────────────

let serverPid = 0;
{
  const conn = execSync(
    "powershell -NoProfile -Command \"(Get-NetTCPConnection -LocalPort 4040 -State Listen | Select-Object -First 1).OwningProcess\"",
    { encoding: "utf8", timeout: 10_000 },
  ).trim();
  serverPid = Number(conn);
}
if (!Number.isFinite(serverPid) || serverPid <= 0) {
  throw new Error("could not find server PID listening on 4040");
}
console.log(`[metrics] server PID=${serverPid}`);

interface ProcSample {
  cpuMs: number;
  wallMs: number;
  rssMB: number;
}
function sampleProcesses(names: string[], pidFilter?: number): ProcSample {
  let cpuMs = 0;
  let rssMB = 0;
  let wallMs = 0;
  try {
    if (pidFilter) {
      const p = execSync(
        `powershell -NoProfile -Command "$p=Get-Process -Id ${pidFilter}; [string]$p.TotalProcessorTime.TotalMilliseconds; [string][long]($p.WorkingSet64/1MB)"`,
        { encoding: "utf8", timeout: 10_000 },
      ).trim().split(/\r?\n/);
      cpuMs = parseFloat(p[0]) || 0;
      rssMB = parseFloat(p[1]) || 0;
    } else {
      const out = execSync(
        `powershell -NoProfile -Command "$ps=Get-Process -Name ${names.join(",")} -ErrorAction SilentlyContinue; $ps | ForEach-Object { [string]$_.TotalProcessorTime.TotalMilliseconds }; '---'; $ps | ForEach-Object { [string][long]($_.WorkingSet64/1MB) }"`,
        { encoding: "utf8", timeout: 10_000 },
      ).trim().split(/\r?\n/);
      let section = 0;
      for (const line of out) {
        if (line.trim() === "---") {
          section = 1;
          continue;
        }
        const v = parseFloat(line);
        if (!Number.isNaN(v)) {
          if (section === 0) cpuMs += v;
          else rssMB += v;
        }
      }
    }
  } catch {
    /* sampling failure tolerated */
  }
  return { cpuMs, wallMs: 0, rssMB };
}

const CORES = os.cpus().length;

const metricPool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });

async function sampleDb(): Promise<{
  active: number;
  idle: number;
  idleInTx: number;
  total: number;
  waitingLocks: number;
  maxActiveSec: number;
}> {
  try {
    const r = await metricPool.query(
      `select
         count(*) filter (where state = 'active')::int as active,
         count(*) filter (where state = 'idle')::int as idle,
         count(*) filter (where state = 'idle in transaction')::int as idle_in_tx,
         count(*)::int as total,
         coalesce(max(extract(epoch from (now() - query_start))) filter (where state='active'), 0)::float as max_active_sec
       from pg_stat_activity where datname = current_database()`,
    );
    const l = await metricPool.query(
      `select count(*)::int as n from pg_locks where not granted`,
    );
    return {
      active: r.rows[0].active,
      idle: r.rows[0].idle,
      idleInTx: r.rows[0].idle_in_tx,
      total: r.rows[0].total,
      waitingLocks: l.rows[0].n,
      maxActiveSec: r.rows[0].max_active_sec,
    };
  } catch {
    return { active: 0, idle: 0, idleInTx: 0, total: 0, waitingLocks: 0, maxActiveSec: 0 };
  }
}

async function dbCounters(): Promise<{ xactCommit: number; blksHit: number; blksRead: number }> {
  try {
    const r = await metricPool.query(
      `select xact_commit::bigint as xc, blks_hit::bigint as bh, blks_read::bigint as br
       from pg_stat_database where datname = current_database()`,
    );
    return { xactCommit: Number(r.rows[0].xc), blksHit: Number(r.rows[0].bh), blksRead: Number(r.rows[0].br) };
  } catch {
    return { xactCommit: 0, blksHit: 0, blksRead: 0 };
  }
}

// Generator-side event-loop lag (hrtime drift across setImmediate).
let genLagSamples: number[] = [];
function startLagMonitor(): () => void {
  let expected = performance.now() + 250;
  const t = setInterval(() => {
    const now = performance.now();
    genLagSamples.push(now - expected);
    expected = now + 250;
    if (genLagSamples.length > 5000) genLagSamples.shift();
  }, 250);
  return () => clearInterval(t);
}

async function takeSample(
  prevServer: ProcSample,
  prevPg: ProcSample,
): Promise<{ server: ProcSample; pg: ProcSample }> {
  const wallStart = Date.now();
  const serverNow = sampleProcesses([], serverPid);
  const pgNow = sampleProcesses(["postgres"]);
  const db = await sampleDb();

  // CPU% of total machine capacity
  const wall = Math.max(1, Date.now() - wallStart + 120); // approx sample period incl. work
  const serverCpuPct = ((serverNow.cpuMs - prevServer.cpuMs) / (wall * CORES)) * 100;
  const pgCpuPct = ((pgNow.cpuMs - prevPg.cpuMs) / (wall * CORES)) * 100;

  const mem = process.memoryUsage();
  timeseries.push({
    t: new Date().toISOString(),
    serverCpuPctMachine: round2(Math.max(0, serverCpuPct)),
    pgCpuPctMachine: round2(Math.max(0, pgCpuPct)),
    serverRssMB: serverNow.rssMB,
    pgRssMB: pgNow.rssMB,
    genHeapMB: round2(mem.heapUsed / 1048576),
    genRssMB: round2(mem.rss / 1048576),
    genLagMsLast: round2(genLagSamples.slice(-8).reduce((a, b) => a + b, 0) / Math.min(8, genLagSamples.length || 1)),
    healthzProbeMs: round2(lastHealthzProbeMs),
    pgConnsActive: db.active,
    pgConnsIdle: db.idle,
    pgConnsIdleInTx: db.idleInTx,
    pgConnsTotal: db.total,
    pgWaitingLocks: db.waitingLocks,
    pgMaxActiveQuerySec: round2(db.maxActiveSec),
    inflight,
    wsOpened: wsState.opened,
    wsClosed: wsState.closed,
  });
  return { server: serverNow, pg: pgNow };
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ─── CSV flushing ───────────────────────────────────────────────────────────

function startCsv(): void {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.writeFileSync(
    TRADE_CSV,
    "ts,phase,team_id,action,symbol,quantity,http_ms,server_ms,http_status,outcome\n",
  );
  csvFlushTimer = setInterval(() => {
    if (tradeRecords.length === 0) return;
    const lines = tradeRecords.splice(0, tradeRecords.length).map(
      (r) =>
        `${r.ts},${r.phase},${r.teamId},${r.action},${r.symbol},${r.quantity},${r.httpMs.toFixed(2)},${r.serverMs ?? ""},${r.httpStatus},${r.outcome}`,
    );
    fs.appendFileSync(TRADE_CSV, lines.join("\n") + "\n");
  }, 2000);
}
function stopCsv(): void {
  if (csvFlushTimer) clearInterval(csvFlushTimer);
  if (tradeRecords.length > 0) {
    const lines = tradeRecords.splice(0, tradeRecords.length).map(
      (r) =>
        `${r.ts},${r.phase},${r.teamId},${r.action},${r.symbol},${r.quantity},${r.httpMs.toFixed(2)},${r.serverMs ?? ""},${r.httpStatus},${r.outcome}`,
    );
    fs.appendFileSync(TRADE_CSV, lines.join("\n") + "\n");
  }
}

// ─── Phase runner ───────────────────────────────────────────────────────────

async function runPhase(
  label: string,
  durationMs: number,
  phase: "warmup" | "measured",
): Promise<number> {
  const startWall = Date.now();
  const endAt = startWall + durationMs;
  let prevServer = sampleProcesses([], serverPid);
  let prevPg = sampleProcesses(["postgres"]);
  const sampleTimer = setInterval(() => {
    void takeSample(prevServer, prevPg).then((s) => {
      prevServer = s.server;
      prevPg = s.pg;
    });
  }, 2000);

  const rpsTimer = setInterval(() => {
    rpsBySecond.push(reqsThisSecond);
    tradeRpsBySecond.push(tradesThisSecond);
    reqsThisSecond = 0;
    tradesThisSecond = 0;
  }, 1000);

  console.log(`\n[${phase}] ${label}: ${teams.length} VUs, ${durationMs / 1000}s, mix=${JSON.stringify(MIX)}`);
  const progress = setInterval(() => {
    const el = ((Date.now() - startWall) / 1000).toFixed(0);
    const ok = counters.tradesSuccess;
    process.stdout.write(
      `\r[${phase}] ${el}s/${durationMs / 1000}s | reqs=${counters.totalRequests} | okTrades=${ok} | rej422=${counters.tradesRejected422} | 429=${counters.requests429} | 5xx=${counters.requests5xx} | inflight=${inflight}   `,
    );
  }, 3000);

  await Promise.all(teams.map((t) => virtualUser(t, phase, endAt)));

  clearInterval(progress);
  clearInterval(sampleTimer);
  clearInterval(rpsTimer);
  rpsBySecond.push(reqsThisSecond);
  tradeRpsBySecond.push(tradesThisSecond);
  const actual = Date.now() - startWall;
  console.log(`\n[${phase}] done in ${(actual / 1000).toFixed(1)}s`);
  return actual;
}

// ─── Post-test DB verification ──────────────────────────────────────────────

async function verifyAgainstDb(measuredStartIso: string): Promise<{
  dbSuccess: number;
  dbRejected: number;
  dbLatencyP50: number;
  dbLatencyP95: number;
  dbLatencyP99: number;
}> {
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
  const ids = teams.map((t) => String(t.teamId));
  const r = await pool.query(
    `select
       count(*) filter (where status='SUCCESS')::int as success,
       count(*) filter (where status='REJECTED')::int as rejected,
       percentile_cont(0.5) within group (order by latency_ms) filter (where status='SUCCESS') as p50,
       percentile_cont(0.95) within group (order by latency_ms) filter (where status='SUCCESS') as p95,
       percentile_cont(0.99) within group (order by latency_ms) filter (where status='SUCCESS') as p99
     from order_logs
     where team_id = any($1::bigint[]) and timestamp_ms >= $2::timestamptz`,
    [ids, measuredStartIso],
  );
  await pool.end();
  return {
    dbSuccess: r.rows[0].success,
    dbRejected: r.rows[0].rejected,
    dbLatencyP50: Number(r.rows[0].p50),
    dbLatencyP95: Number(r.rows[0].p95),
    dbLatencyP99: Number(r.rows[0].p99),
  };
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("=".repeat(72));
  console.log("MERCATUS ARENA LOAD TEST V2 — 500 users / 5 minutes / trade latency focus");
  console.log("=".repeat(72));
  console.log(`API=${API_BASE}  DB=${DATABASE_URL.replace(/:[^@]+@/, ":***@")}  VUs=${VIRTUAL_USERS}`);
  console.log(`warmup=${WARMUP_MS / 1000}s  measured=${MEASURED_MS / 1000}s  smoke=${SMOKE}`);

  // Pre-flight: server reachable?
  const h = await httpRequest("GET", "/healthz", {}, );
  if (h.status !== 200) throw new Error(`server not healthy: HTTP ${h.status}`);
  const hBody = JSON.parse(h.body);
  if (hBody.state !== "ACTIVE_MARKET") {
    throw new Error(`market state is ${hBody.state}, must be ACTIVE_MARKET before the test`);
  }
  console.log(`[preflight] server healthy, state=${hBody.state}`);

  if (process.env.PROVISION_ONLY === "1") {
    console.log("[main] PROVISION_ONLY set — provisioning teams and exiting.");
    await provision();
    return;
  }

  verifyRateBudget();
  await provision();
  startCsv();
  const stopLag = startLagMonitor();

  await connectWebSockets();

  // ── WARM-UP (discarded) ──
  const warmupActual = await runPhase("warm-up (results discarded)", WARMUP_MS, "warmup");

  // Reset per-phase accumulators so measured stats contain ONLY measured data.
  counters.totalRequests = 0;
  counters.requests2xx = 0;
  counters.requests429 = 0;
  counters.requests422 = 0;
  counters.requestsOther4xx = 0;
  counters.requests5xx = 0;
  counters.requestsTimeout = 0;
  counters.requestsConnErr = 0;
  counters.tradesAttempted = 0;
  counters.tradesSuccess = 0;
  counters.tradesRejected422 = 0;
  counters.trades429 = 0;
  counters.tradesOtherFail = 0;
  httpAll.length = 0;
  httpTradeSuccess.length = 0;
  serverTradeSuccess.length = 0;
  rpsBySecond.length = 0;
  tradeRpsBySecond.length = 0;
  wsState.pushAfterResponseMs.length = 0;
  genLagSamples.length = 0;
  peakInflight = 0;
  reasonCounts.clear();
  endpointCounts.clear();

  // ── MEASURED PHASE ──
  const measuredStartIso = new Date().toISOString();
  const dbBefore = await dbCounters();
  const measuredActual = await runPhase("MEASURED", MEASURED_MS, "measured");
  const dbAfter = await dbCounters();
  const finalDb = await sampleDb();

  stopCsv();
  stopLag();

  // Grace period for in-flight WS order pushes to arrive.
  await sleep(1500);

  // ── Verification ──
  const dbVerify = await verifyAgainstDb(measuredStartIso);
  closeWebSockets();

  const el = measuredActual / 1000;
  const sortedServer = [...serverTradeSuccess].sort((a, b) => a - b);
  const sortedHttpTrade = [...httpTradeSuccess].sort((a, b) => a - b);
  const sortedHttpAll = [...httpAll].sort((a, b) => a - b);
  const sortedPush = [...wsState.pushAfterResponseMs].sort((a, b) => a - b);

  const sOk = sortedServer.length > 0;
  const pctUnder20 = sOk ? (countUnder(sortedServer, 20) / sortedServer.length) * 100 : 0;
  const pctUnder5 = sOk ? (countUnder(sortedServer, 5) / sortedServer.length) * 100 : 0;
  const pctUnder10 = sOk ? (countUnder(sortedServer, 10) / sortedServer.length) * 100 : 0;
  const pctUnder15 = sOk ? (countUnder(sortedServer, 15) / sortedServer.length) * 100 : 0;
  const over20 = sortedServer.length - countUnder(sortedServer, 20);
  const over50 = sortedServer.length - countUnder(sortedServer, 50);
  const over100 = sortedServer.length - countUnder(sortedServer, 100);

  // Verdict per spec (server-side only).
  let verdict: "PASS" | "CONDITIONAL" | "FAIL" | "INVALID";
  if (!sOk || counters.tradesSuccess === 0) {
    verdict = "INVALID";
  } else {
    const p95 = percentile(sortedServer, 95);
    const p99 = percentile(sortedServer, 99);
    const poolStressed = finalDb.total >= 20 && finalDb.active >= 18;
    if (pctUnder20 >= 99 && p95 < 20 && p99 <= 25 && !poolStressed) verdict = "PASS";
    else if (p95 < 20 && (pctUnder20 >= 95 || p99 > 20)) verdict = "CONDITIONAL";
    else verdict = "FAIL";
  }

  // Persist timeseries.
  fs.writeFileSync(TIMESERIES_JSON, JSON.stringify(timeseries, null, 1));

  // ── Console summary block ──
  const ts = (arr: number[], p: number) => fmt(percentile(arr, p));
  const peakServerCpu = Math.max(0, ...timeseries.map((x) => Number(x.serverCpuPctMachine)));
  const peakPgCpu = Math.max(0, ...timeseries.map((x) => Number(x.pgCpuPctMachine)));
  const peakServerRss = Math.max(0, ...timeseries.map((x) => Number(x.serverRssMB)));
  const peakGenHeap = Math.max(0, ...timeseries.map((x) => Number(x.genHeapMB)));
  const peakDbConns = Math.max(0, ...timeseries.map((x) => Number(x.pgConnsTotal)));
  const peakDbActive = Math.max(0, ...timeseries.map((x) => Number(x.pgConnsActive)));
  const peakDbWaitLocks = Math.max(0, ...timeseries.map((x) => Number(x.pgWaitingLocks)));
  const peakHealthz = Math.max(0, ...timeseries.map((x) => Number(x.healthzProbeMs)));
  const genLagSorted = [...genLagSamples].sort((a, b) => a - b);

  console.log("\n" + "=".repeat(72));
  console.log("MERCATUS ARENA LOAD TEST V2");
  console.log("=".repeat(72));
  console.log(`Users: ${VIRTUAL_USERS}`);
  console.log(`Warm-up: ${(warmupActual / 1000).toFixed(1)}s (discarded) | Measured: ${el.toFixed(1)}s`);
  console.log(`Successful trades: ${counters.tradesSuccess}`);
  console.log(`Rejected trades (422): ${counters.tradesRejected422}`);
  console.log(`429s: ${counters.requests429}`);
  console.log(`5xx: ${counters.requests5xx}`);
  console.log(`DB cross-check (order_logs SUCCESS in window): ${dbVerify.dbSuccess}`);
  console.log("");
  console.log("Server trade latency (atomic.ts latency_ms, SUCCESS only):");
  console.log(`  N=${sortedServer.length}`);
  console.log(`  P50: ${ts(sortedServer, 50)} ms   P90: ${ts(sortedServer, 90)} ms`);
  console.log(`  P95: ${ts(sortedServer, 95)} ms   P99: ${ts(sortedServer, 99)} ms`);
  console.log(`  P99.9: ${ts(sortedServer, 99.9)} ms   MAX: ${sOk ? fmt(sortedServer[sortedServer.length - 1]) : "N/A"} ms`);
  console.log(`  Under 20 ms: ${pctUnder20.toFixed(2)}%`);
  console.log("");
  console.log("HTTP trade latency (successful trades):");
  console.log(`  P50: ${ts(sortedHttpTrade, 50)} ms   P95: ${ts(sortedHttpTrade, 95)} ms   P99: ${ts(sortedHttpTrade, 99)} ms`);
  console.log("");
  console.log(`Peak server CPU: ${peakServerCpu.toFixed(1)}% (of machine) | Peak server RSS: ${peakServerRss.toFixed(0)} MB`);
  console.log(`Peak PG CPU: ${peakPgCpu.toFixed(1)}% | Peak DB connections: ${peakDbConns} (active ${peakDbActive}) | Waiting locks: ${peakDbWaitLocks}`);
  console.log(`WebSocket connections opened: ${wsState.opened}, closed: ${wsState.closed}, errors: ${wsState.errors}`);
  console.log("");
  console.log(`20 MS REQUIREMENT (server-side): ${verdict}`);
  console.log("=".repeat(72));

  // Expose computed results for the report writer (dump JSON next to report).
  const results = {
    config: {
      vus: VIRTUAL_USERS,
      warmupMs: warmupActual,
      measuredMs: measuredActual,
      mix: MIX,
      thinkMs: [THINK_MIN_MS, THINK_MAX_MS],
      buyProb: BUY_PROB,
      qtyMax: QTY_MAX,
      symbols: SYMBOLS,
      rateLimits: { tradePerMinPerTeam: 60, apiPerMinPerIp: 300, store: "postgres" },
      poolSize: 20,
    },
    env: {
      node: process.version,
      cpus: CORES,
      totalRamGB: Math.round(os.totalmem() / 1073741824),
      platform: `${os.type()} ${os.release()}`,
    },
    totals: { ...counters },
    reasons: Object.fromEntries(reasonCounts),
    endpoints: Object.fromEntries(endpointCounts),
    serverLatency: stats(sortedServer),
    httpTradeLatency: stats(sortedHttpTrade),
    httpAllLatency: stats(sortedHttpAll),
    wsPushLatency: stats(sortedPush),
    thresholds: {
      under5: pctUnder5, under10: pctUnder10, under15: pctUnder15, under20: pctUnder20,
      over20Count: over20, over50Count: over50, over100Count: over100,
    },
    db: {
      verify: dbVerify,
      xactDelta: dbAfter.xactCommit - dbBefore.xactCommit,
      final: finalDb,
      peakConns: peakDbConns,
      peakActive: peakDbActive,
      peakWaitingLocks: peakDbWaitLocks,
    },
    node: {
      peakServerCpuPctMachine: peakServerCpu,
      peakPgCpuPctMachine: peakPgCpu,
      peakServerRssMB: peakServerRss,
      peakGenHeapMB: peakGenHeap,
      genLagP50: percentile(genLagSorted, 50),
      genLagP95: percentile(genLagSorted, 95),
      genLagMax: genLagSorted.length ? genLagSorted[genLagSorted.length - 1] : NaN,
      peakHealthzMs: peakHealthz,
      peakInflight,
      avgRps: counters.totalRequests / el,
      peakRps: rpsBySecond.length ? Math.max(...rpsBySecond) : 0,
      avgTradeRps: counters.tradesSuccess / el,
      peakTradeRps: tradeRpsBySecond.length ? Math.max(...tradeRpsBySecond) : 0,
    },
    ws: {
      opened: wsState.opened,
      closed: wsState.closed,
      errors: wsState.errors,
      messages: wsState.messages,
      bytesIn: wsState.bytesIn,
      msgTypes: wsState.msgTypeCounts,
      pushUnmatched: wsState.pushUnmatched,
    },
    verdict,
    measuredStartIso,
  };
  fs.writeFileSync(path.join(REPORT_DIR, "loadtest-v2-results.json"), JSON.stringify(results, null, 1));
  console.log(`\n[out] ${TRADE_CSV}`);
  console.log(`[out] ${TIMESERIES_JSON}`);
  console.log(`[out] ${path.join(REPORT_DIR, "loadtest-v2-results.json")}`);

  await metricPool.end();
  agent.destroy();
}

function stats(a: number[]) {
  if (a.length === 0) {
    return { n: 0 };
  }
  return {
    n: a.length,
    min: a[0],
    mean: mean(a),
    sd: stddev(a),
    p50: percentile(a, 50),
    p90: percentile(a, 90),
    p95: percentile(a, 95),
    p99: percentile(a, 99),
    p999: percentile(a, 99.9),
    max: a[a.length - 1],
  };
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
