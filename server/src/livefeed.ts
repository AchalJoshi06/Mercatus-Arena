// Live price source: generates prices on the spot instead of replaying a
// preloaded dataset. The default SyntheticPriceSource ports the per-second
// model of scripts/gen-nse-dataset.ts (momentum, regime drift, U-shaped
// intraday vol, liquidity shocks) to a variable time step. A real market-data
// feed can be plugged in later by implementing PriceSource.

import { personalityFor } from "./personality.js";
import { istDayKey, istDayStart } from "./sessions.js";

export interface PriceRow {
  symbol: string;
  price: number;
  volume: number;
}

export interface PriceSource {
  /** (Re)start the source from the given prices; clears all model state. */
  init(symbols: string[], seedPrices: Record<string, number>, nowMs?: number): void;
  /** One price row per symbol, or [] if no new step is due at nowMs. */
  step(nowMs: number): PriceRow[];
}

export interface BackfillTick {
  t: number;
  symbol: string;
  price: number;
  volume: number;
}

const DAY_MS = 86_400_000;
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
// prices live on a Rs 0.05 tick grid
const tick05 = (p: number) => Math.round(p * 20) / 20;

export const liveConfig = {
  stepMs: Number(process.env.LIVE_STEP_MS ?? 1000),
  backfillMinutes: Number(process.env.LIVE_BACKFILL_MINUTES ?? 360),
  backfillSpacingMs: Number(process.env.LIVE_BACKFILL_SPACING_MS ?? 60_000),
};

interface SymState {
  p: number; // unrounded model price
  m: number; // momentum (per-second return)
  so: number; // revertible part of recent liquidity shocks
  dayOpen: number;
  dayKey: string;
}

export interface SyntheticOpts {
  stepMs?: number;
  /** Largest dt a single step may integrate (a pause/restart must not jump). */
  maxDtMs?: number;
  rng?: () => number;
}

export class SyntheticPriceSource implements PriceSource {
  private st = new Map<string, SymState>();
  private lastStepMs = 0;
  private stepMs: number;
  private maxDtMs: number;
  private rng: () => number;

  constructor(opts: SyntheticOpts = {}) {
    this.stepMs = opts.stepMs ?? liveConfig.stepMs;
    this.maxDtMs = opts.maxDtMs ?? this.stepMs * 5;
    this.rng = opts.rng ?? Math.random;
  }

  private gauss(): number {
    const u1 = Math.max(this.rng(), 1e-12);
    const u2 = this.rng();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  init(symbols: string[], seedPrices: Record<string, number>, nowMs = Date.now()) {
    this.st.clear();
    this.lastStepMs = nowMs;
    const dk = istDayKey(nowMs);
    for (const s of symbols) {
      const p = seedPrices[s];
      if (!(p > 0)) continue;
      this.st.set(s, { p, m: 0, so: 0, dayOpen: p, dayKey: dk });
    }
  }

  step(nowMs: number): PriceRow[] {
    const elapsed = nowMs - this.lastStepMs;
    if (elapsed < this.stepMs) return [];
    this.lastStepMs = nowMs;
    const dt = Math.min(elapsed, this.maxDtMs) / 1000;
    const sq = Math.sqrt(dt);
    const dk = istDayKey(nowMs);
    const u = (nowMs - istDayStart(nowMs)) / DAY_MS;
    const volU = 1.35 - 0.7 * Math.sin(Math.PI * u); // U-shaped intraday curve
    const out: PriceRow[] = [];

    for (const [symbol, s] of this.st) {
      const pers = personalityFor(symbol);
      const regime = Math.sin((nowMs / 1000) * ((2 * Math.PI) / pers.periodSec) + pers.phase);
      if (s.dayKey !== dk) {
        s.dayKey = dk;
        s.dayOpen = s.p; // 24/7: each day continues from the previous close
      }

      // Momentum autocorrelation: produces natural multi-bar waves, swings, wicks
      const impulse = this.gauss() * 0.000004 * pers.vol * volU * sq;
      s.m = s.m * Math.pow(0.94, dt) + impulse;

      // Return = momentum + random walk step + regime drift
      const ret =
        s.m * dt +
        this.gauss() * 0.00006 * pers.vol * volU * sq +
        pers.drift * regime * 0.0015 * dt;
      s.p *= 1 + ret;

      // Soft pull toward day open
      s.p += (s.dayOpen - s.p) * (1 - Math.pow(1 - 0.00003, dt));

      // Occasional liquidity sweep / intraday shock (half of it mean-reverts)
      if (this.rng() < (3 / 86400) * dt) {
        const x = (this.rng() < 0.5 ? -1 : 1) * (0.003 + this.rng() * 0.005);
        s.p *= 1 + x;
        s.so += x * 0.5;
      }
      if (s.so !== 0) {
        const rev = s.so * Math.min(1, dt / 45);
        s.p *= 1 - rev;
        s.so -= rev;
        if (Math.abs(s.so) < 1e-6) s.so = 0;
      }

      // Daily circuit band (±10%)
      s.p = clamp(s.p, s.dayOpen * 0.9, s.dayOpen * 1.1);

      // Volume correlated with price return magnitude and activity
      const moveMagnitude = (Math.abs(ret) / dt) * 1000;
      const baseVol = Math.round(
        350 * volU * (1 + moveMagnitude * 3) * Math.exp(0.5 * this.gauss()) * dt,
      );
      out.push({ symbol, price: Math.max(0.05, tick05(s.p)), volume: clamp(baseVol, 25, 15_000) });
    }
    return out;
  }
}

/**
 * History BEFORE the live start: simulates the model forward in time over
 * [endMs - minutes, endMs] on a coarse step, samples it every spacingMs and
 * rescales each symbol's path so the last sample equals its seed price exactly
 * (charts are continuous into the live tape).
 */
export function generateBackfill(
  seedPrices: Record<string, number>,
  endMs: number,
  opts: { minutes?: number; spacingMs?: number; rng?: () => number } = {},
): BackfillTick[] {
  const minutes = opts.minutes ?? liveConfig.backfillMinutes;
  const spacingMs = Math.max(1000, opts.spacingMs ?? liveConfig.backfillSpacingMs);
  if (!(minutes > 0)) return [];
  const symbols = Object.keys(seedPrices);
  const startMs = endMs - minutes * 60_000;
  const simStep = Math.min(spacingMs, 5000);
  const src = new SyntheticPriceSource({ stepMs: simStep, maxDtMs: simStep, rng: opts.rng });
  src.init(symbols, seedPrices, startMs);

  const samples = new Map<string, { t: number; price: number; volume: number }[]>();
  for (const s of symbols) samples.set(s, []);
  const acc = new Map<string, number>(); // volume accumulated since the last sample
  let nextSample = startMs + spacingMs;
  const last = new Map<string, number>();
  for (let t = startMs + simStep; t <= endMs; t += simStep) {
    for (const r of src.step(t)) {
      acc.set(r.symbol, (acc.get(r.symbol) ?? 0) + r.volume);
      last.set(r.symbol, r.price);
    }
    if (t >= nextSample || t + simStep > endMs) {
      const ts = t + simStep > endMs ? endMs : nextSample;
      for (const s of symbols) {
        const price = last.get(s);
        if (price === undefined) continue;
        samples.get(s)!.push({ t: ts, price, volume: acc.get(s) ?? 0 });
        acc.set(s, 0);
      }
      nextSample = ts + spacingMs;
    }
  }

  const out: BackfillTick[] = [];
  for (const s of symbols) {
    const arr = samples.get(s)!;
    if (!arr.length) continue;
    const k = seedPrices[s] / arr[arr.length - 1].price;
    arr.forEach((a, i) => {
      const price = i === arr.length - 1 ? seedPrices[s] : Math.max(0.05, tick05(a.price * k));
      out.push({ t: a.t, symbol: s, price, volume: a.volume });
    });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}
