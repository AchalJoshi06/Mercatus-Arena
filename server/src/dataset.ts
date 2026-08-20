import { query } from "./db.js";

export interface ParsedTick {
  t: number;
  symbol: string;
  price: number;
  volume: number;
}

function toEpochMs(value: string): number {
  const v = value.trim();
  if (/^\d+$/.test(v)) {
    const n = Number(v);
    return n < 1e12 ? n * 1000 : n;
  }
  const d = Date.parse(v);
  if (Number.isNaN(d)) throw new Error(`invalid timestamp: ${value}`);
  return d;
}

export function parseDatasetCsv(text: string): ParsedTick[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) throw new Error("empty dataset");
  const header = lines[0]
    .toLowerCase()
    .split(/[,;\t]/)
    .map((h) => h.trim());

  const col = (names: string[]) => {
    const idx = header.findIndex((h) => names.some((n) => h === n));
    if (idx === -1) throw new Error(`missing column: ${names.join("/")}`);
    return idx;
  };
  const cT = col(["t", "timestamp", "time"]);
  const cSym = col(["symbol", "ticker"]);
  const cP = col(["price", "close", "mid"]);
  let cV = header.findIndex((h) => ["volume", "vol", "qty"].includes(h));

  const out: ParsedTick[] = [];
  for (const line of lines.slice(1)) {
    const parts = line.split(/[,;\t]/);
    if (parts.length < 3) continue;
    const t = toEpochMs(parts[cT]);
    const symbol = parts[cSym].trim().toUpperCase();
    const price = Number(parts[cP]);
    if (!Number.isFinite(price) || price <= 0) continue;
    const volume = cV >= 0 && Number.isFinite(Number(parts[cV]))
      ? Number(parts[cV])
      : 0;
    out.push({ t, symbol, price, volume });
  }
  if (out.length === 0) throw new Error("no valid rows parsed");
  out.sort((a, b) => a.t - b.t || a.symbol.localeCompare(b.symbol));
  return out;
}

export async function ingestDataset(
  name: string,
  ticks: ParsedTick[],
  liveStartMs: number | null = null,
): Promise<number> {
  const symbols = [...new Set(ticks.map((t) => t.symbol))].sort();
  let startT = ticks[0].t;
  let endT = ticks[0].t;
  for (const tk of ticks) {
    if (tk.t < startT) startT = tk.t;
    if (tk.t > endT) endT = tk.t;
  }
  const liveStart =
    liveStartMs != null && liveStartMs > startT && liveStartMs < endT
      ? Math.floor(liveStartMs)
      : null;
  const { rows } = await query(
    `insert into market_datasets (name, row_count, symbol_list, start_t, end_t, live_start_t, is_active)
     values ($1, $2, $3, $4, $5, $6, true)
     returning dataset_id`,
    [name, ticks.length, symbols, startT, endT, liveStart],
  );
  const datasetId = Number(rows[0].dataset_id);
  await query(
    `update market_datasets set is_active = false where dataset_id <> $1`,
    [datasetId],
  );

  const BATCH = 5000;
  for (let i = 0; i < ticks.length; i += BATCH) {
    const chunk = ticks.slice(i, i + BATCH);
    const vals: unknown[] = [];
    chunk.forEach((tk, j) => {
      vals.push(datasetId, i + j + 1, tk.t, tk.symbol, tk.price, tk.volume);
    });
    const cols = 6;
    const placeholders = Array.from(
      { length: chunk.length },
      (_, i) =>
        `(${Array.from(
          { length: cols },
          (_, j) => `$${i * cols + j + 1}`,
        ).join(",")})`,
    ).join(",");
    await query(
      `insert into dataset_ticks (dataset_id, seq, t, symbol, price, volume)
       values ${placeholders}`,
      vals,
    );
  }

  await query(`truncate live_prices, market_state`);
  await query(`insert into market_state (dataset_id, last_t) values ($1, $2)`, [
    datasetId,
    liveStart ?? 0,
  ]);
  for (const symbol of symbols) {
    const first = ticks.find((t) => t.symbol === symbol && (liveStart == null || t.t >= liveStart)) ??
      ticks.find((t) => t.symbol === symbol)!;
    await query(
      `insert into live_prices (symbol, price, prev_price)
       values ($1, $2, $2)
       on conflict (symbol) do update
       set price = excluded.price, prev_price = excluded.prev_price`,
      [symbol, first.price],
    );
  }
  return datasetId;
}
