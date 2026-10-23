import { appendErrorLog } from "./errlog.js";
import { query } from "./db.js";
import { replayDatasetTime } from "./scoring.js";
import { broadcast, setHelloProvider } from "./ws.js";
import { config, type EventState } from "./config.js";
import { personalityFor } from "./personality.js";
import { isSessionOpen, istDayKey } from "./sessions.js";
import { cacheInvalidateAll } from "./cache.js";
import { setLivePriceProvider, setFillListener } from "./atomic.js";

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
  private sessionDay = ""; // IST day key of the last processed dataset row
  private wiggle = new Map<string, number>();
  private appliedMult = new Map<string, number>(); // flash×wiggle multiplier baked into prices
  private pausedAtMs: number | null = null; // wall time of the last pause (history anchor)
  private momentum = new Map<string, number>(); // order-flow pressure per symbol, –1..+1
  private circuit = new Map<string, "upper" | "lower">();
  private books = new Map<string, Book>();
  private historyBuf: { t: number; prices: Record<string, number> }[] = [];
  private maxRowsPerTick = Number(process.env.MAX_ROWS_PER_TICK ?? 5000);
  private lastPersistMs = 0;
  private pendingRows = 0;
  private tickSeq = 0;
  private tickInFlight = false;
  private crashAuto = config.crash.auto;
  private crashWindowIdx = -1;
  private crashAt: number[] = [];
  // Traded volume since event start: synthetic market tape + team fills.
  private volumeShares = 0;
  private turnover = 0;
  private crashWins = new Map<string, number>();

  async init() {
    const res = await query(`select * from event_config where id = true`);
    this.cfg = res.rows[0] as EventConfigRow;
    this.volumeShares = Number((this.cfg as any).volume_shares ?? 0);
    this.turnover = Number((this.cfg as any).turnover ?? 0);

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
      this.sessionDay = ""; // force anchor re-init on first processed row
    }

    // Sync engine prices with dataset's actual prices at lastT so live prices
    // seamlessly continue from historical dataset prices without gap jumps.
    if (this.dataset) {
      const symbols = this.dataset.symbol_list;
      // Active event: restore live (noised/shocked) prices; seed only missing symbols.
      const eventRunning =
        !!this.cfg.event_started_at &&
        this.cfg.state !== "EVENT_CONCLUDED" &&
        this.cfg.state !== "PRE_LAUNCH";
      const restored = new Set<string>();
      if (eventRunning) {
        const lp = await query(`select symbol, price from live_prices`);
        for (const r of lp.rows) {
          const px = Number(r.price);
          if (px > 0 && (!symbols?.length || symbols.includes(r.symbol))) {
            this.prices.set(r.symbol, px);
            restored.add(r.symbol);
          }
        }
      }
      const targetT = this.lastT > 0 ? this.lastT : this.dataset.end_t;
      let latestPx: { rows: { symbol: string; price: string | number }[] };
      if (symbols && symbols.length > 0) {
        latestPx = await query(
          `select s.symbol, dt.price
           from unnest($2::text[]) as s(symbol)
           cross join lateral (
             select price
             from dataset_ticks
             where dataset_id = $1 and symbol = s.symbol and t <= $3
             order by dataset_id, symbol, t desc
             limit 1
           ) dt`,
          [this.dataset.dataset_id, symbols, targetT],
        );
      } else {
        latestPx = await query(
          `select distinct on (symbol) symbol, price from dataset_ticks
           where dataset_id = $1 and t <= $2
           order by symbol, t desc, seq desc`,
          [this.dataset.dataset_id, targetT],
        );
      }
      for (const r of latestPx.rows) {
        const px = Number(r.price);
        if (px > 0 && !restored.has(r.symbol)) {
          this.prices.set(r.symbol, px);
          await query(
            `insert into live_prices (symbol, price, prev_price)
             values ($1, $2, $3)
             on conflict (symbol) do update set price = excluded.price`,
            [r.symbol, px, px],
          );
        }
      }
    }

    // Restore wall-clock continuity after a restart mid-event: derive
    // startWallMs from the dataset position so ticks resume, not fast-forward.
    if (
      this.cfg.state === "ACTIVE_MARKET" &&
      !this.cfg.paused &&
      this.dataset &&
      Number(this.cfg.replay_speed) > 0
    ) {
      const liveStart = this.dataset.live_start_t ?? this.dataset.start_t;
      this.startWallMs =
        Date.now() - (this.lastT - liveStart) / Number(this.cfg.replay_speed);
    } else {
      this.startWallMs = Date.now();
    }

    // Send only the last 60 snapshots in the hello payload (~80KB vs ~800KB
    // for the full 600-entry buffer). On a LAN with 40-50 teams reconnecting
    // simultaneously this avoids a 32MB burst. Clients accumulate further
    // history via live tick messages after connecting.
    setLivePriceProvider((sym) => this.prices.get(sym));
    setFillListener((_sym, qty, price) => this.recordVolume(qty, price));
    setHelloProvider(() => ({ ...this.getStatus(), history: this.historyBuf.slice(-60) }));
    this.startTimer();
  }

  private startTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      if (this.tickInFlight) return;
      this.tickInFlight = true;
      this.tick().catch((e) => {
        console.error("[engine] tick error", e);
        appendErrorLog("tick-error.log", "tick", e);
      }).finally(() => {
        this.tickInFlight = false;
      });
    }, config.tickIntervalMs);
    this.timer.unref?.();
  }

  /** Stop the tick loop (used by tests so old engines don't keep writing). */
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
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
      pausedAtMs: this.pausedAtMs,
      credentialsRevealed: this.cfg.credentials_revealed,
      leaderboardFrozen: this.cfg.leaderboard_frozen,
      tickCount: Number(this.cfg.tick_count),
      volumeShares: this.volumeShares,
      turnover: round(this.turnover, 2),
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
      lastT: this.lastT,
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

  private symbolBand(_symbol: string): number {
    // All symbols use the exact configured circuit_pct — no per-symbol
    // multiplier, so the admin-set band applies uniformly to every stock.
    return Math.min(Number(this.cfg.circuit_pct) || 0.1, 0.5);
  }

  private tickSize(price: number): number {
    // ~2 bps of price on the ₹0.05 NSE grid, so cheap and expensive stocks
    // move at a similar percentage pace (a flat ₹0.50 step made a ₹277 stock
    // ~10× more volatile than a ₹3,000 one).
    return Math.max(0.05, Math.round((price * 0.0002) / 0.05) * 0.05);
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
    // Auction-style tape with autocorrelated order flow.
    // Each symbol carries a momentum value m ∈ [–1, +1]:
    //   m > 0 → more buy pressure → price drifts up (trend)
    //   m < 0 → more sell pressure → price drifts down
    //   m decays at 0.88 per tick, gets random impulses → natural mean-reversion
    // This produces realistic multi-tick trends that reverse organically.
    for (const s of this.dataset.symbol_list) {
      const px = this.prices.get(s);
      if (!px) continue;
      const pers = personalityFor(s);
      const p = Math.min(0.4, Math.max(0.05, 0.18 + 0.1 * pers.vol));
      if (Math.random() >= p) continue;

      // ── Momentum update ──────────────────────────────────────────────────
      // 0.88 decay gives ~8-tick trend windows; impulse strength 0.35 means
      // one tick can shift the flow by up to ±0.35 before saturation.
      const m0 = this.momentum.get(s) ?? 0;
      const impulse = (Math.random() - 0.5) * 0.35;
      const m = Math.max(-1, Math.min(1, m0 * 0.88 + impulse));
      this.momentum.set(s, m);

      // ── Side bias ────────────────────────────────────────────────────────
      // buyProb ranges from 20% (strong sell momentum) to 80% (strong buy),
      // centred at 50% when m = 0.
      const buyProb = 0.5 + 0.30 * Math.tanh(m * 2);
      const side: "buy" | "sell" = Math.random() < buyProb ? "buy" : "sell";

      // ── Volume scales with momentum intensity (high-momentum = high vol) ─
      const momIntensity = Math.abs(m);
      const baseQty = 80 + Math.round(Math.random() ** 2 * 9920);
      // Scale size by tick length so volume per second doesn't depend on TICK_INTERVAL_MS.
      const tickScale = Math.min(1, config.tickIntervalMs / 1000);
      const qty = Math.max(1, Math.round(baseQty * (0.5 + momIntensity) * tickScale));

      // ── Price step ───────────────────────────────────────────────────────
      const ts = this.tickSize(px);
      const steps = Math.random() < 0.08 ? 2 : 1; // occasional aggressive fill
      const newPx = round(px + (side === "buy" ? steps * ts : -steps * ts), 4);
      this.prices.set(s, newPx);
      broadcast({
        type: "trade",
        symbol: s,
        side,
        qty,
        price: newPx,
        ts: Date.now(),
      });
      this.recordVolume(qty, newPx);
    }
  }

  recordVolume(qty: number, price: number) {
    this.volumeShares += qty;
    this.turnover += qty * price;
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

    const liveStart = this.dataset.live_start_t ?? this.dataset.start_t;
    const start = liveStart;
    const end = this.dataset.end_t;
    const span = end - start;
    const replaySpeed = Number(this.cfg.replay_speed);
    if (span <= 0 || replaySpeed <= 0) return;

    // Monotonic target in dataset time, wrapped into [start, end) so the replay
    // loops seamlessly: the market never concludes and lastT stays in-range.
    const mod = (x: number) => start + ((((x - start) % span) + span) % span);
    const targetEff = replayDatasetTime(start, end, now - this.startWallMs, replaySpeed);
    const lastEff = mod(this.lastT);

    let rows: any;
    if (targetEff > lastEff) {
      rows = await query(
        `select t, symbol, price from dataset_ticks
         where dataset_id = $1 and t > $2 and t <= $3
         order by t limit $4`,
        [this.dataset.dataset_id, Math.floor(lastEff), Math.floor(targetEff), this.maxRowsPerTick],
      );
    } else if (targetEff < lastEff) {
      // Dataset boundary crossed: reset session anchors so the new loop cycle
      // sets fresh opens rather than snapping against stale previous-cycle opens.
      this.sessionDay = "";
      this.open.clear();
      this.circuit.clear();
      // crossed the dataset boundary: read the tail of this cycle then the head
      const tail = await query(
        `select t, symbol, price from dataset_ticks
         where dataset_id = $1 and t > $2 and t <= $3
         order by t limit $4`,
        [this.dataset.dataset_id, Math.floor(lastEff), Math.floor(end), this.maxRowsPerTick],
      );
      const head = await query(
        `select t, symbol, price from dataset_ticks
         where dataset_id = $1 and t >= $2 and t < $3
         order by t limit $4`,
        [this.dataset.dataset_id, Math.floor(start), Math.floor(targetEff), this.maxRowsPerTick - tail.rows.length],
      );
      rows = { rows: [...tail.rows, ...head.rows] };
    } else {
      return; // no new data to advance this tick
    }

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
      // New trading day -> reset circuit/exposure anchors so the ±band and
      // synthetic-tape reference use today's gapped open, not last week's.
      const dk = istDayKey(Number(r.t));
      if (dk !== this.sessionDay) {
        this.sessionDay = dk;
        this.open.clear();
        this.circuit.clear();
      }
      if (!this.open.has(r.symbol)) {
        // Clamp the new session open to within ±band of the previous close so
        // raw NSE overnight gaps never exceed the configured circuit_pct.
        const prevClose = this.prices.get(r.symbol);
        if (prevClose) {
          const band = this.symbolBand(r.symbol);
          const clampedOpen = Math.min(
            Math.max(base, round(prevClose * (1 - band), 4)),
            round(prevClose * (1 + band), 4),
          );
          this.open.set(r.symbol, clampedOpen);
        } else {
          this.open.set(r.symbol, base);
        }
      }
      const pers = personalityFor(r.symbol);
      const applyFlash =
        flashSymbols.size === 0 || flashSymbols.has(r.symbol);
      const w =
        (this.wiggle.get(r.symbol) ?? 0) * 0.90 + gaussian() * 0.00035 * pers.vol;
      this.wiggle.set(r.symbol, w);

      // Dataset price is the long-run anchor. Blend current price towards the
      // dataset target so synthetic momentum interacts with real dataset movement.
      // Strip the previously applied flash/wiggle multiplier before blending so
      // it is applied once (not compounded per row): steady state = base×(1+flash).
      const mult = (applyFlash ? 1 + flash : 1) * (1 + w);
      const current =
        (this.prices.get(r.symbol) ?? base) / (this.appliedMult.get(r.symbol) ?? 1);
      const datasetTarget =
        base * (1 + gaussian() * sigma * pers.vol);
      const blended = current * 0.7 + datasetTarget * 0.3;
      this.appliedMult.set(r.symbol, mult);
      this.prices.set(r.symbol, round(blended * mult, 4));
    }

    // Dataset gaps are intentionally left alone here: price must HOLD between
    // trade prints (auction behaviour), not glide. Movement below comes from
    // discrete synthetic fills in runSyntheticTrades() plus real dataset rows.

    this.lastT = Math.floor(targetEff); // last_t is bigint

    // Refresh books + run the synthetic tape.
    this.tickSeq += 1;
    for (const s of this.dataset.symbol_list) {
      const px = this.prices.get(s);
      if (px) this.books.set(s, this.bookFor(s, px));
    }
    this.runSyntheticTrades();
    this.applyCircuitClamp();
    this.pendingRows += Math.max(1, rows.rows.length);
    // Only decay once the shock was applied to at least one dataset print.
    if (rows.rows.length > 0) this.cfg.flash_shock = String(round(flash * decay, 6));

    if (now - this.lastPersistMs >= 1000) {
      this.lastPersistMs = now;
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
        `update event_config set tick_count = tick_count + $1, flash_shock = $2,
                volume_shares = $3, turnover = $4
         where id = true`,
        [this.pendingRows, this.cfg.flash_shock, this.volumeShares, round(this.turnover, 2)],
      );
      this.cfg.tick_count = String(Number(this.cfg.tick_count) + this.pendingRows);
      this.pendingRows = 0;
    }

    const batch: LiveTick[] = this.dataset.symbol_list.map((symbol) => {
      const price = this.prices.get(symbol);
      return { symbol, price: price ?? 0, prev: 0 };
    });
    broadcast({
      type: "tick",
      t: this.lastT,
      ts: Date.now(),
      prices: batch,
      ...(this.tickSeq % 5 === 0
        ? {
            books: this.dataset.symbol_list.map((symbol) => ({
              symbol,
              bids: this.books.get(symbol)?.bids ?? [],
              asks: this.books.get(symbol)?.asks ?? [],
            })),
          }
        : {}),
    });
    this.historyBuf.push({ t: Date.now(), prices: Object.fromEntries(this.prices) });
    if (this.historyBuf.length > 600) this.historyBuf.shift();
  }

  async conclude() {
    await this.freezeLeaderboard();
    await this.setLocalState("EVENT_CONCLUDED");
  }

  private async setLocalState(state: EventState) {
    this.cfg.state = state;
    await query(`update event_config set state = $1 where id = true`, [state]);
    cacheInvalidateAll();
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
      const liveStart = this.dataset.live_start_t ?? this.dataset.start_t;
      await query(`update market_state set last_t = $1 where dataset_id = $2`, [
        liveStart,
        this.dataset.dataset_id,
      ]);
      this.lastT = liveStart;

      // Seed engine prices and live_prices table directly from liveStart to eliminate opening gaps
      const symbols = this.dataset.symbol_list;
      let firstTicks: { rows: { symbol: string; price: string | number }[] };
      if (symbols && symbols.length > 0) {
        firstTicks = await query(
          `select s.symbol, dt.price
           from unnest($2::text[]) as s(symbol)
           cross join lateral (
             select price
             from dataset_ticks
             where dataset_id = $1 and symbol = s.symbol and t >= $3
             order by dataset_id, symbol, t asc
             limit 1
           ) dt`,
          [this.dataset.dataset_id, symbols, liveStart],
        );
      } else {
        firstTicks = await query(
          `select distinct on (symbol) symbol, price
           from dataset_ticks
           where dataset_id = $1 and t >= $2
           order by symbol, t asc, seq asc`,
          [this.dataset.dataset_id, liveStart],
        );
      }
      this.prices.clear();
      this.open.clear();
      this.circuit.clear();
      this.wiggle.clear();
      this.appliedMult.clear();
      this.momentum.clear();
      for (const r of firstTicks.rows) {
        const px = Number(r.price);
        this.prices.set(r.symbol, px);
        this.open.set(r.symbol, px);
      }
      if (firstTicks.rows.length > 0) {
        const symbols = firstTicks.rows.map((r) => r.symbol);
        const prices = firstTicks.rows.map((r) => Number(r.price));
        await query(
          `insert into live_prices (symbol, price, prev_price, updated_at)
           select s, p, p, now()
           from unnest($1::text[], $2::numeric[]) as x(s, p)
           on conflict (symbol) do update
           set price = excluded.price, prev_price = excluded.price, updated_at = now()`,
          [symbols, prices],
        );
      }
    }
    await query(
      `update event_config set
         state = 'ACTIVE_MARKET', paused = false, start_capital = $1,
         event_started_at = $2, scheduled_end_at = $3,
         leaderboard_freeze_at = $4, api_freeze_at = $5,
         leaderboard_frozen = false, tick_count = 0, flash_shock = 0,
         flash_symbols = '', credentials_revealed = false, volume_shares = 0, turnover = 0,
         volatility_multiplier = 1.0, noise_sigma = 0.00035, flash_decay = 0.97
       where id = true`,
      [opts.startCapital, now, end, freezeAt, apiFreezeAt],
    );
    await query(
      `update teams set cash_balance = $1, starting_capital = $1, total_portfolio_value = $1,
              realized_pnl = 0, total_fees = 0
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
    this.volumeShares = 0;
    this.turnover = 0;
    cacheInvalidateAll();
    broadcast({
      type: "state",
      state: "ACTIVE_MARKET",
      eventStartedAt: now.toISOString(),
    });
  }

  async reloadConfig() {
    const wasRunning =
      this.cfg?.state === "ACTIVE_MARKET" && !this.cfg?.paused;
    const liveStart = this.dataset?.live_start_t ?? this.dataset?.start_t ?? 0;
    const targetT =
      this.dataset && wasRunning
        ? liveStart +
          (Date.now() - this.startWallMs) * Number(this.cfg.replay_speed)
        : null;
    const res = await query(`select * from event_config where id = true`);
    this.cfg = res.rows[0] as EventConfigRow;
    const ratio = Number(this.cfg.replay_speed);
    this.startWallMs =
      targetT !== null && this.dataset && ratio > 0
        ? Date.now() - (targetT - liveStart) / ratio
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
    this.pausedAtMs = Date.now();
    await query(`update event_config set paused = true where id = true`);
    cacheInvalidateAll();
    broadcast({ type: "state", state: this.cfg.state, paused: true });
  }

  async resume() {
    this.cfg.paused = false;
    this.pausedAtMs = null;
    if (this.dataset) {
      const liveStart = this.dataset.live_start_t ?? this.dataset.start_t;
      const ratio = Number(this.cfg.replay_speed);
      this.startWallMs =
        ratio > 0
          ? Date.now() - (this.lastT - liveStart) / ratio
          : Date.now();
    } else {
      this.startWallMs = Date.now();
    }
    await query(`update event_config set paused = false where id = true`);
    cacheInvalidateAll();
    broadcast({ type: "state", state: this.cfg.state, paused: false });
  }

  async setVolatility(multiplier: number) {
    this.cfg.volatility_multiplier = String(multiplier);
    await query(
      `update event_config set volatility_multiplier = $1 where id = true`,
      [multiplier],
    );
    cacheInvalidateAll();
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
    cacheInvalidateAll();
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
    cacheInvalidateAll();
    broadcast({ type: "leaderboard_frozen" });
  }

  async unfreezeLeaderboard() {
    this.cfg.leaderboard_frozen = false;
    await query(
      `update event_config set leaderboard_frozen = false where id = true`,
    );
    cacheInvalidateAll();
    broadcast({ type: "leaderboard_unfrozen" });
  }

  price(symbol: string): number | null {
    return this.prices.get(symbol) ?? null;
  }
}

export const engine = new EventEngine();
