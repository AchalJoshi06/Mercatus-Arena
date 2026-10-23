/**
 * TEMPORARY PROFILING SERVER ENTRY (isolated from production behavior).
 *
 * Boots the REAL Mercatus app (createApp from src/index.ts) with passive
 * instrumentation injected at the driver level:
 *   - every PostgreSQL query is timed, classified into a named stage,
 *     and counted (rows, errors)
 *   - transactions (BEGIN..COMMIT) are tracked end-to-end per client,
 *     including "gap" time (time inside the tx not spent in queries =
 *     scheduling/event-loop/lock-wait residue)
 *   - pool acquisition time (pool.connect) is recorded
 *   - pool gauges (total/idle/waiting) + event-loop delay histogram +
 *     process CPU are snapshotted every second to a JSONL file
 *   - WebSocket send fan-out time is accumulated
 *
 * NO production file is modified. Run instead of dist/index.js:
 *   LABEL=run1 npx tsx scripts/profile-server.ts
 * Env knobs: PORT, LABEL, NO_WS=1, NODE_ENV (=test disables limiters),
 *            RATE_LIMIT_TRADE / RATE_LIMIT_API (test-only overrides),
 *            TICK_INTERVAL_MS, DATABASE_URL, JWT_SECRET.
 */

import pg from "pg";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";

const LABEL = process.env.LABEL ?? "run";
const PORT = Number(process.env.PORT ?? 4040);
const SNAPSHOT_MS = Number(process.env.PROFILE_SNAPSHOT_MS ?? 1000);
const OUT_DIR = path.resolve("..", "reports", "profiling");
fs.mkdirSync(OUT_DIR, { recursive: true });
const JSONL_PATH = path.join(OUT_DIR, `server-profile-${LABEL}.jsonl`);
const SUMMARY_PATH = path.join(OUT_DIR, `server-profile-${LABEL}-summary.json`);

// ─── Instrumentation state ──────────────────────────────────────────────────

interface StageStat {
  n: number;
  errors: number;
  rows: number;
  totalMs: number;
  samples: number[];
}
const stages = new Map<string, StageStat>();
function stageStat(name: string): StageStat {
  let s = stages.get(name);
  if (!s) {
    s = { n: 0, errors: 0, rows: 0, totalMs: 0, samples: [] };
    stages.set(name, s);
  }
  return s;
}

interface TxRecord {
  durationMs: number;
  queryMs: number;
  gapMs: number;
  nQueries: number;
  stages: string[];
}
const txRecords: TxRecord[] = [];

const acqSamples: number[] = []; // pool.connect acquisition time
let acqWaitingPeak = 0;

const wsSend = { calls: 0, totalMs: 0, bytes: 0 };

// Per-client transaction tracking
interface ClientTxState {
  startAt: number;
  queryMs: number;
  nQueries: number;
  stages: string[];
}
const clientTx = new WeakMap<object, ClientTxState>();
let openTxns = 0;
let openTxnsPeak = 0;

// ─── Stage classification ───────────────────────────────────────────────────

export function classifyQuery(raw: string): string {
  const q = raw.toLowerCase().replace(/\s+/g, " ").trim();
  if (q === "begin") return "tx_begin";
  if (q === "commit") return "tx_commit";
  if (q.startsWith("rollback")) return "tx_rollback";
  if (q.includes("insert into rate_limits")) return "rate_limit_upsert";
  if (q.includes("delete from rate_limits")) return "rate_limit_cleanup";
  if (q.includes("from teams where api_key")) return "auth_api_key_lookup";
  if (q.includes("select team_id, is_frozen, token_version from teams")) return "portal_or_ws_auth";
  if (q.includes("insert into request_logs")) return "telemetry_insert";
  if (q.includes("for update") && q.includes("from teams")) return "q01_team_for_update";
  if (q.includes("from event_config where id = true") && q.includes("state")) return "q02_event_config";
  if (q.includes("select price from live_prices where symbol")) return "q03_live_price";
  if (q.includes("count(*)::int as n from order_logs")) return "q04_fee_count";
  if (q.includes("update teams set cash_balance = cash_balance -")) return "q05_cash_debit";
  if (q.includes("update teams set cash_balance = cash_balance +")) return "q05b_cash_credit";
  if (q.includes("insert into holdings")) return "q06_holdings_upsert";
  if (q.includes("update holdings set quantity")) return "q06b_holdings_update";
  if (q.includes("update teams set total_portfolio_value")) return "q07_portfolio_value_update";
  if (q.includes("insert into order_logs")) return "q08_order_log_insert";
  if (q.includes("select cash_balance from teams where team_id")) return "q09_cash_after";
  if (q.includes("from dataset_ticks")) return "engine_dataset_read";
  if (q.includes("insert into live_prices")) return "engine_live_prices_upsert";
  if (q.includes("update market_state")) return "engine_market_state";
  if (q.includes("update event_config set tick_count")) return "engine_tick_count";
  if (q.includes("leaderboard_snapshot") || (q.includes("rank() over") && q.includes("from teams"))) return "read_leaderboard";
  if (q.includes("from order_logs") && q.includes("order by order_id desc")) return "read_team_trades";
  if (q.includes("from holdings h") && q.includes("average_buy_price")) return "read_portfolio_positions";
  if (q.includes("from holdings h")) return "read_portfolio_other";
  if (q.includes("select symbol, price, prev_price")) return "read_market_snapshot";
  if (q.includes("select symbol, price from live_prices")) return "read_live_prices_all";
  if (q.includes("from teams where email") || q.includes("from teams where team_name")) return "auth_register_lookup";
  if (q.includes("insert into teams")) return "auth_register_insert";
  if (q.includes("update teams set cash_balance")) return "q05_cash_update_other";
  if (q.includes("from live_prices")) return "read_live_prices_generic";
  if (q.includes("from teams")) return "read_teams_generic";
  return "other";
}

// ─── Driver patches (installed before importing src/) ───────────────────────

const origClientQuery = pg.Client.prototype.query as (...a: unknown[]) => Promise<{ rowCount?: number | null }>;
(pg.Client.prototype as any).query = function patchedClientQuery(...args: any[]) {
  const first = args[0];
  const text: string = typeof first === "string" ? first : String(first?.text ?? "");
  const stage = classifyQuery(text);
  const t0 = performance.now();
  const isBegin = stage === "tx_begin";
  const isEnd = stage === "tx_commit" || stage === "tx_rollback";

  let txState: ClientTxState | undefined;
  if (isBegin) {
    txState = { startAt: t0, queryMs: 0, nQueries: 0, stages: [] };
    clientTx.set(this, txState);
    openTxns++;
    if (openTxns > openTxnsPeak) openTxnsPeak = openTxns;
  } else {
    txState = clientTx.get(this);
  }

  const p = origClientQuery.apply(this, args as any);
  Promise.resolve(p)
    .then((res: any) => {
      const dt = performance.now() - t0;
      const s = stageStat(stage);
      s.n++;
      s.rows += Number(res?.rowCount ?? 0);
      s.totalMs += dt;
      if (s.samples.length < 200_000) s.samples.push(dt);
      if (txState && !isBegin && !isEnd) {
        txState.queryMs += dt;
        txState.nQueries++;
        if (!stage.startsWith("tx_")) txState.stages.push(stage);
      }
      if (isEnd && txState) {
        openTxns--;
        const durationMs = t0 + dt - txState.startAt;
        txRecords.push({
          durationMs,
          queryMs: txState.queryMs,
          gapMs: Math.max(0, durationMs - txState.queryMs),
          nQueries: txState.nQueries,
          stages: txState.stages,
        });
        clientTx.delete(this);
      }
    })
    .catch(() => {
      const dt = performance.now() - t0;
      const s = stageStat(stage);
      s.n++;
      s.errors++;
      s.totalMs += dt;
      if (s.samples.length < 200_000) s.samples.push(dt);
      if (isEnd && txState) {
        openTxns--;
        clientTx.delete(this);
      }
    });
  return p;
};

const origPoolConnect = pg.Pool.prototype.connect as (...a: unknown[]) => Promise<unknown>;
(pg.Pool.prototype as any).connect = function patchedPoolConnect(...args: any[]) {
  const t0 = performance.now();
  const p = origPoolConnect.apply(this, args as any);
  Promise.resolve(p).then(() => {
    const dt = performance.now() - t0;
    acqSamples.push(dt);
    if (typeof (this as any).waitingCount === "number") {
      if ((this as any).waitingCount > acqWaitingPeak) acqWaitingPeak = (this as any).waitingCount;
    }
  });
  return p;
};

// WebSocket send fan-out accounting (patch after ws import below)

// ─── Boot the real app ──────────────────────────────────────────────────────

async function main() {
  // NOTE: we deliberately do NOT import src/index.js — importing it would
  // execute its module-level main() (which binds the port itself).
  // Instead we assemble the identical middleware chain from the same
  // production modules (routes/limiters/telemetry are imported unchanged).
  const express = (await import("express")).default;
  const cors = (await import("cors")).default;
  const helmet = (await import("helmet")).default;
  const { config } = await import("../src/config.js");
  const { engine } = await import("../src/engine.js");
  const { attachWebSocket } = await import("../src/ws.js");
  const { telemetryMiddleware } = await import("../src/telemetry.js");
  const { apiLimiter, authLimiter, tradeLimiter } = await import("../src/limiter.js");
  const { authRoutes } = await import("../src/routes/auth.routes.js");
  const { tradeRoutes } = await import("../src/routes/trade.routes.js");
  const { teamRoutes } = await import("../src/routes/team.routes.js");
  const { marketRoutes } = await import("../src/routes/market.routes.js");
  const { adminRoutes } = await import("../src/routes/admin.routes.js");
  const { evaluatorRoutes } = await import("../src/routes/evaluator.routes.js");
  const wsMod = await import("ws");

  const noopLimiter = (_req: unknown, _res: unknown, next: () => void) => next();
  const isTest = process.env.NODE_ENV === "test";
  const guard = isTest ? noopLimiter : apiLimiter;
  const authGuard = isTest ? noopLimiter : authLimiter;

  await engine.init();

  const app = express();
  app.set("trust proxy", config.trustProxy);
  app.disable("x-powered-by");
  app.use(helmet());
  app.use(
    cors({
      origin: (origin, cb) => {
        if (!origin || config.allowedOrigins.includes("*") || config.allowedOrigins.includes(origin))
          return cb(null, true);
        return cb(null, false);
      },
      credentials: false,
    }),
  );
  app.use(express.json({ limit: "2mb" }));

  app.get("/healthz", guard as any, (_req: any, res: any) => {
    res.json({ ok: true, state: engine.getStatus().state, ts: Date.now() });
  });
  app.use("/api", guard as any, telemetryMiddleware);
  app.use("/api/auth", authGuard as any);
  app.use("/api/auth", authRoutes);
  app.use("/api/trade", isTest ? (noopLimiter as any) : (tradeLimiter as any));
  app.use("/api/trade", tradeRoutes);
  app.use("/api/team", teamRoutes);
  app.use("/api/market", marketRoutes);
  app.use("/api/admin", adminRoutes);
  app.use("/api/evaluator", evaluatorRoutes);
  app.use("/api", (_req: any, res: any) => res.status(404).json({ error: "NOT_FOUND" }));
  app.use(
    (
      err: Error & { status?: number },
      _req: any,
      res: any,
      _next: any,
    ) => {
      if (config.isProduction) {
        return res.status(err.status ?? 500).json({ error: "INTERNAL" });
      }
      res.status(err.status ?? 500).json({ error: "INTERNAL", message: err.message });
    },
  );

  const server = http.createServer(app);
  if (process.env.NO_WS !== "1") {
    attachWebSocket(server);
  }

  // Patch ws send AFTER import
  const WSProto: any = wsMod.WebSocket.prototype;
  if (!WSProto.__mercatus_patched) {
    const origSend = WSProto.send;
    WSProto.send = function (...args: any[]) {
      const t0 = performance.now();
      const r = origSend.apply(this, args);
      const dt = performance.now() - t0;
      wsSend.calls++;
      wsSend.totalMs += dt;
      try {
        wsSend.bytes += typeof args[0] === "string" ? Buffer.byteLength(args[0]) : args[0]?.length ?? 0;
      } catch {}
      return r;
    };
    WSProto.__mercatus_patched = true;
  }

  // Event-loop delay histogram
  const elDelay = monitorEventLoopDelay({ resolution: 20 });
  elDelay.enable();

  // Periodic snapshot
  const pool = (await import("../src/db.js")).pool;
  const startCpu = process.cpuUsage();
  const startWall = performance.now();
  const jsonl = fs.createWriteStream(JSONL_PATH, { flags: "w" });

  const timer = setInterval(() => {
    const cpu = process.cpuUsage(startCpu);
    const wall = performance.now() - startWall;
    const cpuPctMachine = ((cpu.user + cpu.system) / 1000 / wall) * 100;
    const mem = process.memoryUsage();
    const snap = {
      t: new Date().toISOString(),
      cpuPctMachine: round(cpuPctMachine),
      heapMB: round(mem.heapUsed / 1048576),
      rssMB: round(mem.rss / 1048576),
      elDelayMs: {
        p50: round(elDelay.mean / 1e6),
        p99: round(elDelay.percentile(99) / 1e6),
        max: round(elDelay.max / 1e6),
      },
      pool: {
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount,
      },
      openTxns,
      wsClients: undefined as number | undefined,
      wsSendCalls: wsSend.calls,
      wsSendMs: round(wsSend.totalMs),
      wsSendBytes: wsSend.bytes,
    };
    jsonl.write(JSON.stringify(snap) + "\n");
  }, SNAPSHOT_MS);

  server.listen(PORT, () => {
    console.log(
      `[profile-server:${LABEL}] listening on ${PORT} ws=${process.env.NO_WS === "1" ? "OFF" : "on"} ` +
      `NODE_ENV=${process.env.NODE_ENV ?? "(unset)"} RATE_LIMIT_TRADE=${process.env.RATE_LIMIT_TRADE ?? "default(60)"} ` +
      `RATE_LIMIT_API=${process.env.RATE_LIMIT_API ?? "default(300)"}`,
    );
  });

  // Final summary on exit
  const dump = () => {
    clearInterval(timer);
    const statOut: Record<string, unknown> = {};
    for (const [name, s] of stages) {
      const sorted = [...s.samples].sort((a, b) => a - b);
      statOut[name] = {
        n: s.n,
        errors: s.errors,
        rows: s.rows,
        meanMs: round(s.totalMs / Math.max(1, s.n)),
        p50: pct(sorted, 50),
        p90: pct(sorted, 90),
        p95: pct(sorted, 95),
        p99: pct(sorted, 99),
        max: sorted.length ? round(sorted[sorted.length - 1]) : 0,
      };
    }
    const txSorted = [...txRecords].sort((a, b) => a.durationMs - b.durationMs);
    const gapSorted = [...txRecords].sort((a, b) => a.gapMs - b.gapMs);
    const acqSorted = [...acqSamples].sort((a, b) => a - b);
    const summary = {
      label: LABEL,
      pid: process.pid,
      node: process.version,
      env: {
        NODE_ENV: process.env.NODE_ENV ?? null,
        NO_WS: process.env.NO_WS ?? null,
        RATE_LIMIT_TRADE: process.env.RATE_LIMIT_TRADE ?? null,
        RATE_LIMIT_API: process.env.RATE_LIMIT_API ?? null,
        PG_POOL_SIZE: process.env.PG_POOL_SIZE ?? null,
      },
      stages: statOut,
      transactions: {
        n: txRecords.length,
        durationP50: pct(txSorted.map((t) => t.durationMs), 50),
        durationP95: pct(txSorted.map((t) => t.durationMs), 95),
        durationP99: pct(txSorted.map((t) => t.durationMs), 99),
        durationMax: txSorted.length ? round(Math.max(...txRecords.map((t) => t.durationMs))) : 0,
        gapP50: pct(gapSorted.map((t) => t.gapMs), 50),
        gapP95: pct(gapSorted.map((t) => t.gapMs), 95),
        gapP99: pct(gapSorted.map((t) => t.gapMs), 99),
        gapMax: txRecords.length ? round(Math.max(...txRecords.map((t) => t.gapMs))) : 0,
        openTxnsPeak,
      },
      poolAcquisition: {
        n: acqSamples.length,
        p50: pct(acqSorted, 50),
        p95: pct(acqSorted, 95),
        p99: pct(acqSorted, 99),
        max: acqSorted.length ? round(acqSorted[acqSorted.length - 1]) : 0,
        waitingPeak: acqWaitingPeak,
      },
      wsSend: wsSend,
      elDelayFinalMs: {
        mean: round(elDelay.mean / 1e6),
        p99: round(elDelay.percentile(99) / 1e6),
        max: round(elDelay.max / 1e6),
      },
    };
    fs.writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 1));
    console.log(`[profile-server:${LABEL}] summary -> ${SUMMARY_PATH}`);
  };
  process.on("SIGINT", () => {
    dump();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    dump();
    process.exit(0);
  });
  // Dump periodically too (so a hard kill still leaves data)
  setInterval(dump, 30_000);
}

function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return round(sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]);
}
function round(n: number): number {
  return Math.round(n * 100) / 100;
}

main().catch((e) => {
  console.error("[profile-server fatal]", e);
  process.exit(1);
});
