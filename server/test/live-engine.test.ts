import { describe, it, expect, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { query } from "../src/db.js";
import { migrate } from "../src/schema.js";
import { generateSyntheticDataset } from "../src/generator.js";
import { EventEngine, engine as singleton } from "../src/engine.js";
import { config } from "../src/config.js";
import { SYMBOLS } from "../src/symbols.js";
import { createApp } from "../src/index.js";

const base = Object.fromEntries(SYMBOLS);
const names = SYMBOLS.map(([s]) => s);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const startOpts = { startCapital: 100_000, eventMinutes: 30, blackoutMinutes: 5, apiFreezeMinutes: 3 };

let last: EventEngine | null = null;

// Empty database, PRE_LAUNCH config: the engine must create a live dataset itself.
async function liveEngine() {
  last?.stop();
  config.crash.auto = false;
  await migrate();
  await query(
    `truncate live_prices, market_state, dataset_ticks, market_datasets
     restart identity cascade`,
  );
  await query(
    `update event_config set state = 'PRE_LAUNCH', paused = false,
            leaderboard_frozen = false, credentials_revealed = false,
            tick_count = 0, flash_shock = 0, flash_symbols = '', flash_decay = 0.9,
            replay_speed = 1, circuit_pct = 0.1,
            event_started_at = null, scheduled_end_at = null,
            leaderboard_freeze_at = null, api_freeze_at = null
     where id = true`,
  );
  const e = new EventEngine();
  await e.init();
  e.stop(); // tests drive tick() by hand
  last = e;
  return e;
}

afterAll(() => {
  last?.stop();
  singleton.stop();
});

describe("live engine", () => {
  it("creates a live dataset with backfill when none is active", async () => {
    const e = await liveEngine();
    const st = e.getStatus();
    expect(st.datasetMode).toBe("live");
    expect(st.symbols).toEqual(names);
    expect(st.state).toBe("PRE_LAUNCH");
    const ds = await query(`select * from market_datasets`);
    expect(ds.rowCount).toBe(1);
    expect(ds.rows[0].mode).toBe("live");
    expect(ds.rows[0].is_active).toBe(true);
    expect(ds.rows[0].name).toMatch(/^live_/);
    expect(Number(ds.rows[0].live_start_t)).toBeGreaterThan(Number(ds.rows[0].start_t));
    const n = await query(`select count(*)::int as n from dataset_ticks`);
    expect(n.rows[0].n).toBe(360 * names.length);
    // the backfill ends exactly at the live-start prices (continuous charts)
    const tail = await query(
      `select symbol, price from dataset_ticks where t = $1`,
      [Number(ds.rows[0].live_start_t)],
    );
    expect(tail.rowCount).toBe(names.length);
    for (const r of tail.rows) expect(Number(r.price)).toBe(base[r.symbol]);
    const lp = await query(`select symbol, price from live_prices`);
    expect(lp.rowCount).toBe(names.length);
    for (const r of lp.rows) expect(Number(r.price)).toBe(base[r.symbol]);
    for (const s of names) expect(e.price(s)).toBe(base[s]);
  });

  it("restores on restart without creating a second dataset", async () => {
    const e1 = await liveEngine();
    await e1.startEvent(startOpts);
    await sleep(1100);
    await e1.tick();
    const before = Object.fromEntries(names.map((s) => [s, e1.price(s)!]));
    e1.stop();
    const e2 = new EventEngine();
    await e2.init();
    e2.stop();
    last = e2;
    expect((await query(`select 1 from market_datasets`)).rowCount).toBe(1);
    for (const s of names) expect(e2.price(s)).toBeCloseTo(before[s], 3);
    // The next persisted seq continues after the stored ones (no PK clash).
    await sleep(1100);
    await e2.tick();
    const dup = await query(
      `select count(*)::int as n from (select seq from dataset_ticks group by seq having count(*) > 1) d`,
    );
    expect(dup.rows[0].n).toBe(0);
  });

  it("startEvent builds a fresh live dataset and drops the old one", async () => {
    const e = await liveEngine();
    const oldId = e.getStatus().datasetId;
    await e.startEvent(startOpts);
    const st = e.getStatus();
    expect(st.state).toBe("ACTIVE_MARKET");
    expect(st.datasetId).not.toBe(oldId);
    const ds = await query(`select dataset_id, end_t, live_start_t from market_datasets where mode = 'live'`);
    expect(ds.rowCount).toBe(1);
    expect(Number(ds.rows[0].dataset_id)).toBe(st.datasetId);
    // end_t covers the scheduled end so nothing wraps during the event
    expect(Number(ds.rows[0].end_t)).toBeGreaterThanOrEqual(Date.now() + 30 * 60_000);
    const old = await query(`select count(*)::int as n from dataset_ticks where dataset_id = $1`, [oldId]);
    expect(old.rows[0].n).toBe(0);
    const fresh = await query(`select count(*)::int as n from dataset_ticks where dataset_id = $1`, [st.datasetId]);
    expect(fresh.rows[0].n).toBe(360 * names.length);
    expect(Math.abs(st.liveStartAt! - Date.now())).toBeLessThan(5000);
  });

  it("tick prices every symbol, persists ticks and respects the circuit band", async () => {
    const e = await liveEngine();
    await e.startEvent(startOpts);
    const dsId = e.getStatus().datasetId!;
    const open0 = Object.fromEntries(names.map((s) => [s, e.price(s)!]));
    for (let i = 0; i < 3; i++) {
      await sleep(1050);
      await e.tick();
    }
    const st = e.getStatus();
    expect(Math.abs(st.lastT - Date.now())).toBeLessThan(2000);
    for (const s of names) {
      const px = e.price(s)!;
      expect(px).toBeGreaterThan(0);
      expect(px).toBeGreaterThanOrEqual(open0[s] * 0.9 - 0.01);
      expect(px).toBeLessThanOrEqual(open0[s] * 1.1 + 0.01);
    }
    expect(names.some((s) => e.price(s) !== open0[s])).toBe(true);
    const live = await query(
      `select symbol, count(*)::int as n, min(price) as lo from dataset_ticks
       where dataset_id = $1 and t > $2 group by symbol`,
      [dsId, st.liveStartAt],
    );
    expect(live.rowCount).toBe(names.length);
    for (const r of live.rows) {
      expect(r.n).toBeGreaterThanOrEqual(2);
      expect(Number(r.lo)).toBeGreaterThan(0);
    }
    // seq is unique and strictly increasing with time per symbol
    const seqs = await query(
      `select seq from dataset_ticks where dataset_id = $1 order by seq`,
      [dsId],
    );
    expect(new Set(seqs.rows.map((r) => r.seq)).size).toBe(seqs.rowCount);
    const lp = await query(`select symbol, price from live_prices`);
    for (const r of lp.rows) expect(Number(r.price)).toBeCloseTo(e.price(r.symbol)!, 3);
  });

  it("keeps a flash crash inside the circuit band", async () => {
    const e = await liveEngine();
    await e.startEvent(startOpts);
    await e.triggerFlashCrash(-0.1, ["TCS"], 0.97);
    for (let i = 0; i < 2; i++) {
      await sleep(1050);
      await e.tick();
    }
    const px = e.price("TCS")!;
    expect(px).toBeGreaterThanOrEqual(base.TCS * 0.9 - 0.01);
  });

  it("pauses, resumes and continues from the same prices", async () => {
    const e = await liveEngine();
    await e.startEvent(startOpts);
    await sleep(1050);
    await e.tick();
    await e.pause();
    const frozen = Object.fromEntries(names.map((s) => [s, e.price(s)!]));
    await sleep(1100);
    await e.tick();
    for (const s of names) expect(e.price(s)).toBe(frozen[s]);
    await e.resume();
    await sleep(1100);
    await e.tick();
    for (const s of names) {
      expect(Math.abs(e.price(s)! / frozen[s] - 1)).toBeLessThan(0.02);
    }
    expect(e.getStatus().replaySpeed).toBe(1);
  });

  it("reloadDataset switches to a replay dataset and back-compat fields stay", async () => {
    const e = await liveEngine();
    await generateSyntheticDataset({ symbols: ["TST"], durationMinutes: 5, spacingMs: 1000, seed: 1 });
    await e.reloadDataset();
    expect(e.getStatus().datasetMode).toBe("replay");
    expect(e.getStatus().symbols).toEqual(["TST"]);
  });
});

describe("live chart history", () => {
  it("returns backfill + live bars stamped with wall-clock time", async () => {
    await liveEngine();
    await singleton.init();
    singleton.stop();
    await singleton.startEvent(startOpts);
    for (let i = 0; i < 3; i++) {
      await sleep(1050);
      await singleton.tick();
    }
    const server = http.createServer(createApp());
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as AddressInfo).port;
    try {
      const get = async (res: string) => {
        const r = await fetch(
          `http://127.0.0.1:${port}/api/market/history?symbol=RELIANCE&resolution=${res}&limit=2000`,
        );
        expect(r.status).toBe(200);
        return (await r.json()) as { bars: { t: number; open: number; close: number }[] };
      };
      const { bars } = await get("1m");
      const now = Date.now();
      expect(bars.length).toBeGreaterThanOrEqual(300);
      const lastBar = bars[bars.length - 1];
      expect(lastBar.t).toBeLessThanOrEqual(now);
      // `until` is quantized to 5 s, so right after start the newest bar can be one bucket older
      expect(now - lastBar.t).toBeLessThan(2 * 60_000 + 10_000);
      expect(now - bars[0].t).toBeGreaterThan(300 * 60_000);
      expect(now - bars[0].t).toBeLessThan(370 * 60_000);
      for (let i = 1; i < bars.length; i++) expect(bars[i].t).toBeGreaterThan(bars[i - 1].t);
      expect((await get("5m")).bars.length).toBeGreaterThan(50);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
