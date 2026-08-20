import { describe, it, expect } from "vitest";
import { personalityFor } from "../src/personality.js";

describe("personalityFor", () => {
  it("is deterministic for the same symbol", () => {
    const a = personalityFor("BQ");
    const b = personalityFor("BQ");
    expect(a).toEqual(b);
  });

  it("stays within sane bounds", () => {
    for (const s of ["A", "BQ", "CLP", "EB", "EM", "F", "GSEK", "IXRE"]) {
      const p = personalityFor(s);
      expect(Math.abs(p.drift)).toBeLessThanOrEqual(0.0003);
      expect(p.vol).toBeGreaterThanOrEqual(0.35);
      expect(p.vol).toBeLessThanOrEqual(2.75);
      expect(p.periodSec).toBeGreaterThanOrEqual(900);
      expect(p.periodSec).toBeLessThanOrEqual(3600);
      expect(p.phase).toBeGreaterThanOrEqual(0);
      expect(p.phase).toBeLessThan(Math.PI * 2);
    }
  });

  it("differentiates symbols (up vs down vs flat, low vs high vol)", () => {
    const syms = Array.from({ length: 30 }, (_, i) => `S${String(i).padStart(3, "0")}`);
    const ps = syms.map((s) => personalityFor(s));
    expect(new Set(ps.map((p) => p.drift)).size).toBeGreaterThan(10);
    expect(ps.some((p) => p.drift > 0.00015)).toBe(true);
    expect(ps.some((p) => p.drift < -0.00015)).toBe(true);
    expect(ps.some((p) => Math.abs(p.drift) < 0.00005)).toBe(true);
    expect(Math.max(...ps.map((p) => p.vol))).toBeGreaterThan(
      Math.min(...ps.map((p) => p.vol)) * 2,
    );
  });
});
