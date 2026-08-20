import { describe, it, expect } from "vitest";
import { query } from "../src/db.js";
import { migrate } from "../src/schema.js";
import { generateSyntheticDataset } from "../src/generator.js";
import { EventEngine } from "../src/engine.js";
import { config } from "../src/config.js";

async function freshEngine(symbols: string[], minutes: number) {
  // Baseline: keep the auto-crash scheduler out of every test unless a
  // test explicitly opts in, so stale timers from earlier engines cannot
  // fire crashes into other tests' windows.
  config.crash.auto = false;
  await query(
    `truncate live_prices, market_state, dataset_ticks, market_datasets
     restart identity cascade`,
  );
  await query(
    `update event_config set state = 'PRE_LAUNCH', paused = false,
            leaderboard_frozen = false, credentials_revealed = false,
            tick_count = 0, flash_shock = 0, flash_symbols = '', flash_decay = 0.9,
            replay_speed = 1,
            event_started_at = null, scheduled_end_at = null,
            leaderboard_freeze_at = null, api_freeze_at = null
     where id = true`,
  );
  await generateSyntheticDataset({
    symbols,
    durationMinutes: minutes,
    spacingMs: 1000,
    seed: 1,
  });
  const engine = new EventEngine();
  await engine.init();
  return engine;
}

describe("EventEngine", () => {
  it("advances replay time based on wall clock x replay speed", async () => {
    const engine = await freshEngine(["TST"], 60);
    expect(engine.getStatus().symbols).toContain("TST");
    expect(engine.getStatus().state).toBe("PRE_LAUNCH");

    await engine.startEvent({
      startCapital: 100_000,
      eventMinutes: 10,
      blackoutMinutes: 1,
      apiFreezeMinutes: 1,
    });
    await query(`update event_config set replay_speed = 60 where id = true`);
    await engine.reloadConfig();

    await new Promise((r) => setTimeout(r, 150));
    await engine.tick();

    expect(engine.getStatus().state).toBe("ACTIVE_MARKET");
    expect(engine.price("TST")).toBeGreaterThan(0);
    const t = await query(`select tick_count from event_config where id = true`);
    expect(Number(t.rows[0].tick_count)).toBeGreaterThan(0);
  });

  it("freezes the leaderboard when blackout time passes", async () => {
    const engine = await freshEngine(["TST"], 60);
    await engine.startEvent({
      startCapital: 100_000,
      eventMinutes: 10,
      blackoutMinutes: 1,
      apiFreezeMinutes: 1,
    });
    await query(
      `update event_config set leaderboard_freeze_at = now() - interval '1 second' where id = true`,
    );
    await engine.reloadConfig();
    await engine.tick();
    const cfg = await query(
      `select leaderboard_frozen from event_config where id = true`,
    );
    expect(cfg.rows[0].leaderboard_frozen).toBe(true);
  });

  it("concludes when the dataset end is reached", async () => {
    const engine = await freshEngine(["TST"], 1);
    await engine.startEvent({
      startCapital: 100_000,
      eventMinutes: 10,
      blackoutMinutes: 1,
      apiFreezeMinutes: 1,
    });
    await query(`update event_config set replay_speed = 1000 where id = true`);
    await engine.reloadConfig();
    await new Promise((r) => setTimeout(r, 200));
    await engine.tick();
    expect(engine.getStatus().state).toBe("EVENT_CONCLUDED");
  });

  it("concludes once scheduled_end passes while API_FROZEN", async () => {
    const engine = await freshEngine(["TST"], 60);
    await engine.startEvent({
      startCapital: 100_000,
      eventMinutes: 10,
      blackoutMinutes: 1,
      apiFreezeMinutes: 1,
    });
    await query(
      `update event_config set state = 'API_FROZEN',
              api_freeze_at = now() - interval '2 seconds',
              scheduled_end_at = now() - interval '1 second'
       where id = true`,
    );
    await engine.reloadConfig();

    await engine.tick();
    expect(engine.getStatus().state).toBe("EVENT_CONCLUDED");
  });

  it("stays API_FROZEN when scheduled_end has not passed", async () => {
    const engine = await freshEngine(["TST"], 60);
    await engine.startEvent({
      startCapital: 100_000,
      eventMinutes: 10,
      blackoutMinutes: 1,
      apiFreezeMinutes: 1,
    });
    await query(
      `update event_config set state = 'API_FROZEN',
              api_freeze_at = now() - interval '2 seconds',
              scheduled_end_at = now() + interval '1 hour'
       where id = true`,
    );
    await engine.reloadConfig();

    await engine.tick();
    expect(engine.getStatus().state).toBe("API_FROZEN");
  });

  it("concludes a paused event once scheduled_end passes and freezes the leaderboard", async () => {
    const engine = await freshEngine(["TST"], 60);
    await engine.startEvent({
      startCapital: 100_000,
      eventMinutes: 10,
      blackoutMinutes: 1,
      apiFreezeMinutes: 1,
    });
    await query(
      `update event_config set paused = true,
              scheduled_end_at = now() - interval '1 second'
       where id = true`,
    );
    await engine.reloadConfig();

    await engine.tick();
    expect(engine.getStatus().state).toBe("EVENT_CONCLUDED");
    const cfg = await query(
      `select leaderboard_frozen from event_config where id = true`,
    );
    expect(cfg.rows[0].leaderboard_frozen).toBe(true);
  });

  it("clamps flash crashes at the circuit band and produces 5-level depth", async () => {
    // This test drives its own flash crash; auto scheduler stays off.
    const engine = await freshEngine(["TST"], 60);
    await engine.startEvent({
      startCapital: 100_000,
      eventMinutes: 10,
      blackoutMinutes: 1,
      apiFreezeMinutes: 1,
    });
    await query(
      `update event_config set replay_speed = 60, circuit_pct = 0.05 where id = true`,
    );
    await engine.reloadConfig();
    await new Promise((r) => setTimeout(r, 150));
    await engine.tick();
    const open = engine.getStatus().open["TST"];
    expect(open).toBeGreaterThan(0);

    await engine.triggerFlashCrash(-0.2, ["TST"]);
    let got: "upper" | "lower" | undefined;
    for (let i = 0; i < 60 && !got; i++) {
      await new Promise((r) => setTimeout(r, 50));
      got = engine.getStatus().circuit["TST"];
    }
    expect(got).toBe("lower");
    const status = engine.getStatus();
    const band = status.bands["TST"];
    expect(engine.price("TST")).toBeCloseTo(open * (1 - band), 3);

    const depth = engine.getDepth();
    const book = depth.books["TST"];
    expect(book).toBeDefined();
    expect(book.bids).toHaveLength(5);
    expect(book.asks).toHaveLength(5);
    expect(book.asks[0].price).toBeGreaterThan(book.bids[0].price);
    expect(book.bids.every((l) => l.size >= 0)).toBe(true);
  });

  it("auto-fires a scheduled crash inside the active window", async () => {
    // Deterministic schedule: every window rolls exactly one shock of ±3%.
    config.crash.probNone = 0;
    config.crash.probTwo = 0;
    config.crash.windowSeconds = 10;
    config.crash.shockMinPct = 0.03;
    config.crash.shockMaxPct = 0.03;

    const engine = await freshEngine(["TST"], 60);
    await engine.setCrashAuto(true);
    await engine.startEvent({
      startCapital: 100_000,
      eventMinutes: 10,
      blackoutMinutes: 1,
      apiFreezeMinutes: 1,
    });
    // 9 minutes in: far past any random offset inside the 10s window.
    await query(
      `update event_config set event_started_at = now() - interval '9 minutes' where id = true`,
    );
    await engine.reloadConfig();

    await engine.tick();

    const cfg = await query(`select flash_shock from event_config where id = true`);
    const shock = Number(cfg.rows[0].flash_shock);
    // 0.03 fired then decayed once by flash_decay (0.9) during the tick.
    expect(shock).not.toBe(0);
    expect(Math.abs(shock)).toBeGreaterThan(0.02);
    expect(Math.abs(shock)).toBeLessThanOrEqual(0.03);
    expect(engine.getCrashConfig().nextCrashInSec).toBeNull();
  });

  it("auto crash hits only a small subset of symbols, not the whole market", async () => {
    config.crash.probNone = 0;
    config.crash.probTwo = 0;
    config.crash.windowSeconds = 10;
    config.crash.shockMinPct = 0.03;
    config.crash.shockMaxPct = 0.03;

    const engine = await freshEngine(["TST", "AAA", "BBB"], 60);
    await engine.setCrashAuto(true);
    await engine.startEvent({
      startCapital: 100_000,
      eventMinutes: 10,
      blackoutMinutes: 1,
      apiFreezeMinutes: 1,
    });
    await query(
      `update event_config set event_started_at = now() - interval '9 minutes' where id = true`,
    );
    await engine.reloadConfig();

    await engine.tick();

    const cfg = await query(
      `select flash_symbols from event_config where id = true`,
    );
    const flashed = cfg.rows[0].flash_symbols
      .split(",")
      .map((s: string) => s.trim())
      .filter(Boolean);
    expect(flashed.length).toBe(1);
    expect(flashed.length).toBeLessThan(3);
  });

  it("does not crash the same symbol in consecutive windows", async () => {
    config.crash.probNone = 0;
    config.crash.probTwo = 0;
    config.crash.windowSeconds = 10;
    config.crash.shockMinPct = 0.03;
    config.crash.shockMaxPct = 0.03;

    const engine = await freshEngine(["TST", "AAA", "BBB"], 60);
    await engine.setCrashAuto(true);
    await engine.startEvent({
      startCapital: 100_000,
      eventMinutes: 10,
      blackoutMinutes: 1,
      apiFreezeMinutes: 1,
    });
    // First window: 9 minutes in (window idx 54).
    await query(
      `update event_config set event_started_at = now() - interval '9 minutes' where id = true`,
    );
    await engine.reloadConfig();
    await engine.tick();
    const first = await query(
      `select flash_symbols from event_config where id = true`,
    );
    const firstSymbols = first.rows[0].flash_symbols
      .split(",")
      .map((s: string) => s.trim())
      .filter(Boolean);
    expect(firstSymbols.length).toBe(1);

    // Next window: 9m15s in (window idx 55, adjacent — must not repeat).
    await query(
      `update event_config set event_started_at = now() - interval '9 minutes 15 seconds' where id = true`,
    );
    await engine.reloadConfig();
    await engine.tick();
    const second = await query(
      `select flash_symbols from event_config where id = true`,
    );
    const secondSymbols = second.rows[0].flash_symbols
      .split(",")
      .map((s: string) => s.trim())
      .filter(Boolean);
    expect(secondSymbols.length).toBe(1);
    expect(secondSymbols[0]).not.toBe(firstSymbols[0]);
  });

  it("does not fire crashes when auto mode is disabled", async () => {
    const engine = await freshEngine(["TST"], 60);
    await engine.startEvent({
      startCapital: 100_000,
      eventMinutes: 10,
      blackoutMinutes: 1,
      apiFreezeMinutes: 1,
    });
    await engine.setCrashAuto(false);
    await query(
      `update event_config set event_started_at = now() - interval '9 minutes' where id = true`,
    );
    await engine.reloadConfig();

    await engine.tick();

    const cfg = await query(`select flash_shock from event_config where id = true`);
    expect(Number(cfg.rows[0].flash_shock)).toBe(0);
    expect(engine.getCrashConfig().auto).toBe(false);
  });
});

await migrate();
