/**
 * TEMPORARY ORCHESTRATOR for profiling runs.
 * Boots scripts/profile-server.ts with per-scenario env, waits for health,
 * runs scripts/loadgen-profile.ts, stops the server (SIGTERM -> summary dump).
 *
 * Usage: npx tsx scripts/run-matrix.ts sanity25,scale50
 */

import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";

const PORT = Number(process.env.PORT ?? 4040);
const ONLY = (process.argv[2] ?? "").split(",").filter(Boolean);

interface Scenario {
  name: string;
  serverEnv: Record<string, string>;
  genEnv: Record<string, string>;
}

const base = {
  TICK_INTERVAL_MS: "1000",
};

const SCENARIOS: Scenario[] = [
  // ── instrumentation sanity ──
  { name: "sanity25", serverEnv: { ...base }, genEnv: { MODE: "mixed", VUS: "25", WARMUP_MS: "10000", DURATION_MS: "45000", WS_CLIENTS: "25" } },

  // ── scaling matrix (baseline mix, distinct teams, limiters ON) ──
  { name: "scale10", serverEnv: { ...base }, genEnv: { MODE: "mixed", VUS: "10", WARMUP_MS: "10000", DURATION_MS: "60000", WS_CLIENTS: "10" } },
  { name: "scale25", serverEnv: { ...base }, genEnv: { MODE: "mixed", VUS: "25", WARMUP_MS: "10000", DURATION_MS: "60000", WS_CLIENTS: "25" } },
  { name: "scale50", serverEnv: { ...base }, genEnv: { MODE: "mixed", VUS: "50", WARMUP_MS: "15000", DURATION_MS: "60000", WS_CLIENTS: "50" } },
  { name: "scale100", serverEnv: { ...base }, genEnv: { MODE: "mixed", VUS: "100", WARMUP_MS: "15000", DURATION_MS: "60000", WS_CLIENTS: "100" } },

  // ── same-team vs distinct-team contention (trade-heavy, elevated TEST-ONLY limits) ──
  {
    name: "contend_distinct",
    serverEnv: { ...base, RATE_LIMIT_TRADE: "1000000", RATE_LIMIT_API: "1000000" },
    genEnv: { MODE: "tradeheavy", VUS: "100", TEAMS: "DISTINCT", THINK_MIN: "400", THINK_MAX: "900", WARMUP_MS: "10000", DURATION_MS: "60000", WS_CLIENTS: "0" },
  },
  {
    name: "contend_shared10",
    serverEnv: { ...base, RATE_LIMIT_TRADE: "1000000", RATE_LIMIT_API: "1000000" },
    genEnv: { MODE: "tradeheavy", VUS: "100", TEAMS: "10", THINK_MIN: "400", THINK_MAX: "900", WARMUP_MS: "10000", DURATION_MS: "60000", WS_CLIENTS: "0" },
  },

  // ── rate limiter A/B at 50 VUs (B side uses NODE_ENV=test noop limiters) ──
  { name: "limiter_on_50", serverEnv: { ...base }, genEnv: { MODE: "mixed", VUS: "50", WARMUP_MS: "15000", DURATION_MS: "60000", WS_CLIENTS: "50" } },
  { name: "limiter_off_50", serverEnv: { ...base, NODE_ENV: "test" }, genEnv: { MODE: "mixed", VUS: "50", WARMUP_MS: "15000", DURATION_MS: "60000", WS_CLIENTS: "50" } },

  // ── WebSocket broadcast A/B at 50 VUs ──
  { name: "ws_off_50", serverEnv: { ...base, NO_WS: "1" }, genEnv: { MODE: "mixed", VUS: "50", WARMUP_MS: "15000", DURATION_MS: "60000", WS_CLIENTS: "0" } },

  // ── WebSocket client scaling under light load (25 VUs) ──
  { name: "wsscale10", serverEnv: { ...base }, genEnv: { MODE: "mixed", VUS: "25", WARMUP_MS: "10000", DURATION_MS: "45000", WS_CLIENTS: "10" } },
  { name: "wsscale50", serverEnv: { ...base }, genEnv: { MODE: "mixed", VUS: "25", WARMUP_MS: "10000", DURATION_MS: "45000", WS_CLIENTS: "50" } },
  { name: "wsscale100", serverEnv: { ...base }, genEnv: { MODE: "mixed", VUS: "25", WARMUP_MS: "10000", DURATION_MS: "45000", WS_CLIENTS: "100" } },
  { name: "wsscale500", serverEnv: { ...base }, genEnv: { MODE: "mixed", VUS: "25", WARMUP_MS: "10000", DURATION_MS: "45000", WS_CLIENTS: "500" } },

  // ── generator control test: healthz-only, 500 VUs, no WS ──
  { name: "control_healthz500", serverEnv: { ...base }, genEnv: { MODE: "healthz", VUS: "500", WARMUP_MS: "10000", DURATION_MS: "60000", WS_CLIENTS: "0" } },
];

function killPort(): Promise<void> {
  // Kill whatever listens on PORT, then VERIFY the port is actually free
  // (retry up to ~8s) so a stale server can never satisfy waitHealthy().
  return new Promise((resolve) => {
    let attempts = 0;
    const step = () => {
      const c = spawn("powershell", [
        "-NoProfile", "-Command",
        `$c = Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue; 'KILLED' } else { 'FREE' }`,
      ], { stdio: "pipe" });
      let out = "";
      c.stdout!.on("data", (d) => (out += d.toString()));
      c.on("close", () => {
        if (out.includes("FREE") || attempts > 8) resolve();
        else {
          attempts++;
          setTimeout(step, 900);
        }
      });
    };
    step();
  });
}

function waitHealthy(timeoutMs: number): Promise<boolean> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const tryOnce = () => {
      const req = http.get(`http://localhost:${PORT}/healthz`, { timeout: 2000 }, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on("error", () => retry());
      req.on("timeout", () => {
        req.destroy();
        retry();
      });
    };
    const retry = () => {
      if (Date.now() - t0 > timeoutMs) resolve(false);
      else setTimeout(tryOnce, 700);
    };
    tryOnce();
  });
}

async function runScenario(sc: Scenario): Promise<void> {
  console.log(`\n${"=".repeat(70)}\nSCENARIO ${sc.name}\n  server: ${JSON.stringify(sc.serverEnv)}\n  gen:    ${JSON.stringify(sc.genEnv)}\n${"=".repeat(70)}`);

  await killPort();

  const server = spawn("npx", ["tsx", "scripts/profile-server.ts"], {
    cwd: path.resolve("."),
    env: { ...process.env, ...sc.serverEnv, LABEL: sc.name, PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
    shell: true,
  });
  let serverLog = "";
  server.stdout!.on("data", (d) => {
    serverLog += d.toString();
  });
  server.stderr!.on("data", (d) => {
    serverLog += d.toString();
  });

  const ok = await waitHealthy(45_000);
  if (!ok) {
    console.error(`[run-matrix] server failed to become healthy:\n${serverLog.slice(-3000)}`);
    server.kill("SIGKILL");
    throw new Error(`scenario ${sc.name}: server unhealthy`);
  }
  console.log(`[run-matrix] server up (pid ${server.pid})`);

  // Small settle delay
  await new Promise((r) => setTimeout(r, 2000));

  const gen = spawn("npx", ["tsx", "scripts/loadgen-profile.ts"], {
    cwd: path.resolve("."),
    env: { ...process.env, ...sc.genEnv, LABEL: sc.name, PORT: String(PORT) },
    stdio: ["ignore", "inherit", "inherit"],
    shell: true,
  });
  const genCode = await new Promise<number>((resolve) => gen.on("close", resolve));

  // Graceful stop -> SIGTERM triggers summary dump in profile-server
  server.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 4000));
  if (!server.killed) server.kill("SIGKILL");
  await killPort();

  console.log(`[run-matrix] scenario ${sc.name} complete (loadgen exit=${genCode})`);
}

async function main() {
  const list = ONLY.length ? SCENARIOS.filter((s) => ONLY.includes(s.name)) : SCENARIOS;
  for (const sc of list) {
    await runScenario(sc);
  }
  console.log("\n[run-matrix] all done");
  process.exit(0);
}

main().catch((e) => {
  console.error("[fatal]", e);
  process.exit(1);
});
