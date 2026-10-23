/**
 * TEMPORARY — query plan + scaling profiler for the trade-execution path.
 * EXPLAIN (ANALYZE, BUFFERS) for each trade-path query; plus a fee-count
 * scaling bench (100k / 1M order_logs rows) to show degradation with history.
 *
 * Writes are wrapped in BEGIN/ROLLBACK so EXPLAIN ANALYZE executes them but
 * the enclosing transaction is never committed (no pollution of real teams).
 *
 * Output: reports/explain/*.txt and reports/explain/summary.json
 */
import pg from "pg";
import fs from "node:fs";
import path from "node:path";

const DATABASE_URL = "postgres://mercatus:mercatus@localhost:5432/mercatus";
const OUT = path.resolve("reports/explain");
fs.mkdirSync(OUT, { recursive: true });

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });

async function indexInventory(): Promise<string> {
  const r = await pool.query(
    `select indexname, tablename, indexdef from pg_indexes
     where schemaname='public'
       and tablename in ('teams','holdings','order_logs','live_prices','event_config')
     order by tablename, indexname`,
  );
  return r.rows.map((x) => `${x.tablename}.${x.indexname}\n  ${x.indexdef}`).join("\n");
}

async function explainRead(name: string, sql: string, params: unknown[]) {
  const r = await pool.query(
    `EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT TEXT) ${sql}`,
    params,
  );
  const plan = r.rows.map((x: any) => x["QUERY PLAN"]).join("\n");
  fs.writeFileSync(path.join(OUT, `${name}.txt`), plan);
  console.log(`wrote ${name}.txt`);
}

async function explainWrite(name: string, sql: string, params: unknown[]) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const r = await client.query(
      `EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT TEXT) ${sql}`,
      params,
    );
    const plan = r.rows.map((x: any) => x["QUERY PLAN"]).join("\n");
    await client.query("ROLLBACK");
    fs.writeFileSync(path.join(OUT, `${name}.txt`), plan);
    console.log(`wrote ${name}.txt (write, rolled back)`);
  } finally {
    client.release();
  }
}

async function feeCountScaling(): Promise<Record<string, unknown>> {
  // Scratch table mirroring the columns used by the fee-count query.
  await pool.query(`drop table if exists order_logs_scale`);
  await pool.query(
    `create table order_logs_scale (
       id bigserial primary key,
       team_id bigint not null,
       status text not null,
       created_at timestamptz not null default now()
     )`,
  );
  const out: Record<string, unknown> = {};
  const targetTeam = 777777;
  for (const n of [10_000, 100_000, 1_000_000]) {
    await pool.query(`truncate order_logs_scale`);
    // Distribute rows across ~500 teams; give the target team a slice.
    const targetRows = Math.max(1, Math.floor(n * 0.002));
    const BATCH = 20000; // 20k rows * 2 params = 40k < 65535 param limit
    for (let off = 0; off < n; off += BATCH) {
      const cnt = Math.min(BATCH, n - off);
      const vals: string[] = [];
      const params: unknown[] = [];
      let p = 1;
      for (let i = 0; i < cnt; i++) {
        const globalIdx = off + i;
        const tid = globalIdx < n - targetRows ? 1000 + (globalIdx % 500) : targetTeam;
        vals.push(`($${p},'SUCCESS')`);
        params.push(tid);
        p++;
      }
      await pool.query(
        `insert into order_logs_scale (team_id, status) values ${vals.join(",")}`,
        params,
      );
    }
    // Without index (mirrors current order_logs index situation if absent)
    const timings: number[] = [];
    for (let i = 0; i < 15; i++) {
      const t0 = performance.now();
      const r = await pool.query(
        `select count(*)::int as n from order_logs_scale where team_id = $1 and status = 'SUCCESS'`,
        [targetTeam],
      );
      timings.push(performance.now() - t0);
      if (i === 0) out[`count_at_${n}`] = Number(r.rows[0].n);
    }
    timings.sort((a, b) => a - b);
    out[`noindex_ms_p50_${n}`] = Math.round(timings[7] * 100) / 100;
    out[`noindex_ms_p95_${n}`] = Math.round(timings[14] * 100) / 100;

    // Now add the natural composite index and re-measure
    await pool.query(
      `create index on order_logs_scale (team_id, status)`,
    );
    const t2: number[] = [];
    for (let i = 0; i < 15; i++) {
      const t0 = performance.now();
      await pool.query(
        `select count(*)::int as n from order_logs_scale where team_id = $1 and status = 'SUCCESS'`,
        [targetTeam],
      );
      t2.push(performance.now() - t0);
    }
    t2.sort((a, b) => a - b);
    out[`indexed_ms_p50_${n}`] = Math.round(t2[7] * 100) / 100;
    out[`indexed_ms_p95_${n}`] = Math.round(t2[14] * 100) / 100;
    await pool.query(`drop index if exists order_logs_scale_team_id_status_idx`);
    console.log(`fee-scaling ${n}: noidx p50=${out[`noindex_ms_p50_${n}`]}ms indexed p50=${out[`indexed_ms_p50_${n}`]}ms`);
  }
  await pool.query(`drop table if exists order_logs_scale`);
  return out;
}

async function main() {
  const t = await pool.query(
    `select team_id from teams where email like 'lt_%@loadtest.local' order by team_id limit 1`,
  );
  const teamId = Number(t.rows[0].team_id);
  const sym = "A";

  fs.writeFileSync(path.join(OUT, "indexes.txt"), await indexInventory());
  console.log("wrote indexes.txt");

  await explainRead(
    "q01_team_for_update",
    `select team_id, cash_balance, is_frozen from teams where team_id = $1 for update`,
    [teamId],
  );
  await explainRead(
    "q02_event_config",
    `select state, paused from event_config where id = true`,
    [],
  );
  await explainRead(
    "q03_live_price",
    `select price from live_prices where symbol = $1`,
    [sym],
  );
  await explainRead(
    "q04_fee_count",
    `select count(*)::int as n from order_logs where team_id = $1 and status = 'SUCCESS'`,
    [teamId],
  );
  await explainWrite(
    "q05_cash_update",
    `update teams set cash_balance = cash_balance - $1 where team_id = $2`,
    [100, teamId],
  );
  await explainWrite(
    "q06_holdings_upsert",
    `insert into holdings (team_id, symbol, quantity, average_buy_price)
     values ($1,$2,$3,$4)
     on conflict (team_id, symbol) do update
     set quantity = holdings.quantity + excluded.quantity,
         average_buy_price = (holdings.average_buy_price*holdings.quantity+excluded.average_buy_price*excluded.quantity)/(holdings.quantity+excluded.quantity)`,
    [teamId, sym, 1, 100],
  );
  await explainWrite(
    "q07_portfolio_value_update",
    `update teams set total_portfolio_value =
       (select cash_balance from teams where team_id = $1)
       + coalesce((select sum(h.quantity*lp.price)
                   from holdings h left join live_prices lp on lp.symbol = h.symbol
                   where h.team_id = $1), 0)
     where team_id = $1`,
    [teamId],
  );
  await explainWrite(
    "q08_order_log_insert",
    `insert into order_logs (team_id, action, symbol, quantity, price_requested, price_executed, status, latency_ms, client_ref, fee)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning order_id`,
    [teamId, "BUY", sym, 1, 100, 100, "SUCCESS", 1, null, 0],
  );
  await explainRead(
    "q09_cash_after",
    `select cash_balance from teams where team_id = $1`,
    [teamId],
  );
  await explainRead(
    "leaderboard",
    `select t.team_id, t.team_name,
            round(t.cash_balance + coalesce((
              select sum(h.quantity * lp.price)
              from holdings h left join live_prices lp on lp.symbol = h.symbol
              where h.team_id = t.team_id and h.quantity > 0
            ), 0), 2) as total_portfolio_value,
            rank() over (order by
              (t.cash_balance + coalesce((
                select sum(h.quantity * lp.price)
                from holdings h left join live_prices lp on lp.symbol = h.symbol
                where h.team_id = t.team_id and h.quantity > 0
              ), 0)) desc) as rank
     from teams t where t.role = 'team' order by rank`,
    [],
  );

  const scaling = await feeCountScaling();
  fs.writeFileSync(
    path.join(OUT, "summary.json"),
    JSON.stringify({ teamId, sym, scaling }, null, 2),
  );
  console.log("wrote summary.json");
  await pool.end();
}

main().catch((e) => {
  console.error("[fatal]", e);
  process.exit(1);
});
