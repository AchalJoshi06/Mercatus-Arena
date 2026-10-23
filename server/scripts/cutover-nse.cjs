// Cutover to the NSE-hours dataset: backup portfolio tables, activate the new
// dataset, reset team portfolios to starting_capital, seed live prices from
// day-1 gap opens, unpause, then restart server + bots.
//
// Usage (from repo root or server dir): node scripts/cutover-nse.cjs

const pg = require("pg");
require("dotenv").config({ path: ".env" });
const { execSync } = require("child_process");

const c = new pg.Client({ connectionString: process.env.DATABASE_URL });

function killByPattern(pattern) {
  try {
    const out = execSync(
      `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match '${pattern}' } | ForEach-Object { $_.ProcessId }"`,
      { encoding: "utf8" },
    ).trim();
    for (const pid of out.split(/\s+/).filter(Boolean)) {
      try {
        execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" });
        console.log(`killed ${pattern} pid ${pid}`);
      } catch (_) {}
    }
  } catch (_) {}
}

(async () => {
  // Stop any live server/bot processes FIRST so they don't hold locks on the
  // tables we are about to truncate/reset.
  console.log("stopping old server/bots...");
  killByPattern("demo-bots-runner");
  killByPattern("optimal-bot-runner");
  killByPattern("src/index.ts");
  await new Promise((r) => setTimeout(r, 2500));

  await c.connect();

  const target = (
    await c.query(
      "select dataset_id, start_t from market_datasets where name = 'nse_hours_63d' order by dataset_id desc limit 1",
    )
  ).rows[0];
  if (!target) throw new Error("nse_hours_63d dataset not found");
  const newId = Number(target.dataset_id);
  const startT = Number(target.start_t);
  console.log("target dataset:", newId, "start_t", startT);

  const old = await c.query(
    "select dataset_id, last_t from market_state limit 1",
  );
  const oldId = old.rows[0] ? Number(old.rows[0].dataset_id) : null;
  const oldLastT = old.rows[0] ? Number(old.rows[0].last_t) : null;
  console.log("current market_state:", oldId, oldLastT);

  // 1) preserve portfolios in a rollback table
  for (const t of ["holdings", "order_logs", "request_logs", "leaderboard_snapshot"]) {
    await c.query(`drop table if exists _backup_${t}`);
    await c.query(`create table _backup_${t} as select * from ${t}`);
    console.log(`backup -> _backup_${t}`);
  }

  // 2) activate new dataset
  await c.query("update market_datasets set is_active = false where dataset_id <> $1", [newId]);
  await c.query("update market_datasets set is_active = true where dataset_id = $1", [newId]);

  // 3) reset live prices from day-1 gap opens. Per-symbol indexed lookups
  //    (idx_dataset_ticks_sym_time) are instant; scanning the whole 42M-row
  //    table for a window function is far too slow here.
  await c.query("truncate live_prices");
  const symRow = await c.query(
    "select symbol_list from market_datasets where dataset_id = $1",
    [newId],
  );
  const syms = symRow.rows[0].symbol_list;
  for (const s of syms) {
    const r = await c.query(
      "select price from dataset_ticks where dataset_id = $1 and symbol = $2 order by t limit 1",
      [newId, s],
    );
    if (r.rows[0]) {
      await c.query(
        "insert into live_prices (symbol, price, prev_price) values ($1, $2, $2)",
        [s, Number(r.rows[0].price)],
      );
    }
  }

  // 4) market_state points at the new dataset, replay at its start
  await c.query(
    `insert into market_state (dataset_id, last_t) values ($1, $2)
     on conflict (dataset_id) do update set dataset_id = $1, last_t = $2`,
    [newId, startT],
  );

  // 5) portfolio reset
  await c.query(
    "update teams set cash_balance = starting_capital, total_portfolio_value = starting_capital where role = 'team'",
  );
  await c.query("truncate holdings, order_logs, request_logs, leaderboard_snapshot");

  // 6) event config: live, not paused, far-future end
  await c.query(
    `update event_config set
       state = 'ACTIVE_MARKET', paused = false, leaderboard_frozen = false,
       tick_count = '0', flash_shock = '0',
       scheduled_end_at = now() + interval '365 days',
       api_freeze_at = now() + interval '365 days',
       leaderboard_freeze_at = now() + interval '365 days'
     where id = true`,
  );

  const summary = {
    cutover: new Date().toISOString(),
    activatedDataset: newId,
    rolledBackFrom: { datasetId: oldId, lastT: oldLastT },
    backups: ["holdings", "order_logs", "request_logs", "leaderboard_snapshot"].map((t) => `_backup_${t}`),
  };
  console.log("CUTOVER SUMMARY:", JSON.stringify(summary, null, 2));
  await c.end();

  // 7) start fresh processes
  console.log("starting server...");
  execSync("cmd /c start \"\" run-server.bat", { cwd: process.cwd(), stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 4000));
  console.log("starting demo + optimal bots...");
  execSync("cmd /c start \"\" scripts/run-bots.bat", { cwd: process.cwd(), stdio: "ignore" });
  execSync("cmd /c start \"\" scripts/run-optimal.bat", { cwd: process.cwd(), stdio: "ignore" });

  console.log("done. Verify: GET /api/market/status and /api/market/history?symbol=RELIANCE&resolution=1m");
})().catch((e) => {
  console.error("ERR", e);
  process.exit(1);
});
