import { describe, it, expect } from "vitest";
import { SYMBOLS } from "../src/symbols.js";
import { SyntheticPriceSource, generateBackfill } from "../src/livefeed.js";
import { datasetTimeAt, replayDatasetTime } from "../src/scoring.js";

function seededRng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const seed = Object.fromEntries(SYMBOLS);
const names = SYMBOLS.map(([s]) => s);

describe("SyntheticPriceSource", () => {
  it("emits one positive row per symbol per step and honours stepMs", () => {
    const src = new SyntheticPriceSource({ rng: seededRng(1) });
    const t0 = Date.UTC(2026, 5, 1, 6, 0, 0);
    src.init(names, seed, t0);
    expect(src.step(t0 + 100)).toEqual([]); // not due yet
    const rows = src.step(t0 + 1000);
    expect(rows.map((r) => r.symbol).sort()).toEqual([...names].sort());
    for (const r of rows) {
      expect(r.price).toBeGreaterThan(0);
      expect(r.volume).toBeGreaterThanOrEqual(25);
      expect(Math.abs(r.price / seed[r.symbol] - 1)).toBeLessThan(0.05);
    }
  });

  it("caps dt so a long pause never produces a huge jump", () => {
    const src = new SyntheticPriceSource({ rng: seededRng(2) });
    const t0 = Date.UTC(2026, 5, 1, 6, 0, 0);
    src.init(names, seed, t0);
    const rows = src.step(t0 + 3 * 3_600_000); // 3 h pause
    for (const r of rows) {
      expect(Math.abs(r.price / seed[r.symbol] - 1)).toBeLessThan(0.02);
    }
  });

  it("stays positive and inside the ±10% day band over a long run", () => {
    const src = new SyntheticPriceSource({ rng: seededRng(3) });
    const t0 = Date.UTC(2026, 5, 1, 0, 0, 0);
    src.init(names, seed, t0);
    let moved = 0;
    for (let k = 1; k <= 3 * 3600; k++) {
      for (const r of src.step(t0 + k * 1000)) {
        expect(r.price).toBeGreaterThan(0);
        expect(r.price).toBeGreaterThanOrEqual(seed[r.symbol] * 0.9 - 0.05);
        expect(r.price).toBeLessThanOrEqual(seed[r.symbol] * 1.1 + 0.05);
        if (r.price !== seed[r.symbol]) moved++;
      }
    }
    expect(moved).toBeGreaterThan(1000);
  });
});

describe("generateBackfill", () => {
  it("produces spaced history ending exactly at the seed prices", () => {
    const end = Date.UTC(2026, 5, 1, 12, 0, 0);
    const ticks = generateBackfill(seed, end, { minutes: 360, spacingMs: 60_000, rng: seededRng(4) });
    expect(ticks.length).toBe(360 * names.length);
    expect(Math.min(...ticks.map((t) => t.t))).toBe(end - 359 * 60_000);
    expect(Math.max(...ticks.map((t) => t.t))).toBe(end);
    for (const s of names) {
      const mine = ticks.filter((t) => t.symbol === s);
      expect(mine[mine.length - 1].price).toBe(seed[s]);
      expect(mine.every((t) => t.price > 0)).toBe(true);
    }
  });

  it("returns nothing when backfill is disabled", () => {
    expect(generateBackfill(seed, Date.now(), { minutes: 0 })).toEqual([]);
  });
});

describe("scoring dataset-time mapping", () => {
  const ds = { start_t: 1_000, end_t: 61_000, live_start_t: 11_000 };
  it("live datasets map wall-clock ms to themselves", () => {
    const wall = Date.now();
    expect(datasetTimeAt({ ...ds, mode: "live" }, wall, wall - 5000, 60)).toBe(wall);
  });
  it("replay datasets keep the looping replay mapping", () => {
    expect(datasetTimeAt({ ...ds, mode: "replay" }, 30_000, 10_000, 1)).toBe(
      replayDatasetTime(11_000, 61_000, 20_000, 1),
    );
  });
});
