import { query } from "./db.js";
import { broadcast, setHelloProvider } from "./ws.js";
import { config, type EventState } from "./config.js";
import { personalityFor } from "./personality.js";

interface EventConfigRow {
  state: EventState;
  paused: boolean;
  start_capital: string;
  replay_speed: string;
  noise_sigma: string;
  volatility_multiplier: string;
  flash_shock: string;
  flash_symbols: string;
  flash_decay: string;
  circuit_pct: string;
  credentials_revealed: boolean;
  leaderboard_frozen: boolean;
  event_started_at: string | null;
  scheduled_end_at: string | null;
  leaderboard_freeze_at: string | null;
  api_freeze_at: string | null;
  tick_count: string;
}

interface DatasetRow {
  dataset_id: number;
  name: string;
  row_count: number;
  symbol_list: string[];
  start_t: number;
  end_t: number;
  live_start_t: number | null;
}

function toDatasetRow(raw: {
  dataset_id: string | number;
  name: string;
  row_count: string | number;
  symbol_list: string[];
  start_t: string | number;
  end_t: string | number;
  live_start_t?: string | number | null;
}): DatasetRow {
  // pg returns bigint columns as strings; normalize to numbers so
  // start_t + elapsed performs arithmetic, not string concatenation.
  return {
    dataset_id: Number(raw.dataset_id),
    name: raw.name,
    row_count: Number(raw.row_count),
    symbol_list: raw.symbol_list,
    start_t: Number(raw.start_t),
    end_t: Number(raw.end_t),
    live_start_t:
      raw.live_start_t != null && Number(raw.live_start_t) > 0
        ? Number(raw.live_start_t)
        : null,
  };
}

export interface LiveTick {
  symbol: string;
  price: number;
  prev: number;
}

function gaussian(): number {
  const u1 = Math.max(Math.random(), 1e-12);
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

const round = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d;

function hashStr(s: string): number {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}

export interface BookLevel {
  price: number;
  size: number;
}

export interface Book {
  bids: BookLevel[];
  asks: BookLevel[];
}

export class EventEngine {
  private cfg!: EventConfigRow;
  private dataset: DatasetRow | null = null;
  private lastT = 0;
  private startWallMs = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private prices = new Map<string, number>();
  private open = new Map<string, number>();
  private wiggle = new Map<string, number>();
  private circuit = new Map<string, "upper" | "lower">();
  private books = new Map<string, Book>();
  private historyBuf: { t: number; prices: Record<string, number> }[] = [];
  private maxRowsPerTick = Number(process.env.MAX_ROWS_PER_TICK ?? 5000);
  private crashAuto = config.crash.auto;
  private crashWindowIdx = -1;
  private crashAt: number[] = [];
  private crashWins = new Map<string, number>();

  async init() {
    const res = await query(`select * from event_config where id = true`);
    this.cfg = res.rows[0] as EventConfigRow;

    const ds = await query(
      `select * from market_datasets where is_active = true limit 1`,
    );
    if (ds.rows[0]) {
      this.dataset = toDatasetRow(ds.rows[0] as DatasetRow);
      const ms = await query(
        `select last_t from market_state where dataset_id = $1`,
        [this.dataset.dataset_id],
      );
      this.lastT = Number(ms.rows[0]?.last_t ?? 0);
    }

    const lp = await query(`select symbol, price from live_prices`);
    for (const r of lp.rows) {
      this.prices.set(r.symbol, Number(r.price));
    }

    // Restore wall-clock continuity after a restart mid-event: derive
    // startWallMs from the dataset position so ticks resume, not fast-forward.
    if (
      this.cfg.state === "ACTIVE_MARKET" &&
      !this.cfg.paused &&
      this.dataset &&
      Number(this.cfg.replay_speed) > 0
    ) {
      this.startWallMs =
        Date.now() - (this.lastT - this.dataset.start_t) / Number(this.cfg.replay_speed);
    } else {
      this.startWallMs = Date.now();
    }

    setHelloProvider(() => ({ ...this.getStatus(), history: this.historyBuf }));
    this.startTimer();
  }

  private startTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      void this.tick();
    }, config.tickIntervalMs);
    this.timer.unref?.();
  }

  /**
   * Automatic crash scheduler. Event time is split into fixed windows
   * (default 10 min); each window rolls 0 (3%), 1 (95%) or 2 (2%) shocks
   * placed at random offsets, magnitude ±2%..±4% with the same decay-based
   * recovery as a manual flash crash. Purely in-memory, wall-clock based.
   */
  private scheduleCrashWindow(idx: number) {
    const c = config.crash;
    const r = Math.random();
    let count: number;
    if (r < c.probNone) count = 0;
    else if (r < c.probNone + c.probTwo) count = 2;
    else count = 1;
    this.crashAt = [];
    for (let i = 0; i < count; i++) {
      let off = Math.random() * c.windowSeconds;
      if (i === 1 && this.crashAt.length > 0) {
        const first = this.crashAt[0];
        for (let tries = 0; tries < 50; tries++) {
          off = Math.random() * c.windowSeconds;
          if (Math.abs(off - first) >= 120) break;
        }
      }
      this.crashAt.push(off);
    }
    this.crashWindowIdx = idx;
  }

  /**
   * Picks the symbols for one auto-crash: a small random subset (~3-5% of
   * the market, at least one) so a crash never drags every stock down at
   * once. Symbols that crashed in the previous two windows are skipped so
   * the same stock does not crash back-to-back.
   */
  private pickCrashSymbols(windowIdx: number): string[] {
    const list = this.dataset?.symbol_list ?? [];
    const fresh = list.filter(
      (s) => (this.crashWins.get(s) ?? -Infinity) < windowIdx - 2,
    );
    const pool = fresh.length ? fresh : list;
    const n = Math.max(1, Math.round(pool.length * (0.03 + Math.random() * 0.02)));
    const picked: string[] = [];
    const shuffled = [...pool].sort(() => Math.random() - 0.5);
    for (const s of shuffled) {
      if (picked.length >= n) break;
      picked.push(s);
    }
    for (const s of picked) this.crashWins.set(s, windowIdx);
    return picked;
  }

  private async maybeAutoCrash(nowMs: number) {
    if (!this.crashAuto) return;
    if (this.cfg.state !== "ACTIVE_MARKET" || this.cfg.paused) return;
    const startMs = this.cfg.event_started_at
      ? Date.parse(this.cfg.event_started_at)
      : this.startWallMs;
    if (!Number.isFinite(startMs)) return;
    const elapsedSec = (nowMs - startMs) / 1000;
    if (elapsedSec < 0) return;
    const c = config.crash;
    const idx = Math.floor(elapsedSec / c.windowSeconds);
    if (idx !== this.crashWindowIdx) this.scheduleCrashWindow(idx);
    for (const off of this.crashAt) {
      if (elapsedSec >= off) {
        this.crashAt = this.crashAt.filter((o) => o !== off);
        const size =
          c.shockMinPct + Math.random() * (c.shockMaxPct - c.shockMinPct);
        const shock = round((Math.random() < 0.5 ? -1 : 1) * size, 4);
        try {
          await this.triggerFlashCrash(shock, this.pickCrashSymbols(idx), c.decay);
        } catch {
          // ignore: no valid symbols, etc.
        }
      }
    }
  }

  getCrashConfig() {
    const startMs = this.cfg?.event_started_at
      ? Date.parse(this.cfg.event_started_at)
      : this.startWallMs;
    const elapsedSec = Number.isFinite(startMs)
      ? (Date.now() - startMs) / 1000
      : 0;
    const next =
      this.crashAt.length > 0
        ? Math.max(0, Math.min(...this.crashAt) - elapsedSec)
        : null;
    return {
      auto: this.crashAuto,
      windowSeconds: config.crash.windowSeconds,
      shockMinPct: config.crash.shockMinPct,
      shockMaxPct: config.crash.shockMaxPct,
      nextCrashInSec: next,
    };
  }

  async setCrashAuto(auto: boolean) {
    this.crashAuto = auto;
    if (auto && this.crashAt.length === 0) {
      const startMs = this.cfg?.event_started_at
        ? Date.parse(this.cfg.event_started_at)
        : this.startWallMs;
      if (Number.isFinite(startMs)) {
        const elapsedSec = (Date.now() - startMs) / 1000;
        if (elapsedSec >= 0) {
          this.crashWindowIdx = -1;
          this.scheduleCrashWindow(Math.floor(elapsedSec / config.crash.windowSeconds));
        }
      }
    }
    broadcast({ type: "crash_config", auto: this.crashAuto });
  }

  getStatus() {
    return {
      state: this.cfg.state,
      paused: this.cfg.paused,
      credentialsRevealed: this.cfg.credentials_revealed,
      leaderboardFrozen: this.cfg.leaderboard_frozen,
      tickCount: Number(this.cfg.tick_count),
      startCapital: Number(this.cfg.start_capital),
      replaySpeed: Number(this.cfg.replay_speed),
      volatility: Number(this.cfg.volatility_multiplier),
      flashSymbols: this.cfg.flash_symbols
        ? this.cfg.flash_symbols.split(",")
        : [],
      flashDecay: Number(this.cfg.flash_decay),
      circuitPct: Number(this.cfg.circuit_pct),
      circuit: Object.fromEntries(this.circuit),
      open: Object.fromEntries(this.open),
      bands: Object.fromEntries(
        (this.dataset?.symbol_list ?? []).map((s) => [s, this.symbolBand(s)]),
      ),
      symbols: this.dataset?.symbol_list ?? [],
      prices: Object.fromEntries(this.prices),
      datasetName: this.dataset?.name ?? null,
      datasetId: this.dataset?.dataset_id ?? null,
      datasetStartAt: this.dataset?.start_t ?? null,
      datasetEndAt: this.dataset?.end_t ?? null,
      liveStartAt: this.dataset?.live_start_t ?? null,
      eventStartedAt: this.cfg.event_started_at,
      scheduledEndAt: this.cfg.scheduled_end_at,
      apiFreezeAt: this.cfg.api_freeze_at,
      leaderboardFreezeAt: this.cfg.leaderboard_freeze_at,
      startWallMs: this.startWallMs,
    };
  }

  getDepth() {
    return {
      books: Object.fromEntries(this.books),
      circuit: Object.fromEntries(this.circuit),
      open: Object.fromEntries(this.open),
    };
  }

  private symbolBand(symbol: string): number {
    const base = Number(this.cfg.circuit_pct) || 0.1;
    const factor = [0.5, 1, 2][hashStr(symbol) % 3];
    return Math.min(base * factor, 0.5);
  }

  private tickSize(price: number): number {
    if (price < 50) return 0.05;
    if (price < 100) return 0.1;
    if (price < 200) return 0.2;
    return 0.5;
  }

  private bookFor(symbol: string, price: number): Book {
    const ts = this.tickSize(price);
    const baseSize = 300 + (hashStr(symbol) % 2400);
    const level = (dir: 1 | -1, i: number): BookLevel => ({
      price: round(price + dir * (i + 1) * ts, 4),
      size: Math.max(50, Math.round(baseSize * (0.4 + Math.random() * 1.6) * (1 - i * 0.12))),
    });
    const bids = [0, 1, 2, 3, 4].map((i) => level(-1, i));
    const asks = [0, 1, 2, 3, 4].map((i) => level(1, i));
    return { bids, asks };
  }

  private runSyntheticTrades() {
    if (!this.dataset) return;
    const symbols = this.dataset.symbol_list;
    const n = 1 + Math.floor(Math.random() * 3);
    for (let i = 0; i < n; i++) {
      const s = symbols[Math.floor(Math.random() * symbols.length)];
      const px = this.prices.get(s);
      if (!px) continue;
      const side: "buy" | "sell" = Math.random() < 0.55 ? "buy" : "sell";
      const qty = Math.max(50, Math.round(120 * Math.random() ** 2 * 80));
      const ts = this.tickSize(px);
      let book = this.books.get(s);
      if (!book) book = this.bookFor(s, px);
      const levels = side === "buy" ? book.asks : book.bids;
      let remaining = qty;
      for (const lvl of levels) {
        if (remaining <= 0) break;
        const take = Math.min(remaining, lvl.size);
        lvl.size -= take;
        remaining -= take;
      }
      let newPx: number;
      if (remaining > 0) {
        newPx = round(px + (side === "buy" ? ts : -ts), 4);
      } else {
        newPx = levels[0].price;
      }
      this.prices.set(s, newPx);
      broadcast({
        type: "trade",
        symbol: s,
        side,
        qty,
        price: newPx,
        ts: Date.now(),
      });
    }
  }

  private applyCircuitClamp() {
    if (!this.dataset) return;
    for (const s of this.dataset.symbol_list) {
      const px = this.prices.get(s);
      if (!px) continue;
      const op = this.open.get(s) ?? px;
      const band = this.symbolBand(s);
      const upper = round(op * (1 + band), 4);
      const lower = round(op * (1 - band), 4);
      let side: "upper" | "lower" | null = null;
      if (px > upper) {
        this.prices.set(s, upper);
        side = "upper";
      } else if (px < lower) {
        this.prices.set(s, lower);
        side = "lower";
      }
      const prev = this.circuit.get(s) ?? null;
      if (side !== prev) {
        if (side) this.circuit.set(s, side);
        else this.circuit.delete(s);
        broadcast({
          type: "circuit",
          symbol: s,
          side,
          level: side ? (side === "upper" ? upper : lower) : null,
        });
      }
    }
  }

  async tick() {
    const now = Date.now();

    if (
      this.cfg.leaderboard_freeze_at &&
      now >= Date.parse(this.cfg.leaderboard_freeze_at) &&
      !this.cfg.leaderboard_frozen
    ) {
      await this.freezeLeaderboard();
    }
    if (
      this.cfg.scheduled_end_at &&
      now >= Date.parse(this.cfg.scheduled_end_at) &&
      this.cfg.state !== "EVENT_CONCLUDED"
    ) {
      return this.conclude();
    }
    if (this.cfg.paused) return;
    if (this.cfg.state !== "ACTIVE_MARKET") return;

    if (this.cfg.api_freeze_at && now >= Date.parse(this.cfg.api_freeze_at)) {
      await this.setLocalState("API_FROZEN");
    }

    if (!this.dataset) return;
    await this.maybeAutoCrash(now);

    const elapsedMs = (now - this.startWallMs) * Number(this.cfg.replay_speed);
    const targetT = Math.floor(
      this.dataset.start_t + Math.max(0, elapsedMs),
    );
    if (targetT <= this.lastT) {
      const ratio = Number(this.cfg.replay_speed);
      if (ratio > 0) {
        this.startWallMs =
          Date.now() - (this.lastT - this.dataset.start_t) / ratio;
      }
      return;
    }

    const rows = await query(
      `select t, symbol, price from dataset_ticks
       where dataset_id = $1 and t > $2 and t <= $3
       order by t limit $4`,
      [this.dataset.dataset_id, this.lastT, targetT, this.maxRowsPerTick],
    );

    const sigma =
      Number(this.cfg.noise_sigma) * Number(this.cfg.volatility_multiplier);
    let flash = Number(this.cfg.flash_shock);
    const decay = Math.min(Math.max(Number(this.cfg.flash_decay) || 0.9, 0.05), 0.999);
    const flashSymbols = new Set(
      this.cfg.flash_symbols
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean),
    );

    for (const r of rows.rows) {
      const base = Number(r.price);
      if (!this.open.has(r.symbol)) this.open.set(r.symbol, base);
      const pers = personalityFor(r.symbol);
      const tSec = r.t / 1000;
      const regime = Math.sin(
        (tSec * 2 * Math.PI) / pers.periodSec + pers.phase,
      );
      const noise = base * (1 + gaussian() * sigma * pers.vol);
      const applyFlash =
        flashSymbols.size === 0 || flashSymbols.has(r.symbol);
      const w =
        (this.wiggle.get(r.symbol) ?? 0) * 0.92 + gaussian() * 0.0012 * pers.vol;
      this.wiggle.set(r.symbol, w);
      this.prices.set(
        r.symbol,
        round(
          noise *
            (1 + pers.drift * regime) *
            (applyFlash ? 1 + flash : 1) *
            (1 + w),
          4,
        ),
      );
    }

    const caughtUp = rows.rows.length < this.maxRowsPerTick;
    this.lastT = Math.max(this.lastT, targetT);

    if (rows.rows.length > 0) {
      for (const s of this.dataset.symbol_list) {
        const px = this.prices.get(s);
        if (px) this.books.set(s, this.bookFor(s, px));
      }
      this.runSyntheticTrades();
      this.applyCircuitClamp();
      const symbols = [...this.prices.keys()];
      const prices = symbols.map((s) => this.prices.get(s)!);
      await query(
        `insert into live_prices (symbol, price, prev_price, updated_at)
         select s, p, coalesce(lp.price, 0), now()
         from unnest($1::text[], $2::numeric[]) as x(s, p)
         left join live_prices lp on lp.symbol = x.s
         on conflict (symbol) do update
         set price = excluded.price, prev_price = live_prices.price,
             updated_at = now()`,
        [symbols, prices],
      );
      await query(
        `update market_state set last_t = $1, updated_at = now()
         where dataset_id = $2`,
        [this.lastT, this.dataset.dataset_id],
      );
      await query(
        `update event_config set tick_count = tick_count + $1, flash_shock = $2
         where id = true`,
        [rows.rows.length, round(flash * decay, 6)],
      );
      this.cfg.tick_count = String(
        Number(this.cfg.tick_count) + rows.rows.length,
      );
      this.cfg.flash_shock = String(round(flash * decay, 6));

      const batch: LiveTick[] = this.dataset.symbol_list.map((symbol) => {
        const price = this.prices.get(symbol);
        return { symbol, price: price ?? 0, prev: 0 };
      });
      broadcast({
        type: "tick",
        t: this.lastT,
        ts: Date.now(),
        prices: batch,
        books: this.dataset.symbol_list.map((symbol) => ({
          symbol,
          bids: this.books.get(symbol)?.bids ?? [],
          asks: this.books.get(symbol)?.asks ?? [],
        })),
      });
      this.historyBuf.push({ t: Date.now(), prices: Object.fromEntries(this.prices) });
      if (this.historyBuf.length > 600) this.historyBuf.shift();
    }

    if (caughtUp && targetT >= this.dataset.end_t) {
      await this.conclude();
    }
  }

  async conclude() {
    await this.freezeLeaderboard();
    await this.setLocalState("EVENT_CONCLUDED");
  }

  private async setLocalState(state: EventState) {
    this.cfg.state = state;
    await query(`update event_config set state = $1 where id = true`, [state]);
    broadcast({ type: "state", state });
  }

  async startEvent(opts: {
    startCapital: number;
    eventMinutes: number;
    blackoutMinutes: number;
    apiFreezeMinutes: number;
  }) {
    const now = new Date();
    const end = new Date(now.getTime() + opts.eventMinutes * 60_000);
    const freezeAt = new Date(
      now.getTime() + (opts.eventMinutes - opts.blackoutMinutes) * 60_000,
    );
    const apiFreezeAt = new Date(
      now.getTime() + (opts.eventMinutes - opts.apiFreezeMinutes) * 60_000,
    );

    if (this.dataset) {
      const liveStart = this.dataset.live_start_t ?? 0;
      await query(`update market_state set last_t = $1 where dataset_id = $2`, [
        liveStart,
        this.dataset.dataset_id,
      ]);
      this.lastT = liveStart;
    }
    await query(
      `update event_config set
         state = 'ACTIVE_MARKET', paused = false, start_capital = $1,
         event_started_at = $2, scheduled_end_at = $3,
         leaderboard_freeze_at = $4, api_freeze_at = $5,
         leaderboard_frozen = false, tick_count = 0, flash_shock = 0,
         flash_symbols = '', credentials_revealed = false
       where id = true`,
      [opts.startCapital, now, end, freezeAt, apiFreezeAt],
    );
    await query(
      `update teams set cash_balance = $1, starting_capital = $1, total_portfolio_value = $1
       where role = 'team'`,
      [opts.startCapital],
    );
    await query(
      `truncate holdings, order_logs, request_logs, leaderboard_snapshot, scoring`,
    );

    await this.reloadConfig();
    this.startWallMs = Date.now();
    this.crashWindowIdx = -1;
    this.crashAt = [];
    broadcast({
      type: "state",
      state: "ACTIVE_MARKET",
      eventStartedAt: now.toISOString(),
    });
  }

  async reloadConfig() {
    const wasRunning =
      this.cfg?.state === "ACTIVE_MARKET" && !this.cfg?.paused;
    const targetT =
      this.dataset && wasRunning
        ? this.dataset.start_t +
          (Date.now() - this.startWallMs) * Number(this.cfg.replay_speed)
        : null;
    const res = await query(`select * from event_config where id = true`);
    this.cfg = res.rows[0] as EventConfigRow;
    const ratio = Number(this.cfg.replay_speed);
    this.startWallMs =
      targetT !== null && this.dataset && ratio > 0
        ? Date.now() - (targetT - this.dataset.start_t) / ratio
        : Date.now();
  }

  async reloadDataset() {
    await this.reloadConfig();
    const ds = await query(
      `select * from market_datasets where is_active = true limit 1`,
    );
    this.dataset = ds.rows[0] ? toDatasetRow(ds.rows[0] as DatasetRow) : null;
    this.lastT = 0;
    if (this.dataset) {
      const ms = await query(
        `select last_t from market_state where dataset_id = $1`,
        [this.dataset.dataset_id],
      );
      this.lastT = Number(ms.rows[0]?.last_t ?? 0);
    }
    const lp = await query(`select symbol, price from live_prices`);
    this.prices.clear();
    for (const r of lp.rows) {
      this.prices.set(r.symbol, Number(r.price));
    }
    this.startWallMs = Date.now();
    broadcast({ type: "dataset_reloaded" });
  }

  async pause() {
    this.cfg.paused = true;
    await query(`update event_config set paused = true where id = true`);
    broadcast({ type: "state", state: this.cfg.state, paused: true });
  }

  async resume() {
    this.cfg.paused = false;
    if (this.dataset) {
      const ratio = Number(this.cfg.replay_speed);
      this.startWallMs =
        ratio > 0
          ? Date.now() - (this.lastT - this.dataset.start_t) / ratio
          : Date.now();
    } else {
      this.startWallMs = Date.now();
    }
    await query(`update event_config set paused = false where id = true`);
    broadcast({ type: "state", state: this.cfg.state, paused: false });
  }

  async setVolatility(multiplier: number) {
    this.cfg.volatility_multiplier = String(multiplier);
    await query(
      `update event_config set volatility_multiplier = $1 where id = true`,
      [multiplier],
    );
    broadcast({ type: "volatility", multiplier });
  }

  async triggerFlashCrash(shock: number, symbols?: string[], decay?: number) {
    const list = (symbols ?? [])
      .map((s) => s.trim().toUpperCase())
      .filter((s) => this.prices.has(s));
    if (symbols?.length && list.length === 0) {
      throw new Error("NO_VALID_SYMBOLS");
    }
    const flashSymbols = [...new Set(list)].join(",");
    this.cfg.flash_shock = String(shock);
    this.cfg.flash_symbols = flashSymbols;
    if (decay !== undefined) {
      this.cfg.flash_decay = String(
        Math.min(Math.max(decay, 0.05), 0.999),
      );
    }
    const flashDecay = Number(this.cfg.flash_decay);
    await query(
      `update event_config set flash_shock = $1, flash_symbols = $2, flash_decay = $3 where id = true`,
      [shock, flashSymbols, flashDecay],
    );
    broadcast({
      type: "flash",
      shock,
      symbols: flashSymbols ? flashSymbols.split(",") : null,
      decay: flashDecay,
    });
  }

  async revealCredentials() {
    this.cfg.credentials_revealed = true;
    await query(
      `update event_config set credentials_revealed = true where id = true`,
    );
    broadcast({ type: "credentials_revealed" });
  }

  async hideCredentials() {
    this.cfg.credentials_revealed = false;
    await query(
      `update event_config set credentials_revealed = false where id = true`,
    );
    broadcast({ type: "credentials_hidden" });
  }

  async freezeLeaderboard() {
    await query(
      `insert into leaderboard_snapshot (rank, team_id, team_name, total_portfolio_value)
       select rank() over (order by v desc), team_id, team_name, v from (
         select t.team_id, t.team_name,
                round(t.cash_balance + coalesce((
                  select sum(h.quantity * lp.price)
                  from holdings h
                  left join live_prices lp on lp.symbol = h.symbol
                  where h.team_id = t.team_id and h.quantity > 0
                ), 0), 2) as v
         from teams t where t.role = 'team'
       ) x`,
    );
    this.cfg.leaderboard_frozen = true;
    await query(
      `update event_config set leaderboard_frozen = true where id = true`,
    );
    broadcast({ type: "leaderboard_frozen" });
  }

  async unfreezeLeaderboard() {
    this.cfg.leaderboard_frozen = false;
    await query(
      `update event_config set leaderboard_frozen = false where id = true`,
    );
    broadcast({ type: "leaderboard_unfrozen" });
  }

  price(symbol: string): number | null {
    return this.prices.get(symbol) ?? null;
  }
}

export const engine = new EventEngine();
