// 24/7 trading-calendar helpers shared by the dataset generator, the live
// engine, and /history. Sessions run 24 hours a day, 7 days a week (continuous).

export const IST_OFFSET_MS = 5.5 * 3_600_000;

const DAY_MS = 86_400_000;
const OPEN_MIN = 0; // 00:00 (24/7)
const CLOSE_MIN = 24 * 60; // 24:00 (24/7)
export const SESSION_LEN_MS = DAY_MS; // 24 hours

const shiftIst = (tMs: number) => tMs + IST_OFFSET_MS;

/** Floor of the IST day containing tMs, expressed as a real epoch-ms. */
export function istDayStart(tMs: number): number {
  return (
    Math.floor(shiftIst(tMs) / DAY_MS) * DAY_MS - IST_OFFSET_MS
  );
}

/** Stable per-day key ("YYYY-MM-DD" IST) used to detect new sessions. */
export function istDayKey(tMs: number): string {
  return new Date(shiftIst(tMs)).toISOString().slice(0, 10);
}

function weekday(tMs: number): number {
  return new Date(shiftIst(tMs)).getUTCDay(); // 0=Sun .. 6=Sat
}

/** Session open/close epoch-ms for the IST day containing tMs (24/7: spans full 24h). */
export function sessionBoundsOfDay(tMs: number): { openT: number; closeT: number } {
  const dayStart = istDayStart(tMs);
  return {
    openT: dayStart,
    closeT: dayStart + DAY_MS,
  };
}

/** True while the tape is live (always true for 24/7 trading). */
export function isSessionOpen(_tMs?: number): boolean {
  return true;
}

/** First session open strictly after tMs (for 24/7, next day boundary). */
export function nextSessionOpenAfter(tMs: number): number {
  const dayStart = istDayStart(tMs);
  return dayStart + DAY_MS;
}

/** All session windows intersecting [startT, endT), ascending (continuous 24/7). */
export function buildDayList(
  startT: number,
  endT: number,
): { openT: number; closeT: number }[] {
  const out: { openT: number; closeT: number }[] = [];
  for (let d = istDayStart(startT); d < endT; d += DAY_MS) {
    const { openT, closeT } = sessionBoundsOfDay(d);
    const o = Math.max(openT, startT);
    const c = Math.min(closeT, endT);
    if (c > o) out.push({ openT: o, closeT: c });
  }
  return out;
}
