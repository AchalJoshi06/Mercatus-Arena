// Generates a 3-month continuous 24/7 synthetic dataset (Indian large-cap
// symbols, no day gaps) and loads it via COPY FROM
// STDIN. Deterministic: same seed => identical tape.
//
// Usage: npx tsx scripts/gen-nse-dataset.ts [--days 63] [--seed 20260826]

import pg from "pg";
import { from as copyFrom } from "pg-copy-streams";
import dotenv from "dotenv";
import {
  buildDayList,
  sessionBoundsOfDay,
  istDayStart,
} from "../src/sessions.js";
import { personalityFor } from "../src/personality.js";
import { SYMBOLS } from "../src/symbols.js";

dotenv.config({ path: ".env" });

const SEED = Number(process.argv.includes("--seed") ? process.argv[process.argv.indexOf("--seed") + 1] : 20260826);
const DAYS = Number(process.argv.includes("--days") ? process.argv[process.argv.indexOf("--days") + 1] : 7);

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(SEED);
function gauss(): number {
  const u1 = Math.max(rng(), 1e-12);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
// prices live on a Rs 0.05 tick grid, stored with 2 decimals
const tick05 = (p: number) => Math.round(p * 20) / 20;

async function main() {
  // --- window: the last `DAYS` completed sessions (24/7) -------------------
  let cand = Date.now();
  if (Date.now() < sessionBoundsOfDay(cand).closeT) cand -= 86_400_000;
  const endDay = istDayStart(cand);
  const cursor = endDay - (DAYS - 1) * 86_400_000;
  const endT = sessionBoundsOfDay(endDay).closeT;
  const days = buildDayList(cursor, endT);
  console.log(`window: ${new Date(days[0].openT).toISOString()} .. ${new Date(days[days.length - 1].closeT).toISOString()} (${days.length} sessions)`);

  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  // --- dataset row (inactive until cutover) --------------------------------
  const symbols = SYMBOLS.map(([s]) => s);
  const ds = await client.query(
    `insert into market_datasets (name, row_count, symbol_list, start_t, live_start_t, end_t, is_active)
     values ($1, 0, $2, $3, $4, $5, false) returning dataset_id`,
    [
      `nse_247_${DAYS}d`,
      symbols,
      days[0].openT,
      days[Math.max(0, days.length - 2)].openT,
      days[days.length - 1].closeT,
    ],
  );
  const datasetId = Number(ds.rows[0].dataset_id);
  console.log(`dataset_id=${datasetId}`);

  // --- speed up bulk load --------------------------------------------------
  await client.query(`drop index if exists idx_dataset_ticks_time`);
  const t0 = Date.now();

  const stream: any = client.query(copyFrom(
    `copy dataset_ticks (dataset_id, seq, t, symbol, price, volume) from stdin with (format csv)`,
  ) as any);

  const SEC_PER_DAY = 86_400; // 24/7 (24 hours per day)
  const prevClose = new Map<string, number>(SYMBOLS.map(([s, p]) => [s, p]));
  let seq = 0;
  let buf: string[] = [];
  let pending = 0;

  const writeChunk = async () => {
    if (!buf.length) return;
    const ok = stream.write(buf.join(""));
    buf = [];
    if (!ok) await new Promise<void>((res) => stream.once("drain", res));
  };

  const momentum = new Map<string, number>();
  for (const [s] of SYMBOLS) momentum.set(s, 0);
  // Revertible part of recent liquidity shocks (decays back, ~45s time constant)
  const shockOff = new Map<string, number>();
  for (const [s] of SYMBOLS) shockOff.set(s, 0);

  for (let di = 0; di < days.length; di++) {
    const { openT } = days[di];
    // 24/7 market: each day continues from the previous close (no gap)
    const dayOpen = new Map<string, number>();
    for (const [s] of SYMBOLS) dayOpen.set(s, prevClose.get(s)!);
    for (let sec = 0; sec < SEC_PER_DAY; sec++) {
      const t = openT + sec * 1000;
      const u = sec / (SEC_PER_DAY - 1);
      const volU = 1.35 - 0.7 * Math.sin(Math.PI * u); // realistic U-shaped intraday curve

      for (const [s] of SYMBOLS) {
        const pers = personalityFor(s);
        const regime = Math.sin((t / 1000) * ((2 * Math.PI) / pers.periodSec) + pers.phase);
        let p = sec === 0 ? dayOpen.get(s)! : prevClose.get(s)!;

        // Momentum autocorrelation: produces natural multi-bar waves, swings, and wicks
        const prevM = momentum.get(s) ?? 0;
        // Scaled for 24h days: target ~1.5–2.5% daily range for vol≈1 names.
        // (Momentum persistence amplifies impulse ~1/(1-0.94) ≈ 17× long-run.)
        const impulse = gauss() * 0.000004 * pers.vol * volU;
        const m = prevM * 0.94 + impulse;
        momentum.set(s, m);

        // Price return = momentum + random walk tick step + regime drift
        const ret = m + gauss() * 0.00006 * pers.vol * volU + pers.drift * regime * 0.0015;
        p *= 1 + ret;

        // Soft pull toward day open to prevent runaway divergence while allowing natural swings
        p += (dayOpen.get(s)! - p) * 0.00003;

        // Occasional realistic liquidity sweep / intraday shock (e.g. news/block trade)
        let so = shockOff.get(s) ?? 0;
        if (rng() < 3 / 86400) {
          const x = (rng() < 0.5 ? -1 : 1) * (0.003 + rng() * 0.005);
          p *= 1 + x;
          so += x * 0.5; // half of the move mean-reverts
        }
        if (so !== 0) {
          const rev = so / 45;
          p *= 1 - rev;
          so -= rev;
          if (Math.abs(so) < 1e-6) so = 0;
        }
        shockOff.set(s, so);

        // Daily circuit band (±10%)
        p = clamp(p, dayOpen.get(s)! * 0.9, dayOpen.get(s)! * 1.1);
        p = tick05(p);
        prevClose.set(s, p);

        // Volume correlated with price return magnitude and activity
        const moveMagnitude = Math.abs(ret) * 1000;
        const baseVol = Math.round(350 * volU * (1 + moveMagnitude * 3) * Math.exp(0.5 * gauss()));
        const vol = clamp(baseVol, 25, 15_000);

        seq++;
        buf.push(`${datasetId},${seq},${t},${s},${p.toFixed(2)},${vol}\n`);
        if (buf.length >= 25_000) {
          await writeChunk();
        }
      }
    }
    await writeChunk();
    process.stdout.write(`\rday ${di + 1}/${days.length} rows=${seq}`);
  }
  await writeChunk();
  await new Promise<void>((resolve, reject) => {
    stream.on("finish", resolve);
    stream.on("error", reject);
    stream.end();
  });
  const copySecs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nCOPY done in ${copySecs}s, rows=${seq}`);

  await client.query(`update market_datasets set row_count = $2 where dataset_id = $1`, [datasetId, seq]);
  console.log("creating indexes...");
  await client.query(`create index if not exists idx_dataset_ticks_time on dataset_ticks (dataset_id, t)`);
  await client.query(`create index if not exists idx_dataset_ticks_sym_time on dataset_ticks (dataset_id, symbol, t)`);
  await client.query(`analyze dataset_ticks`);

  console.log("activating new dataset...");
  await client.query(`update market_datasets set is_active = false`);
  await client.query(`update market_datasets set is_active = true where dataset_id = $1`, [datasetId]);

  const liveStart = days[Math.max(0, days.length - 2)].openT;
  await client.query(`
    insert into market_state (dataset_id, last_t, updated_at)
    values ($1, $2, now())
    on conflict (dataset_id) do update set last_t = excluded.last_t, updated_at = now()
  `, [datasetId, liveStart]);

  // Seed live_prices with exact opening prices at liveStart
  const firstTicks = await client.query(`
    select distinct on (symbol) symbol, price
    from dataset_ticks
    where dataset_id = $1 and t >= $2
    order by symbol, t asc, seq asc
  `, [datasetId, liveStart]);

  for (const r of firstTicks.rows) {
    await client.query(`
      insert into live_prices (symbol, price, prev_price, updated_at)
      values ($1, $2, $2, now())
      on conflict (symbol) do update set price = excluded.price, prev_price = excluded.price, updated_at = now()
    `, [r.symbol, r.price]);
  }

  // Update event_config to calibrated realistic defaults
  await client.query(`
    update event_config
    set noise_sigma = '0.00035',
        volatility_multiplier = '1.0',
        flash_decay = '0.97'
    where id = true
  `);

  const chk = await client.query(
    `select count(*)::bigint as rows, min(t) as mn, max(t) as mx,
            count(distinct symbol) as syms
     from dataset_ticks where dataset_id = $1`,
    [datasetId],
  );
  console.log("verify:", JSON.stringify(chk.rows[0]));
  await client.end();
}

main().catch(async (e) => {
  console.error("FATAL", e);
  process.exit(1);
});
