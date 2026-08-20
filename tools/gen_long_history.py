#!/usr/bin/env python3
"""Mercatus Arena — long-history dataset generator (3 months past + live tail).

Generates a single CSV for the CURRENT letter-symbol universe:
  - PAST section: ~N months of trading-hours-only (Mon-Fri 09:15-15:30 IST)
    1-minute OHLC bars with full microstructure (bid/ask/direction/depth),
    using the same regime/GARCH/news-jump/intraday-U dynamics as
    gen_paper_dataset.py (imported).
  - LIVE section: the last 3 hours of the final session at 1s spacing,
    continuing the same price path (rng + state carry over), so the engine
    can start the event at the tail and the model gets a consistent 3-month
    1-minute history via GET /api/history.

Outputs:
  paper_dataset.csv     -> upload via Admin Console (with live_start_ms field)
  dataset_meta.json     -> start_t / live_start_t / end_t etc.
  symbols_paper_meta.csv-> Nasdaq-style meta (letter symbols)

Usage:
    python tools/gen_long_history.py [--months 3] [--tail-hours 3]
        [--seed 42] [--out tools/output_long] [--end-date 2026-08-19]
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import os
import sys
from collections import Counter
from datetime import datetime, timedelta, timezone

import numpy as np

from gen_paper_dataset import (
    MARKET_PARAMS,
    SECTOR_PARAMS,
    GARCH_LAMBDA_PER_SEC,
    NEWS_RATE_PER_SEC,
    JUMP_SIZE,
    TIERS,
    TIER_ORDER,
    VOL_CATEGORIES,
    VOL_CAT_ORDER,
    REGIMES,
    MIN_PRICE,
    MAX_PRICE,
    MAX_TICK_RETURN,
    TICKS_PER_YEAR,
    VOL_MULT_MEAN,
    regime_transition_per_tick,
    intraday_vol_multiplier,
    calibrate_vols,
    tick_sigmas,
)

# ------------------------------------------------------------------ universe

# The 30 letter symbols of the currently-active paper_dataset.csv, with base
# prices ~= their opening prices in that dataset (so the live tail lands near
# today's familiar levels).
LETTER_UNIVERSE: dict[str, float] = {
    "A": 48.37, "BQ": 57.20, "CLP": 202.24, "EB": 166.59, "EM": 257.14,
    "F": 119.79, "FDLK": 90.30, "FMC": 49.52, "FMMH": 65.30, "FSF": 56.18,
    "GSEK": 119.50, "ILIT": 28.81, "IXRE": 157.75, "J": 23.57, "JD": 170.03,
    "LEQ": 49.38, "NKXT": 78.74, "NM": 224.33, "O": 69.60, "PKR": 185.91,
    "PLBY": 119.98, "QIU": 353.57, "RI": 104.38, "ROL": 66.17, "SIK": 126.70,
    "STTX": 175.52, "TCR": 109.01, "VX": 47.48, "W": 172.61, "ZHCJ": 75.72,
}

SECTORS = [
    "Technology", "Financial Services", "Healthcare", "Energy",
    "Consumer Discretionary", "Industrials", "Materials", "Communication Services",
]

SESSION_START_MIN = 225   # 03:45 UTC = 09:15 IST
SESSION_END_MIN = 600     # 10:00 UTC = 15:30 IST
SESSION_MINUTES = SESSION_END_MIN - SESSION_START_MIN  # 375


def ist_minute_of_day(t_epoch_ms: int) -> float:
    """Minutes-since-midnight in IST (UTC+5:30) — feeds the U-shaped vol."""
    m = (t_epoch_ms / 60_000.0) % 1440.0 + 330.0
    return m if m < 1440.0 else m - 1440.0


def build_meta(rng: np.random.Generator, symbols: list[str], base_prices: list[float]) -> dict:
    """Fixed-symbol universe with seeded tier/vol/beta/etc. assignment."""
    n = len(symbols)
    tiers: list[str] = []
    cats: list[str] = []
    ann_vols: list[float] = []
    betas_m: list[float] = []
    betas_s: list[float] = []
    floats: list[float] = []
    turnovers: list[float] = []
    spreads: list[float] = []
    jumps: list[float] = []
    secs: list[str] = []

    # seeded shuffle of the catalog-order so assignment is stable per seed
    tier_choices = list(TIER_ORDER)
    rng.shuffle(tier_choices)
    cat_choices = list(VOL_CAT_ORDER)
    rng.shuffle(cat_choices)
    sec_choices = list(SECTORS)
    rng.shuffle(sec_choices)

    for i in range(n):
        tier = tier_choices[i % len(tier_choices)]
        cat = cat_choices[i % len(cat_choices)]
        t = TIERS[tier]
        tiers.append(tier)
        cats.append(cat)
        ann_vols.append(float(np.clip(
            t["ann_vol"] * VOL_CATEGORIES[cat], 0.12, 1.40,
        )))
        betas_m.append(float(rng.uniform(*t["beta"])))
        betas_s.append(float(rng.uniform(0.5, 1.2)))
        floats.append(t["float"])
        turnovers.append(t["turnover"])
        spreads.append(t["spread_bps"])
        jumps.append(t["jump_scale"])
        secs.append(sec_choices[i % len(sec_choices)])

    sectors = sorted(SECTORS)
    sector_index = {s: i for i, s in enumerate(sectors)}
    return {
        "tickers": symbols,
        "names": symbols,
        "sectors": secs,
        "sector_idx": np.array([sector_index[s] for s in secs]),
        "tiers": tiers,
        "vol_cats": cats,
        "ref_prices": base_prices,
        "base_prices": np.round(np.array(base_prices), 2),
        "betas_market": np.array(betas_m),
        "betas_sector": np.array(betas_s),
        "ann_vols": np.array(ann_vols),
        "floats": np.array(floats),
        "turnovers": np.array(turnovers),
        "spread_bps_base": np.array(spreads),
        "jump_scales": np.array(jumps),
        "n_sectors": len(sectors),
    }


# ------------------------------------------------------------ trading days

def trading_days(end_date: datetime, months: float) -> list[datetime]:
    """Mon-Fri session days (UTC) covering ~= `months` back from end_date."""
    days: list[datetime] = []
    day = end_date
    while day.weekday() >= 5:
        day -= timedelta(days=1)
    anchor = day
    while len(days) == 0 or (days[0] - anchor).days < months * 30.44:
        if anchor.weekday() < 5:
            days.append(anchor)
        anchor -= timedelta(days=1)
    return sorted(days)


def session_start_ms(day: datetime) -> int:
    return int(day.replace(tzinfo=timezone.utc).timestamp() * 1000) + SESSION_START_MIN * 60_000


# ------------------------------------------------------------- simulation

HEADER = [
    "timestamp", "symbol", "price", "volume",
    "open", "high", "low", "bid", "ask", "direction", "bid_qty", "ask_qty",
]


def simulate_past(
    meta: dict,
    rng: np.random.Generator,
    days: list[datetime],
    spacing_ms: int,
    writer: csv.writer,
    stop_at_ms: int | None = None,
) -> tuple[dict, int]:
    """1-min bars over trading hours only; returns final sim state + rows.

    stop_at_ms: if given, the LAST day's session is cut off at this
    timestamp (inclusive) so the tail phase can continue seamlessly from
    the exact state where the past ends (no overlap, no price jump).
    """
    n = len(meta["tickers"])
    dt = spacing_ms / 1000.0
    lam = GARCH_LAMBDA_PER_SEC ** dt
    p_jump = 1.0 - math.exp(-NEWS_RATE_PER_SEC * dt)
    P = regime_transition_per_tick(dt)

    prices = meta["base_prices"].copy()
    prev_close = meta["base_prices"].copy()
    idio_var = np.full(n, 0.02)
    regime = 0

    vol_per_bar = (meta["floats"] * meta["turnovers"] * 1.0) / SESSION_MINUTES / VOL_MULT_MEAN

    rows = 0
    flush: list[tuple] = []
    for day in days:
        t0 = session_start_ms(day)
        for k in range(SESSION_MINUTES):
            t_epoch = t0 + (k + 1) * spacing_ms
            if stop_at_ms is not None and day is days[-1] and t_epoch > stop_at_ms:
                break
            u = rng.random()
            acc = 0.0
            for j, p in enumerate(P[regime]):
                acc += p
                if u < acc:
                    regime = j
                    break
            rkey = REGIMES[regime]
            mp = MARKET_PARAMS[rkey]
            sp = SECTOR_PARAMS[rkey]

            rm = mp["mu"] * dt + mp["sigma"] * math.sqrt(dt) * rng.standard_normal()
            rs = (
                sp["mu"] * dt
                + sp["sigma"] * math.sqrt(dt) * rng.standard_normal(meta["sector_idx"].max() + 1)
                + 0.45 * rm
            )
            ivm = float(intraday_vol_multiplier(np.array([ist_minute_of_day(t_epoch)]))[0])

            z = rng.standard_normal(n)
            shock_idio = meta["idio_vols"] * np.sqrt(idio_var) * z * ivm
            idio_var = lam * idio_var + (1 - lam) * (z ** 2)

            jumps = rng.random(n) < p_jump
            if jumps.any():
                signs = np.where(rng.random(n) < 0.5, -1.0, 1.0)
                shock_idio = shock_idio + signs * jumps * rng.uniform(*JUMP_SIZE, size=n) * meta["jump_scales"]

            r = (
                meta["betas_market"] * rm
                + meta["betas_sector"] * rs[meta["sector_idx"]]
                + shock_idio
            )
            prices = np.clip(
                prices * np.exp(np.clip(r, -MAX_TICK_RETURN, MAX_TICK_RETURN)),
                MIN_PRICE, MAX_PRICE,
            )

            vol_mult = 1.0 + 6.0 * np.abs(shock_idio) / (meta["idio_vols"] + 1e-12)
            lot = np.where(vol_per_bar >= 100.0, 100.0, 10.0)
            volumes = np.maximum(
                np.round(vol_per_bar * vol_mult * ivm / lot) * lot, 1.0
            ).astype(int)

            spread_bps = meta["spread_bps_base"] * (
                1.0 + 0.8 * np.abs(shock_idio) / (meta["idio_vols"] + 1e-12)
            ) * (0.8 + 0.4 * ivm)
            half = np.maximum(spread_bps * 0.5 * 1e-4, 1e-4)
            bid = np.maximum(np.round((prices * (1 - half)) / 0.01) * 0.01, 0.01)
            ask = np.maximum(bid + 0.01, np.round((prices * (1 + half)) / 0.01) * 0.01)

            bar_frac = np.abs(r) * 0.6 + 1e-4
            hi_u = rng.uniform(0.2, 1.0, n)
            lo_u = rng.uniform(0.2, 1.0, n)
            high = np.maximum(prices, prev_close) * (1 + bar_frac * hi_u)
            low = np.maximum(
                np.minimum(prices, prev_close) * (1 - bar_frac * lo_u), 0.01
            )
            open_ = prev_close

            sigma_est = tick_sigmas(meta, dt)
            zscore = r / sigma_est
            p_buy = 1.0 / (1.0 + np.exp(-np.clip(1.8 * zscore, -30.0, 30.0)))
            direction = np.where(rng.random(n) < p_buy, "B", "S")

            depth = np.maximum(
                np.round(meta["floats"] * 2e-4 * vol_mult * ivm / prices / 100.0) * 100.0,
                100.0,
            ).astype(int)

            for i in range(n):
                flush.append((
                    t_epoch, meta["tickers"][i],
                    round(float(prices[i]), 2), int(volumes[i]),
                    round(float(open_[i]), 2),
                    round(float(high[i]), 2),
                    round(float(low[i]), 2),
                    round(float(bid[i]), 2), round(float(ask[i]), 2),
                    direction[i], int(depth[i]), int(depth[i]),
                ))
            prev_close = prices.copy()
            rows += n
            if len(flush) >= 20_000:
                writer.writerows(flush)
                flush = []

    if flush:
        writer.writerows(flush)

    return {"prices": prices, "prev_close": prev_close, "idio_var": idio_var, "regime": regime}, rows


def simulate_tail(
    meta: dict,
    rng: np.random.Generator,
    state: dict,
    tail_start_ms: int,
    tail_minutes: int,
    spacing_ms: int,
    writer: csv.writer,
    idio_vols: np.ndarray | None = None,
) -> int:
    """1s ticks for the live window, continuing the past sim's state.

    idio_vols: per-tick idio vols appropriate for THIS spacing. The past
    phase calibrates idio vols for its (coarser) spacing; volatility scales
    with sqrt(dt), so for a finer tail spacing they must be rescaled by
    sqrt(past_spacing / tail_spacing).
    """
    n = len(meta["tickers"])
    dt = spacing_ms / 1000.0
    lam = GARCH_LAMBDA_PER_SEC ** dt
    p_jump = 1.0 - math.exp(-NEWS_RATE_PER_SEC * dt)
    P = regime_transition_per_tick(dt)

    prices = state["prices"].copy()
    prev_close = state["prev_close"].copy()
    idio_var = state["idio_var"].copy()
    regime = state["regime"]
    idio_vols = idio_vols if idio_vols is not None else meta["idio_vols"]

    total = int(tail_minutes * 60_000 / spacing_ms)
    window_frac = tail_minutes / 390.0
    vol_per_tick = (meta["floats"] * meta["turnovers"] * window_frac) / total / VOL_MULT_MEAN

    rows = 0
    flush: list[tuple] = []
    t_epoch = tail_start_ms + spacing_ms
    for k in range(1, total + 1):
        u = rng.random()
        acc = 0.0
        for j, p in enumerate(P[regime]):
            acc += p
            if u < acc:
                regime = j
                break
        rkey = REGIMES[regime]
        mp = MARKET_PARAMS[rkey]
        sp = SECTOR_PARAMS[rkey]

        rm = mp["mu"] * dt + mp["sigma"] * math.sqrt(dt) * rng.standard_normal()
        rs = (
            sp["mu"] * dt
            + sp["sigma"] * math.sqrt(dt) * rng.standard_normal(meta["sector_idx"].max() + 1)
            + 0.45 * rm
        )
        ivm = float(intraday_vol_multiplier(np.array([ist_minute_of_day(t_epoch)]))[0])

        z = rng.standard_normal(n)
        shock_idio = idio_vols * np.sqrt(idio_var) * z * ivm
        idio_var = lam * idio_var + (1 - lam) * (z ** 2)

        jumps = rng.random(n) < p_jump
        if jumps.any():
            signs = np.where(rng.random(n) < 0.5, -1.0, 1.0)
            shock_idio = shock_idio + signs * jumps * rng.uniform(*JUMP_SIZE, size=n) * meta["jump_scales"]

        r = (
            meta["betas_market"] * rm
            + meta["betas_sector"] * rs[meta["sector_idx"]]
            + shock_idio
        )
        prices = np.clip(
            prices * np.exp(np.clip(r, -MAX_TICK_RETURN, MAX_TICK_RETURN)),
            MIN_PRICE, MAX_PRICE,
        )

        vol_mult = 1.0 + 6.0 * np.abs(shock_idio) / (idio_vols + 1e-12)
        lot = np.where(vol_per_tick >= 100.0, 100.0, 10.0)
        volumes = np.maximum(
            np.round(vol_per_tick * vol_mult * ivm / lot) * lot, 1.0
        ).astype(int)

        spread_bps = meta["spread_bps_base"] * (
            1.0 + 0.8 * np.abs(shock_idio) / (meta["idio_vols"] + 1e-12)
        ) * (0.8 + 0.4 * ivm)
        half = np.maximum(spread_bps * 0.5 * 1e-4, 1e-4)
        bid = np.maximum(np.round((prices * (1 - half)) / 0.01) * 0.01, 0.01)
        ask = np.maximum(bid + 0.01, np.round((prices * (1 + half)) / 0.01) * 0.01)

        bar_frac = np.abs(r) * 0.6 + 1e-4
        hi_u = rng.uniform(0.2, 1.0, n)
        lo_u = rng.uniform(0.2, 1.0, n)
        high = np.maximum(prices, prev_close) * (1 + bar_frac * hi_u)
        low = np.maximum(
            np.minimum(prices, prev_close) * (1 - bar_frac * lo_u), 0.01
        )
        open_ = prev_close

        sigma_est = tick_sigmas(meta, dt)
        zscore = r / sigma_est
        p_buy = 1.0 / (1.0 + np.exp(-np.clip(1.8 * zscore, -30.0, 30.0)))
        direction = np.where(rng.random(n) < p_buy, "B", "S")

        depth = np.maximum(
            np.round(meta["floats"] * 2e-4 * vol_mult * ivm / prices / 100.0) * 100.0,
            100.0,
        ).astype(int)

        for i in range(n):
            flush.append((
                t_epoch, meta["tickers"][i],
                round(float(prices[i]), 2), int(volumes[i]),
                round(float(open_[i]), 2),
                round(float(high[i]), 2),
                round(float(low[i]), 2),
                round(float(bid[i]), 2), round(float(ask[i]), 2),
                direction[i], int(depth[i]), int(depth[i]),
            ))
        prev_close = prices.copy()
        rows += n
        if len(flush) >= 20_000:
            writer.writerows(flush)
            flush = []
        t_epoch += spacing_ms

    if flush:
        writer.writerows(flush)
    return rows


# ------------------------------------------------------------------ output

META_HEADER = (
    "Nasdaq Traded,Symbol,Security Name,Listing Exchange,Market Category,"
    "ETF,Round Lot Size,Test Issue,Financial Status,CQS Symbol,"
    "NASDAQ Symbol,NextShares"
)


def write_meta(meta: dict, path: str) -> None:
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(META_HEADER.split(","))
        for t in meta["tickers"]:
            w.writerow(["Y", t, t, "N", "Q", "N", "100.0", "N", "", t, t, "N"])


def validate(path: str, meta: dict, expect_per_symbol: dict) -> int:
    n = len(meta["tickers"])
    counts: dict[str, int] = {t: 0 for t in meta["tickers"]}
    first_t: dict[str, int] = {}
    last_t: dict[str, int] = {}
    bad = 0
    with open(path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            sym = row["symbol"].strip().upper()
            if sym not in counts:
                bad += 1
                continue
            counts[sym] += 1
            t = int(row["timestamp"])
            first_t.setdefault(sym, t)
            last_t[sym] = t
    print(f"\n=== validation: {path}")
    print(f"rows: {sum(counts.values()):,}   unknown symbols: {bad}")
    for t, c in sorted(counts.items()):
        ok = c == expect_per_symbol[t]
        print(f"  {t:<6} rows={c:>8,}  first={first_t[t]}  last={last_t[t]}  {'OK' if ok else 'MISMATCH'}")
    return 0 if bad == 0 and all(c == expect_per_symbol[t] for t, c in counts.items()) else 2


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--symbols", default=",".join(LETTER_UNIVERSE.keys()),
                    help="comma-separated symbols (default: the 30 letter symbols)")
    ap.add_argument("--months", type=float, default=3.0, help="past span in months (default 3)")
    ap.add_argument("--past-spacing-ms", type=int, default=60_000, help="past bar spacing (default 60000 = 1 min)")
    ap.add_argument("--tail-hours", type=float, default=3.0, help="live tail length in hours (default 3)")
    ap.add_argument("--tail-spacing-ms", type=int, default=1000, help="live tail tick spacing (default 1000)")
    ap.add_argument("--seed", type=int, default=42, help="random seed (default 42)")
    ap.add_argument("--end-date", default=None, help="anchor date YYYY-MM-DD (default: today)")
    ap.add_argument("--no-calibrate", action="store_true", help="skip idio-vol calibration")
    ap.add_argument("--no-validate", action="store_true", help="skip validation pass")
    ap.add_argument("--out", default="tools/output_long", help="output directory")
    args = ap.parse_args()

    symbols = [s.strip().upper() for s in args.symbols.split(",") if s.strip()]
    base_prices = [LETTER_UNIVERSE.get(s, 100.0 + i * 7.0) for i, s in enumerate(symbols)]
    if len(set(symbols)) != len(symbols):
        print("error: duplicate symbols", file=sys.stderr)
        return 1

    out_dir = os.path.abspath(args.out)
    os.makedirs(out_dir, exist_ok=True)
    dataset_path = os.path.join(out_dir, "paper_dataset.csv")
    meta_path = os.path.join(out_dir, "symbols_paper_meta.csv")
    json_path = os.path.join(out_dir, "dataset_meta.json")

    end_date = (datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
                if args.end_date is None
                else datetime.strptime(args.end_date, "%Y-%m-%d").replace(tzinfo=timezone.utc))
    days = trading_days(end_date, args.months)
    if len(days) < 2:
        print("error: need at least 2 trading days", file=sys.stderr)
        return 1

    rng = np.random.default_rng(args.seed)
    meta = build_meta(rng, symbols, base_prices)

    dt = args.past_spacing_ms / 1000.0
    m_sig = MARKET_PARAMS["chop"]["sigma"] * math.sqrt(dt)
    s_sig = SECTOR_PARAMS["chop"]["sigma"] * math.sqrt(dt)
    per_tick_scale = math.sqrt(TICKS_PER_YEAR / dt)
    meta["idio_vols"] = np.sqrt(
        np.maximum(
            meta["ann_vols"] ** 2
            - (meta["betas_market"] * m_sig * per_tick_scale) ** 2
            - (meta["betas_sector"] * s_sig * per_tick_scale) ** 2,
            1e-10,
        )
    ) / per_tick_scale

    if not args.no_calibrate:
        print("calibrating idio vols (warmup sim)...", flush=True)
        cal_start = session_start_ms(days[len(days) // 2])
        meta = calibrate_vols(
            meta, rng, dt, n_ticks=max(1200, min(3000, (SESSION_MINUTES * len(days)) // 3)),
            start_epoch_ms=cal_start, flash_crash=False, iters=2,
        )

    tail_ms = int(args.tail_hours * 3_600_000)
    if tail_ms > SESSION_END_MIN * 60_000 - SESSION_START_MIN * 60_000:
        print("error: tail longer than one session", file=sys.stderr)
        return 1
    last_day = days[-1]
    tail_start_ms = session_start_ms(last_day) + (SESSION_END_MIN - SESSION_START_MIN) * 60_000 - tail_ms

    rows_total = 0
    with open(dataset_path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(HEADER)
        state, rows_past = simulate_past(meta, rng, days, args.past_spacing_ms, w,
                                         stop_at_ms=tail_start_ms)
        rows_total += rows_past
        rows_tail = simulate_tail(
            meta, rng, state, tail_start_ms,
            int(args.tail_hours * 60), args.tail_spacing_ms, w,
            idio_vols=meta["idio_vols"] * math.sqrt(args.tail_spacing_ms / args.past_spacing_ms),
        )
        rows_total += rows_tail

    write_meta(meta, meta_path)

    start_t = session_start_ms(days[0])
    end_t = tail_start_ms + int(tail_ms / args.tail_spacing_ms) * args.tail_spacing_ms
    past_bars_per_symbol = (
        SESSION_MINUTES * (len(days) - 1)
        + (tail_start_ms - session_start_ms(last_day)) // args.past_spacing_ms
    )
    info = {
        "seed": args.seed,
        "symbols": symbols,
        "symbol_count": len(symbols),
        "trading_days": len(days),
        "start_t": start_t,
        "live_start_t": tail_start_ms,
        "end_t": end_t,
        "rows": rows_total,
        "past_spacing_ms": args.past_spacing_ms,
        "tail_spacing_ms": args.tail_spacing_ms,
        "past_bars_per_symbol": past_bars_per_symbol,
        "tail_ticks_per_symbol": int(tail_ms / args.tail_spacing_ms),
    }
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(info, f, indent=2)

    size_mb = os.path.getsize(dataset_path) / 1e6
    print(f"dataset  : {dataset_path} ({size_mb:.1f} MB)")
    print(f"meta     : {meta_path}")
    print(f"json     : {json_path}")
    print(f"symbols  : {len(symbols)}  rows: {rows_total:,}")
    print(f"days     : {days[0].date()} -> {last_day.date()} ({len(days)} trading days)")
    print(f"past     : {past_bars_per_symbol:,} bars/symbol @ {args.past_spacing_ms}ms")
    print(f"tail     : {int(tail_ms / args.tail_spacing_ms):,} ticks/symbol @ {args.tail_spacing_ms}ms, "
          f"live_start_t={tail_start_ms}")
    print(f"tiers    : {', '.join(f'{t}x{c}' for t, c in Counter(meta['tiers']).items())}")
    print(f"volcats  : {', '.join(f'{v}x{c}' for v, c in Counter(meta['vol_cats']).items())}")
    print(f"price range: Rs {min(meta['base_prices']):.2f} - Rs {max(meta['base_prices']):.2f}")

    expect = {t: past_bars_per_symbol + info["tail_ticks_per_symbol"] for t in symbols}
    if not args.no_validate:
        rc = validate(dataset_path, meta, expect)
        print(f"validation: {'PASS' if rc == 0 else 'FAIL'}")
        return rc
    return 0


if __name__ == "__main__":
    sys.exit(main())