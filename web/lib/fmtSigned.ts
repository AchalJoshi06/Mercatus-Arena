import { fmtInr } from "./api";

/** Signed rupee amount with the sign before the symbol, e.g. "+₹1,250.00" / "−₹80.00". */
export function fmtSignedInr(n: number, d = 2): string {
  const v = Number.isFinite(n) ? n : 0;
  const rounded = Number(Math.abs(v).toFixed(d));
  const sign = v < 0 && rounded !== 0 ? "−" : "+";
  return `${sign}${fmtInr(rounded, d)}`;
}

export function fmtSignedPct(n: number, d = 2): string {
  const v = Number.isFinite(n) ? n : 0;
  const rounded = Number(Math.abs(v).toFixed(d));
  return `${v < 0 && rounded !== 0 ? "−" : "+"}${rounded.toFixed(d)}%`;
}

export const toneClass = (n: number) => (n > 0 ? "text-buy" : n < 0 ? "text-sell" : "text-ink");
