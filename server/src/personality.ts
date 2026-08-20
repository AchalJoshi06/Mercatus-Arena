export interface Personality {
  drift: number;
  vol: number;
  periodSec: number;
  phase: number;
}

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

function hashSymbol(symbol: string): number {
  let h = 0;
  for (const c of symbol) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}

const cache = new Map<string, Personality>();

/**
 * Deterministic per-symbol trading character, stable across restarts:
 * - drift:        per-second return bias (±0.0003), so some symbols trend
 *                 up, some down, some sideways over the session.
 * - vol:          volatility multiplier (0.35..2.75), so some symbols are
 *                 smooth/sleepy while others swing wide.
 * - periodSec:    regime cycle (15..60 min); a sine of this period makes the
 *                 symbol alternate between trending and ranging phases.
 * - phase:        offsets the regime sine so symbols are out of sync.
 */
export function personalityFor(symbol: string): Personality {
  const hit = cache.get(symbol);
  if (hit) return hit;
  const rng = mulberry32(hashSymbol(symbol));
  const p: Personality = {
    drift: (rng() - 0.5) * 2 * 0.0003,
    vol: 0.35 + rng() * rng() * 2.4,
    periodSec: 900 + rng() * 2700,
    phase: rng() * Math.PI * 2,
  };
  cache.set(symbol, p);
  return p;
}
