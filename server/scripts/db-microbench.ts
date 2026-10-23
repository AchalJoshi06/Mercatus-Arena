/**
 * TEMPORARY PROFILING SCRIPT (not production code).
 * DB micro-benchmarks for the Mercatus trade path.
 * Measures raw PostgreSQL operation costs on this machine so the
 * root-cause analysis can attribute latency to specific primitives.
 *
 * Usage: npx tsx scripts/db-microbench.ts
 */

import pg from "pg";
import fs from "node:fs";
import path from "node:path";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://mercatus:mercatus@localhost:5432/mercatus";
const OUT = path.resolve("..", "reports", "profiling", "db-microbench.json");

interface Stat {
  op: string;
  n: number;
  min: number;
  mean: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  max: number;
}

function summarize(op: string, samples: number[]): Stat {
  const s = [...samples].sort((a, b) => a - b);
  const pct = (p: number) => s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
  return {
    op,
    n: s.length,
    min: s[0],
    mean: s.reduce((a, b) => a + b, 0) / s.length,
    p50: pct(50),
    p90: pct(90),
    p95: pct(95),
    p99: pct(99),
    max: s[s.length - 1],
  };
}

async function bench(
  name: string,
  iterations: number,
  fn: () => Promise<void>,
): Promise<Stat> {
  // warm-up
  for (let i = 0; i < Math.min(20, iterations); i++) await fn();
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    await fn();
    samples.push(performance.now() - t0);
  }
  return summarize(name, samples);
}

async function main() {
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
  const results: Stat[] = [];
  const ms = () => performance.now();

  console.log("Running DB micro-benchmarks...\n");

  // 1. Pure network/protocol roundtrip
  results.push(await bench("select_1_roundtrip", 500, async () => {
    await pool.query("select 1");
  }));

  // 2. Empty transaction BEGIN+COMMIT (WAL flush cost, sync_commit=on)
  results.push(await bench("tx_empty_commit_sync_on", 300, async () => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("COMMIT");
    } finally {
      c.release();
    }
  }));

  // 3. Same with synchronous_commit=off (session-local, no server config change)
  results.push(await bench("tx_empty_commit_sync_off", 300, async () => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL synchronous_commit = off");
      await c.query("COMMIT");
    } finally {
      c.release();
    }
  }));

  // 4. SELECT from live_prices by PK
  results.push(await bench("select_live_prices_pk", 500, async () => {
    await pool.query(`select price from live_prices where symbol = $1`, ["A"]);
  }));

  // 5. SELECT event_config
  results.push(await bench("select_event_config", 500, async () => {
    await pool.query(`select state, paused from event_config where id = true`);
  }));

  // 6. SELECT teams FOR UPDATE inside tx (+commit)
  let teamIdRow = await pool.query(`select team_id from teams where role='team' order by team_id limit 1`);
  const tid = Number(teamIdRow.rows[0].team_id);
  results.push(await bench("tx_select_team_for_update_commit", 300, async () => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(`select team_id, cash_balance, is_frozen from teams where team_id = $1 for update`, [tid]);
      await c.query("COMMIT");
    } finally {
      c.release();
    }
  }));

  // 7. UPDATE teams cash_balance in tx (+commit)
  results.push(await bench("tx_update_cash_commit", 300, async () => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(`update teams set cash_balance = cash_balance - $1 where team_id = $2`, [0, tid]);
      await c.query("COMMIT");
    } finally {
      c.release();
    }
  }));

  // 8. INSERT into order_logs in tx (+commit)
  results.push(await bench("tx_insert_order_log_commit", 300, async () => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(
        `insert into order_logs (team_id, action, symbol, quantity, price_requested, price_executed, status, reason, latency_ms, client_ref, fee)
         values ($1,'BUY','A',1,null,null,'REJECTED','BENCH',0,'bench',0)`,
        [tid],
      );
      await c.query("COMMIT");
    } finally {
      c.release();
    }
  }));

  // 9. UPSERT holdings in tx (+commit)
  results.push(await bench("tx_upsert_holdings_commit", 300, async () => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(
        `insert into holdings (team_id, symbol, quantity, average_buy_price)
         values ($1,'BENCHX',1,1)
         on conflict (team_id, symbol) do update set quantity = holdings.quantity + excluded.quantity`,
        [tid],
      );
      await c.query("COMMIT");
    } finally {
      c.release();
    }
  }));
  await pool.query(`delete from holdings where symbol='BENCHX'`);

  // 10. Fee-count query shape (current data volume)
  results.push(await bench("fee_count_current_data", 200, async () => {
    await pool.query(
      `select count(*)::int as n from order_logs where team_id = $1 and status = 'SUCCESS'`,
      [tid],
    );
  }));

  // 11. Portfolio value aggregation (the subquery used by the trade path update)
  results.push(await bench("portfolio_value_subquery", 200, async () => {
    await pool.query(
      `select coalesce((
         select sum(h.quantity * lp.price)
         from holdings h
         left join live_prices lp on lp.symbol = h.symbol
         where h.team_id = $1 and h.quantity > 0
       ), 0) as v`,
      [tid],
    );
  }));

  // 12. Full portfolio-value UPDATE statement in tx (+commit)
  results.push(await bench("tx_portfolio_value_update_commit", 200, async () => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(
        `update teams set total_portfolio_value =
           (select cash_balance from teams where team_id = $1)
           + coalesce((
               select sum(h.quantity * lp.price)
               from holdings h
               left join live_prices lp on lp.symbol = h.symbol
               where h.team_id = $1
             ), 0)
         where team_id = $1`,
        [tid],
      );
      await c.query("COMMIT");
    } finally {
      c.release();
    }
  }));

  // 13. Leaderboard query (read-path stressor)
  results.push(await bench("leaderboard_query", 30, async () => {
    await pool.query(
      `select t.team_id, t.team_name,
              round(t.cash_balance + coalesce((
                select sum(h.quantity * lp.price)
                from holdings h
                left join live_prices lp on lp.symbol = h.symbol
                where h.team_id = t.team_id and h.quantity > 0
              ), 0), 2) as total_portfolio_value,
              rank() over (order by
                (t.cash_balance + coalesce((
                  select sum(h.quantity * lp.price)
                  from holdings h
                  left join live_prices lp on lp.symbol = h.symbol
                  where h.team_id = t.team_id and h.quantity > 0
                ), 0)) desc) as rank
       from teams t where t.role = 'team' order by rank`,
    );
  }));

  // 14. Rate-limit store upsert (PgRateLimitStore.increment shape)
  results.push(await bench("rate_limit_upsert", 500, async () => {
    await pool.query(
      `insert into rate_limits (key, hits, reset_at)
       values ($1, 1, now() + make_interval(secs => 60.0))
       on conflict (key) do update
       set hits = case when rate_limits.reset_at <= now() then 1 else rate_limits.hits + 1 end,
           reset_at = case when rate_limits.reset_at <= now() then excluded.reset_at else rate_limits.reset_at end
       returning hits, reset_at`,
      ["bench:test:key"],
    );
  }));
  await pool.query(`delete from rate_limits where key like 'bench:%'`);

  // 15. Simulated FULL trade transaction (mirrors atomic.ts BUY sequence)
  const sym = "A";
  results.push(await bench("tx_full_buy_sequence_atomic_mirror", 150, async () => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(`select team_id, cash_balance, is_frozen from teams where team_id = $1 for update`, [tid]);
      await c.query(`select state, paused from event_config where id = true`);
      await c.query(`select price from live_prices where symbol = $1`, [sym]);
      await c.query(`select count(*)::int as n from order_logs where team_id = $1 and status = 'SUCCESS'`, [tid]);
      await c.query(`update teams set cash_balance = cash_balance - $1 where team_id = $2`, [10, tid]);
      await c.query(
        `insert into holdings (team_id, symbol, quantity, average_buy_price)
         values ($1,$2,1,100)
         on conflict (team_id, symbol) do update
         set quantity = holdings.quantity + excluded.quantity,
             average_buy_price =
               (holdings.average_buy_price * holdings.quantity + excluded.average_buy_price * excluded.quantity)
               / (holdings.quantity + excluded.quantity)`,
        [tid, sym],
      );
      await c.query(
        `update teams set total_portfolio_value =
           (select cash_balance from teams where team_id = $1)
           + coalesce((
               select sum(h.quantity * lp.price)
               from holdings h
               left join live_prices lp on lp.symbol = h.symbol
               where h.team_id = $1
             ), 0)
         where team_id = $1`,
        [tid],
      );
      await c.query(
        `insert into order_logs (team_id, action, symbol, quantity, price_requested, price_executed, status, latency_ms, client_ref, fee)
         values ($1,'BUY',$2,1,null,100,'SUCCESS',0,'bench-full',0)`,
        [tid, sym],
      );
      await c.query(`select cash_balance from teams where team_id = $1`, [tid]);
      await c.query("COMMIT");
    } finally {
      c.release();
    }
  }));

  // Clean up bench rows
  await pool.query(`delete from order_logs where client_ref = 'bench'`);
  await pool.query(`delete from order_logs where client_ref = 'bench-full'`);

  await pool.end();

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(results, null, 2));

  console.log(
    "| Operation | n | min | mean | p50 | p90 | p95 | p99 | max |",
  );
  console.log("|---|---|---|---|---|---|---|---|---|");
  for (const r of results) {
    console.log(
      `| ${r.op} | ${r.n} | ${r.min.toFixed(2)} | ${r.mean.toFixed(2)} | ${r.p50.toFixed(2)} | ${r.p90.toFixed(2)} | ${r.p95.toFixed(2)} | ${r.p99.toFixed(2)} | ${r.max.toFixed(2)} |`,
    );
  }
  console.log(`\n[out] ${OUT}`);
}

main().catch((e) => {
  console.error("[fatal]", e);
  process.exit(1);
});
