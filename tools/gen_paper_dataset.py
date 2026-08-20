#!/usr/bin/env python3
"""Mercatus Arena — realistic synthetic paper-trading dataset generator.

Generates a seedable, realistic market feed for the competition using NumPy:

Market dynamics
  - common market factor + sector factors + idiosyncratic noise so symbols
    move with realistic correlation (sectors move together, stocks don't)
  - regime switching (bull / chop / bear) with GARCH-style volatility
    clustering (calm periods, volatile bursts)
  - intraday U-shaped volatility (busy open, quiet lunch, busy close)
  - random news jumps and an optional flash crash mid-event

Time-scaling
  Every time-based process (news rate, regime transitions, GARCH decay,
  flash-crash duration) is expressed per second and converted to per-tick
  probabilities for the actual --spacing-ms, so changing the tick cadence
  does not change the effective event rate.

Microstructure (default on, --no-microstructure to disable)
  Adds per-tick bid/ask quotes (tier- and volatility-dependent spread),
  OHLC bar structure, trade aggressor direction (B/S), and round-lot
  bid/ask depth — all derived from the same underlying price process, so
  the CSV can drive spread-aware and execution-effect backtests.

Symbol realism
  Symbols come from a curated Indian-style stock-master catalog: realistic
  company names, NSE-style tickers, sectors, reference prices and volatility
  profiles (defensive / normal / high / speculative). Prices are SIMULATED
  reference prices for a virtual exchange - they are not live or historical
  NSE/BSE market data. Market-cap tiers (mega -> micro) drive float, turnover,
  spread and jump scaling; each stock's base price is drawn near its catalog
  reference price within a per-entry band, so a single run naturally spans
  low- (Rs 50-100), mid- (Rs 100-500), high- (Rs 500-2,000) and premium
  (Rs 2,000+) priced instruments.

Calibration & validation
  A short warmup simulation calibrates per-symbol idiosyncratic volatility
  to per-tier annualized targets, then a validation pass re-reads the CSV
  and reports realized vol / correlation / jump rate / spread / turnover
  against targets.

Outputs:
  paper_dataset.csv        -> upload via Admin Console (POST /api/admin/dataset)
  symbols_paper_meta.csv   -> Nasdaq-style meta file (for load-symbols-dataset.ts)

Usage:
    python tools/gen_paper_dataset.py [--symbols 30] [--minutes 180]
        [--spacing-ms 1000] [--seed 42] [--flash-crash] [--out tools/output]
"""

from __future__ import annotations

import argparse
import csv
import math
import os
import sys
import time
from datetime import datetime, time as dtime, timedelta

import numpy as np

# ---------------------------------------------------------------- constants

# Regime transition rates per SECOND (rows = current, cols = next).
REGIME_TRANSITION_PER_SEC = np.array(
    [  # bull, chop, bear
        [0.0, 0.010, 0.005],  # bull drifts to chop/bear
        [0.008, 0.0, 0.007],  # chop
        [0.005, 0.010, 0.0],  # bear
    ]
)
REGIMES = ["bull", "chop", "bear"]

# Per-second drift / volatility per regime.
MARKET_PARAMS = {
    "bull": {"mu": 3.0e-6, "sigma": 5.0e-5},
    "chop": {"mu": 0.0, "sigma": 3.6e-5},
    "bear": {"mu": -2.6e-6, "sigma": 6.5e-5},
}
SECTOR_PARAMS = {
    "bull": {"mu": 1.5e-6, "sigma": 3.5e-5},
    "chop": {"mu": 0.0, "sigma": 2.6e-5},
    "bear": {"mu": -1.5e-6, "sigma": 4.4e-5},
}

GARCH_LAMBDA_PER_SEC = 0.94    # EWMA decay on squared idio returns (per second)
NEWS_RATE_PER_SEC = 2.5e-5     # news events per stock per second (~1 / 11h)
JUMP_SIZE = (0.015, 0.035)     # |news move| for a mid-cap tier symbol

FLASH_CRASH_DUR_S = 75         # crash leg duration in seconds
FLASH_RECOVER_S = 225          # partial-recovery leg duration in seconds
FLASH_RECOVERY_FRAC = 0.65     # fraction of the crash that recovers

MIN_PRICE = 0.05
TICKS_PER_YEAR = 252 * 6.5 * 3600.0  # seconds of market time per year
TRADING_MINUTES_PER_DAY = 390.0
# E[vol_mult] with |z| ~ half-normal(1) and E[ivm] ~ 1.04; normalizes realized
# turnover back to the tier target: E[vol_mult * ivm] ~ 6.0
VOL_MULT_MEAN = 6.0

SECTOR_INDUSTRIES = {
    "Technology": ["Semiconductors", "Software", "Data", "Cloud", "Security", "Networks", "Fintech", "Robotics"],
    "Financial Services": ["Capital", "Bancorp", "Insurance", "Payments", "Asset", "Trust", "Advisory"],
    "Healthcare": ["Bio", "Pharma", "Med", "Health", "Diagnostics", "Care"],
    "Energy": ["Energy", "Petroleum", "Power", "Solar", "Hydro", "Utilities"],
    "Consumer Discretionary": ["Retail", "Auto", "Leisure", "Luxury", "Dining", "Travel"],
    "Industrials": ["Aerospace", "Defense", "Machinery", "Logistics", "Rail", "Industrial"],
    "Consumer Staples": ["Foods", "Beverage", "Consumer", "Household", "Nutrition", "Care"],
    "Communication Services": ["Media", "Telecom", "Entertainment", "Platforms", "Content"],
    "Materials": ["Chemicals", "Metals", "Mining", "Materials", "Packaging"],
    "Utilities": ["Electric", "Utilities", "Water", "Generation"],
    "Real Estate": ["Development", "Properties", "Realty", "Infrastructure"],
}
# Volatility profiles: per-stock persistent multiplier on the tier's annualized
# vol target (not a per-tick random choice). Defensive ~ utilities/FMCG/pharma
# majors, speculative ~ small/micro momentum names.
VOL_CATEGORIES = {
    "defensive": 0.70,
    "normal": 1.00,
    "high": 1.40,
    "speculative": 2.00,
}
VOL_CAT_ORDER = ["defensive", "normal", "high", "speculative"]
MIN_ANN_VOL = 0.12
MAX_ANN_VOL = 1.40

# Safety bounds on the price process. Prices are fractional returns (prices are
# multiplied by exp(r)); these are loose guard rails that stop a pathological
# run from exploding numerically, but are essentially never hit by the model -
# the largest per-tick moves (news jumps ~3.5% + volatility) stay far below the
# per-tick return clamp, so extreme moves remain rare, not impossible.
MIN_PRICE = 0.05
MAX_PRICE = 60_000.0
MAX_TICK_RETURN = 0.15  # 15% in one tick is a hard numerical-safety bound

# Market-cap tiers: probability, annualized vol target, float shares, daily
# turnover, base spread (bps), beta range. Vol targets are raised vs. the old
# model so a one-hour window shows visible (1-3%+) moves instead of a static
# tape; per-stock vol categories multiply them.
TIERS = {
    "mega":  {"prob": 0.07, "ann_vol": 0.30, "float": 6.0e9,  "turnover": 0.006, "spread_bps": 3.5,  "beta": (0.80, 1.20), "jump_scale": 0.7},
    "large": {"prob": 0.22, "ann_vol": 0.42, "float": 1.6e9,  "turnover": 0.008, "spread_bps": 5.5,  "beta": (0.75, 1.30), "jump_scale": 0.9},
    "mid":   {"prob": 0.34, "ann_vol": 0.60, "float": 4.5e8,  "turnover": 0.011, "spread_bps": 9.0,  "beta": (0.65, 1.40), "jump_scale": 1.0},
    "small": {"prob": 0.27, "ann_vol": 0.85, "float": 7.0e7,  "turnover": 0.015, "spread_bps": 16.0, "beta": (0.50, 1.55), "jump_scale": 1.3},
    "micro": {"prob": 0.10, "ann_vol": 1.20, "float": 1.4e7,  "turnover": 0.020, "spread_bps": 32.0, "beta": (0.45, 1.70), "jump_scale": 1.7},
}
TIER_ORDER = ["mega", "large", "mid", "small", "micro"]
TIER_IDX = {t: i for i, t in enumerate(TIER_ORDER)}

# Curated Indian-style stock master. Every entry carries the company name,
# NSE-style trading symbol, sector, market-cap tier, a SIMULATED reference
# price and a volatility profile. The mix is deliberately broad: well-known
# names sit next to smaller companies across sectors, and reference prices span
# ~Rs 15 (penny names) to ~Rs 50,000+ (premium names). Prices are simulated for
# a virtual exchange and are NOT live NSE/BSE quotes.
# fields: (name, symbol, sector, tier, ref_price, vol_cat)
STOCK_MASTER: list[dict] = [
    # --- mega cap (blue chips, premium prices) ---
    {"name": "Reliance Industries Ltd", "symbol": "RELIANCE", "sector": "Energy", "tier": "mega", "ref_price": 2950, "vol_cat": "normal"},
    {"name": "HDFC Bank Ltd", "symbol": "HDFCBANK", "sector": "Financial Services", "tier": "mega", "ref_price": 1750, "vol_cat": "normal"},
    {"name": "ICICI Bank Ltd", "symbol": "ICICIBANK", "sector": "Financial Services", "tier": "mega", "ref_price": 1250, "vol_cat": "normal"},
    {"name": "Infosys Ltd", "symbol": "INFY", "sector": "Technology", "tier": "mega", "ref_price": 1950, "vol_cat": "normal"},
    {"name": "Tata Consultancy Services Ltd", "symbol": "TCS", "sector": "Technology", "tier": "mega", "ref_price": 4200, "vol_cat": "defensive"},
    {"name": "Bharti Airtel Ltd", "symbol": "BHARTIARTL", "sector": "Communication Services", "tier": "mega", "ref_price": 1650, "vol_cat": "normal"},
    {"name": "ITC Ltd", "symbol": "ITC", "sector": "Consumer Staples", "tier": "mega", "ref_price": 480, "vol_cat": "defensive"},
    {"name": "State Bank of India", "symbol": "SBIN", "sector": "Financial Services", "tier": "mega", "ref_price": 850, "vol_cat": "normal"},
    {"name": "Hindustan Unilever Ltd", "symbol": "HINDUNILVR", "sector": "Consumer Staples", "tier": "mega", "ref_price": 2600, "vol_cat": "defensive"},
    {"name": "Larsen & Toubro Ltd", "symbol": "LT", "sector": "Industrials", "tier": "mega", "ref_price": 3900, "vol_cat": "normal"},
    {"name": "Asian Paints Ltd", "symbol": "ASIANPAINT", "sector": "Materials", "tier": "mega", "ref_price": 3200, "vol_cat": "defensive"},
    {"name": "Maruti Suzuki India Ltd", "symbol": "MARUTI", "sector": "Consumer Discretionary", "tier": "mega", "ref_price": 12500, "vol_cat": "normal"},
    # --- large cap ---
    {"name": "Bajaj Finance Ltd", "symbol": "BAJFINANCE", "sector": "Financial Services", "tier": "large", "ref_price": 7800, "vol_cat": "high"},
    {"name": "Tata Motors Ltd", "symbol": "TATAMOTORS", "sector": "Consumer Discretionary", "tier": "large", "ref_price": 1100, "vol_cat": "high"},
    {"name": "Wipro Ltd", "symbol": "WIPRO", "sector": "Technology", "tier": "large", "ref_price": 510, "vol_cat": "normal"},
    {"name": "Mahindra & Mahindra Ltd", "symbol": "M&M", "sector": "Consumer Discretionary", "tier": "large", "ref_price": 3200, "vol_cat": "normal"},
    {"name": "Sun Pharmaceutical Industries", "symbol": "SUNPHARMA", "sector": "Healthcare", "tier": "large", "ref_price": 1850, "vol_cat": "normal"},
    {"name": "Kotak Mahindra Bank", "symbol": "KOTAKBANK", "sector": "Financial Services", "tier": "large", "ref_price": 1850, "vol_cat": "normal"},
    {"name": "Nestle India Ltd", "symbol": "NESTLEIND", "sector": "Consumer Staples", "tier": "large", "ref_price": 2600, "vol_cat": "defensive"},
    {"name": "UltraTech Cement Ltd", "symbol": "ULTRACEMCO", "sector": "Materials", "tier": "large", "ref_price": 11500, "vol_cat": "normal"},
    {"name": "Hindalco Industries Ltd", "symbol": "HINDALCO", "sector": "Materials", "tier": "large", "ref_price": 720, "vol_cat": "high"},
    {"name": "Bharat Electronics Ltd", "symbol": "BEL", "sector": "Industrials", "tier": "large", "ref_price": 210, "vol_cat": "normal"},
    {"name": "Bharat Heavy Electricals Ltd", "symbol": "BHEL", "sector": "Industrials", "tier": "large", "ref_price": 300, "vol_cat": "high"},
    {"name": "Hindustan Aeronautics Ltd", "symbol": "HAL", "sector": "Industrials", "tier": "large", "ref_price": 5400, "vol_cat": "normal"},
    {"name": "Coal India Ltd", "symbol": "COALINDIA", "sector": "Energy", "tier": "large", "ref_price": 480, "vol_cat": "defensive"},
    {"name": "Power Grid Corporation", "symbol": "POWERGRID", "sector": "Utilities", "tier": "large", "ref_price": 340, "vol_cat": "defensive"},
    {"name": "Bajaj Auto Ltd", "symbol": "BAJAJ-AUTO", "sector": "Consumer Discretionary", "tier": "large", "ref_price": 9800, "vol_cat": "normal"},
    {"name": "Tata Steel Ltd", "symbol": "TATASTEEL", "sector": "Materials", "tier": "large", "ref_price": 190, "vol_cat": "high"},
    {"name": "Tech Mahindra Ltd", "symbol": "TECHM", "sector": "Technology", "tier": "large", "ref_price": 1650, "vol_cat": "high"},
    {"name": "Axis Bank Ltd", "symbol": "AXISBANK", "sector": "Financial Services", "tier": "large", "ref_price": 1250, "vol_cat": "high"},
    {"name": "Bosch Ltd", "symbol": "BOSCHLTD", "sector": "Consumer Discretionary", "tier": "large", "ref_price": 34000, "vol_cat": "defensive"},
    {"name": "Abbott India Ltd", "symbol": "ABBOTINDIA", "sector": "Healthcare", "tier": "large", "ref_price": 29000, "vol_cat": "defensive"},
    {"name": "Honeywell Automation", "symbol": "HONAUT", "sector": "Industrials", "tier": "large", "ref_price": 58000, "vol_cat": "defensive"},
    {"name": "3M India Ltd", "symbol": "3MINDIA", "sector": "Materials", "tier": "large", "ref_price": 38000, "vol_cat": "defensive"},
    {"name": "Berger Paints India", "symbol": "BERGEPAINT", "sector": "Materials", "tier": "large", "ref_price": 560, "vol_cat": "normal"},
    {"name": "Godrej Consumer Products", "symbol": "GODREJCP", "sector": "Consumer Staples", "tier": "large", "ref_price": 1400, "vol_cat": "normal"},
    {"name": "Dabur India Ltd", "symbol": "DABUR", "sector": "Consumer Staples", "tier": "large", "ref_price": 650, "vol_cat": "defensive"},
    {"name": "JSW Steel Ltd", "symbol": "JSWSTEEL", "sector": "Materials", "tier": "large", "ref_price": 1050, "vol_cat": "high"},
    {"name": "IndusInd Bank", "symbol": "INDUSINDBK", "sector": "Financial Services", "tier": "large", "ref_price": 1450, "vol_cat": "high"},
    {"name": "Adani Ports & SEZ", "symbol": "ADANIPORTS", "sector": "Industrials", "tier": "large", "ref_price": 1450, "vol_cat": "high"},
    # --- mid cap ---
    {"name": "Tata Power Co Ltd", "symbol": "TATAPOWER", "sector": "Utilities", "tier": "mid", "ref_price": 450, "vol_cat": "high"},
    {"name": "Adani Enterprises Ltd", "symbol": "ADANIENT", "sector": "Energy", "tier": "mid", "ref_price": 3300, "vol_cat": "speculative"},
    {"name": "DLF Ltd", "symbol": "DLF", "sector": "Real Estate", "tier": "mid", "ref_price": 950, "vol_cat": "high"},
    {"name": "Ashok Leyland Ltd", "symbol": "ASHOKLEY", "sector": "Consumer Discretionary", "tier": "mid", "ref_price": 260, "vol_cat": "high"},
    {"name": "Cipla Ltd", "symbol": "CIPLA", "sector": "Healthcare", "tier": "mid", "ref_price": 1650, "vol_cat": "normal"},
    {"name": "Dr Reddy's Laboratories", "symbol": "DRREDDY", "sector": "Healthcare", "tier": "mid", "ref_price": 1350, "vol_cat": "normal"},
    {"name": "Zomato Ltd", "symbol": "ZOMATO", "sector": "Communication Services", "tier": "mid", "ref_price": 280, "vol_cat": "high"},
    {"name": "Yes Bank Ltd", "symbol": "YESBANK", "sector": "Financial Services", "tier": "mid", "ref_price": 18, "vol_cat": "speculative"},
    {"name": "Vodafone Idea Ltd", "symbol": "IDEA", "sector": "Communication Services", "tier": "mid", "ref_price": 15, "vol_cat": "speculative"},
    {"name": "Bharat Sanchar Nigam Ltd", "symbol": "BSNL", "sector": "Communication Services", "tier": "mid", "ref_price": 380, "vol_cat": "defensive"},
    {"name": "GAIL India Ltd", "symbol": "GAIL", "sector": "Energy", "tier": "mid", "ref_price": 210, "vol_cat": "defensive"},
    {"name": "NTPC Ltd", "symbol": "NTPC", "sector": "Utilities", "tier": "mid", "ref_price": 420, "vol_cat": "defensive"},
    {"name": "Grasim Industries", "symbol": "GRASIM", "sector": "Materials", "tier": "mid", "ref_price": 2900, "vol_cat": "normal"},
    {"name": "Eicher Motors Ltd", "symbol": "EICHERMOT", "sector": "Consumer Discretionary", "tier": "mid", "ref_price": 5200, "vol_cat": "normal"},
    {"name": "Hero MotoCorp", "symbol": "HEROMOTOCO", "sector": "Consumer Discretionary", "tier": "mid", "ref_price": 5400, "vol_cat": "normal"},
    {"name": "Titan Company Ltd", "symbol": "TITAN", "sector": "Consumer Discretionary", "tier": "mid", "ref_price": 3600, "vol_cat": "high"},
    {"name": "Divis Laboratories", "symbol": "DIVISLAB", "sector": "Healthcare", "tier": "mid", "ref_price": 6200, "vol_cat": "high"},
    {"name": "Apollo Hospitals", "symbol": "APOLLOHOSP", "sector": "Healthcare", "tier": "mid", "ref_price": 7500, "vol_cat": "normal"},
    {"name": "Lupin Ltd", "symbol": "LUPIN", "sector": "Healthcare", "tier": "mid", "ref_price": 2300, "vol_cat": "normal"},
    {"name": "Ambuja Cements", "symbol": "AMBUJACEM", "sector": "Materials", "tier": "mid", "ref_price": 620, "vol_cat": "normal"},
    {"name": "Shree Cement", "symbol": "SHREECEM", "sector": "Materials", "tier": "mid", "ref_price": 28500, "vol_cat": "normal"},
    {"name": "Gujarat Gas Ltd", "symbol": "GUJGASLTD", "sector": "Energy", "tier": "mid", "ref_price": 720, "vol_cat": "defensive"},
    {"name": "Petronet LNG", "symbol": "PETRONET", "sector": "Energy", "tier": "mid", "ref_price": 380, "vol_cat": "defensive"},
    {"name": "Indian Oil Corporation", "symbol": "IOC", "sector": "Energy", "tier": "mid", "ref_price": 180, "vol_cat": "defensive"},
    {"name": "BPCL", "symbol": "BPCL", "sector": "Energy", "tier": "mid", "ref_price": 340, "vol_cat": "defensive"},
    {"name": "Pidilite Industries", "symbol": "PIDILITIND", "sector": "Materials", "tier": "mid", "ref_price": 3300, "vol_cat": "normal"},
    {"name": "United Spirits", "symbol": "MCDOWELL-N", "sector": "Consumer Staples", "tier": "mid", "ref_price": 1300, "vol_cat": "high"},
    {"name": "Varun Beverages", "symbol": "VBL", "sector": "Consumer Staples", "tier": "mid", "ref_price": 1650, "vol_cat": "high"},
    {"name": "Trent Ltd", "symbol": "TRENT", "sector": "Consumer Discretionary", "tier": "mid", "ref_price": 6800, "vol_cat": "high"},
    {"name": "Prestige Estates", "symbol": "PRESTIGE", "sector": "Real Estate", "tier": "mid", "ref_price": 1650, "vol_cat": "speculative"},
    {"name": "Godrej Properties", "symbol": "GODREJPROP", "sector": "Real Estate", "tier": "mid", "ref_price": 2800, "vol_cat": "speculative"},
    {"name": "Max Healthcare", "symbol": "MAXHEALTH", "sector": "Healthcare", "tier": "mid", "ref_price": 1200, "vol_cat": "normal"},
    # --- small cap ---
    {"name": "Suzlon Energy", "symbol": "SUZLON", "sector": "Energy", "tier": "small", "ref_price": 65, "vol_cat": "speculative"},
    {"name": "Indian Railway Finance Corp", "symbol": "IRFC", "sector": "Financial Services", "tier": "small", "ref_price": 180, "vol_cat": "speculative"},
    {"name": "Rail Vikas Nigam Ltd", "symbol": "RVNL", "sector": "Industrials", "tier": "small", "ref_price": 520, "vol_cat": "speculative"},
    {"name": "NBCC (India) Ltd", "symbol": "NBCC", "sector": "Industrials", "tier": "small", "ref_price": 180, "vol_cat": "speculative"},
    {"name": "NHPC Ltd", "symbol": "NHPC", "sector": "Utilities", "tier": "small", "ref_price": 95, "vol_cat": "defensive"},
    {"name": "SJVN Ltd", "symbol": "SJVN", "sector": "Utilities", "tier": "small", "ref_price": 95, "vol_cat": "speculative"},
    {"name": "SBI Cards & Payment Services", "symbol": "SBICARD", "sector": "Financial Services", "tier": "small", "ref_price": 780, "vol_cat": "normal"},
    {"name": "Cholamandalam Investment", "symbol": "CHOLAFIN", "sector": "Financial Services", "tier": "small", "ref_price": 1450, "vol_cat": "high"},
    {"name": "Muthoot Finance Ltd", "symbol": "MUTHOOTFIN", "sector": "Financial Services", "tier": "small", "ref_price": 1850, "vol_cat": "high"},
    {"name": "Manappuram Finance", "symbol": "MANAPPURAM", "sector": "Financial Services", "tier": "small", "ref_price": 190, "vol_cat": "high"},
    {"name": "Angel One Ltd", "symbol": "ANGELONE", "sector": "Financial Services", "tier": "small", "ref_price": 3100, "vol_cat": "high"},
    {"name": "Aster DM Healthcare", "symbol": "ASTERDM", "sector": "Healthcare", "tier": "small", "ref_price": 480, "vol_cat": "normal"},
    {"name": "Fortis Healthcare", "symbol": "FORTIS", "sector": "Healthcare", "tier": "small", "ref_price": 720, "vol_cat": "normal"},
    {"name": "Cyient Ltd", "symbol": "CYIENT", "sector": "Technology", "tier": "small", "ref_price": 1900, "vol_cat": "normal"},
    {"name": "Persistent Systems", "symbol": "PERSISTENT", "sector": "Technology", "tier": "small", "ref_price": 6500, "vol_cat": "high"},
    {"name": "Bharti Hexacom", "symbol": "BHARTIHEXA", "sector": "Communication Services", "tier": "small", "ref_price": 1550, "vol_cat": "high"},
    {"name": "Tata Communications", "symbol": "TATACOMM", "sector": "Communication Services", "tier": "small", "ref_price": 1900, "vol_cat": "normal"},
    {"name": "HFCL Ltd", "symbol": "HFCL", "sector": "Communication Services", "tier": "small", "ref_price": 110, "vol_cat": "speculative"},
    {"name": "Intellect Design Arena", "symbol": "INTELLECT", "sector": "Technology", "tier": "small", "ref_price": 950, "vol_cat": "high"},
    {"name": "Sona BLW Precision Forgings", "symbol": "SONACOMS", "sector": "Consumer Discretionary", "tier": "small", "ref_price": 680, "vol_cat": "high"},
    {"name": "Amara Raja Energy & Mobility", "symbol": "AMARAJABAT", "sector": "Consumer Discretionary", "tier": "small", "ref_price": 1500, "vol_cat": "normal"},
    {"name": "Exide Industries", "symbol": "EXIDEIND", "sector": "Consumer Discretionary", "tier": "small", "ref_price": 520, "vol_cat": "normal"},
    # --- micro cap / penny names ---
    {"name": "Alok Industries", "symbol": "ALOKINDS", "sector": "Materials", "tier": "micro", "ref_price": 25, "vol_cat": "speculative"},
    {"name": "Nitin Spinners", "symbol": "NITINSPIN", "sector": "Materials", "tier": "micro", "ref_price": 380, "vol_cat": "normal"},
    {"name": "GTL Infrastructure", "symbol": "GTLINFRA", "sector": "Communication Services", "tier": "micro", "ref_price": 20, "vol_cat": "speculative"},
    {"name": "Vaibhav Global", "symbol": "VAIBHAVGBL", "sector": "Consumer Discretionary", "tier": "micro", "ref_price": 320, "vol_cat": "normal"},
    {"name": "Saregama India", "symbol": "SAREGAMA", "sector": "Communication Services", "tier": "micro", "ref_price": 620, "vol_cat": "high"},
    {"name": "Zen Technologies", "symbol": "ZENTEC", "sector": "Industrials", "tier": "micro", "ref_price": 2400, "vol_cat": "high"},
    {"name": "KPI Green Energy", "symbol": "KPIGREEN", "sector": "Utilities", "tier": "micro", "ref_price": 600, "vol_cat": "speculative"},
    {"name": "IRB Infrastructure Developers", "symbol": "IRB", "sector": "Industrials", "tier": "micro", "ref_price": 65, "vol_cat": "high"},
    {"name": "Oberoi Realty", "symbol": "OBEROIRLTY", "sector": "Real Estate", "tier": "micro", "ref_price": 1600, "vol_cat": "normal"},
    {"name": "Gensol Engineering", "symbol": "GENSOL", "sector": "Energy", "tier": "micro", "ref_price": 750, "vol_cat": "speculative"},
]


def minute_of_day_local(t_epoch_ms: int) -> float:
    """Local clock minutes since midnight (market-local, DST-safe)."""
    lt = time.localtime(t_epoch_ms / 1000.0)
    return float(lt.tm_hour * 60 + lt.tm_min + lt.tm_sec / 60.0)


def intraday_vol_multiplier(minute_of_day: np.ndarray) -> np.ndarray:
    """U-shaped volatility: busy first/last 45 min, quiet midday.

    minute_of_day: minutes since midnight (or array of them).
    """
    m = np.asarray(minute_of_day, dtype=float)
    # peaks at 9:30 (570) and 15:45 (945), trough at ~12:45 (765)
    open_burst = 1.15 * np.exp(-(((m - 570) / 55.0) ** 2))
    close_burst = 1.15 * np.exp(-(((m - 945) / 55.0) ** 2))
    return 0.75 + open_burst + close_burst


def next_weekday_epoch_ms(days_ahead: int = 1) -> int:
    """Epoch ms of the next weekday at 09:30 local time."""
    day = datetime.now() + timedelta(days=days_ahead)
    while day.weekday() >= 5:
        day += timedelta(days=1)
    ts = datetime.combine(day.date(), dtime(9, 30, 0))
    return int(ts.timestamp() * 1000)


def regime_transition_per_tick(dt: float) -> np.ndarray:
    """Convert per-second transition rates to per-tick probabilities."""
    P = np.zeros((3, 3))
    for i in range(3):
        total = 0.0
        for j in range(3):
            if i == j:
                continue
            rate = REGIME_TRANSITION_PER_SEC[i][j]
            p = 1.0 - math.exp(-rate * dt) if rate > 0 else 0.0
            P[i][j] = p
            total += p
        P[i][i] = max(0.0, 1.0 - total)
    return P


# ------------------------------------------------------------------ symbols

def make_symbols(rng: np.random.Generator, count: int) -> dict:
    """Pick a seeded universe from the Indian-style STOCK_MASTER catalog.

    Entries are selected per market-cap tier (honouring the TIERS weights), so
    the result keeps the old mega -> micro spread of floats/turnovers/spreads
    while carrying realistic company names, symbols, reference prices and
    persistent per-stock volatility categories. Base prices are drawn near each
    entry's reference price within a per-entry band, so a single universe
    naturally mixes low-, mid-, high- and premium-priced stocks.
    """
    by_tier: dict[str, list[int]] = {t: [] for t in TIER_ORDER}
    for i, rec in enumerate(STOCK_MASTER):
        by_tier[rec["tier"]].append(i)

    # allocate the requested count across tiers proportionally to their weights
    raw = [count * TIERS[t]["prob"] for t in TIER_ORDER]
    counts = [int(x) for x in raw]
    rem = count - sum(counts)
    if rem:
        fracs = [raw[i] - counts[i] for i in range(len(TIER_ORDER))]
        for idx in np.argsort(fracs)[::-1][:rem]:
            counts[int(idx)] += 1
    counts[-1] += count - sum(counts)  # absorb any residual rounding

    chosen_idx: list[int] = []
    for ti, tier in enumerate(TIER_ORDER):
        bucket = by_tier[tier]
        rng.shuffle(bucket)
        for idx in bucket[: min(counts[ti], len(bucket))]:
            chosen_idx.append(idx)

    if len(chosen_idx) < count:  # catalog too small for the request: top up
        rest = [i for i in range(len(STOCK_MASTER)) if i not in set(chosen_idx)]
        rng.shuffle(rest)
        chosen_idx += rest[: count - len(chosen_idx)]

    tickers: list[str] = []
    names: list[str] = []
    sec_names: list[str] = []
    base_prices: list[float] = []
    betas_market: list[float] = []
    betas_sector: list[float] = []
    ann_vols: list[float] = []
    floats: list[float] = []
    turnovers: list[float] = []
    spreads: list[float] = []
    jump_scales: list[float] = []
    tier_list: list[str] = []
    vol_cats: list[str] = []
    ref_prices: list[float] = []

    for i in chosen_idx:
        rec = STOCK_MASTER[i]
        t = TIERS[rec["tier"]]
        ref = rec["ref_price"]
        # price drawn as a percentage move around the reference price, within a
        # per-entry band and the global safety bounds (no single ₹950 ceiling)
        px = float(np.clip(
            rng.lognormal(np.log(ref), 0.12), ref * 0.6, ref * 1.6,
        ))
        px = float(np.clip(px, MIN_PRICE, MAX_PRICE))
        tickers.append(rec["symbol"])
        names.append(rec["name"])
        sec_names.append(rec["sector"])
        base_prices.append(round(px, 2))
        betas_market.append(float(rng.uniform(*t["beta"])))
        betas_sector.append(float(rng.uniform(0.5, 1.2)))
        ann_vols.append(float(np.clip(
            t["ann_vol"] * VOL_CATEGORIES[rec["vol_cat"]],
            MIN_ANN_VOL, MAX_ANN_VOL,
        )))
        floats.append(t["float"])
        turnovers.append(t["turnover"])
        spreads.append(t["spread_bps"])
        jump_scales.append(t["jump_scale"])
        tier_list.append(rec["tier"])
        vol_cats.append(rec["vol_cat"])
        ref_prices.append(ref)

    sectors = sorted({c["sector"] for c in STOCK_MASTER})
    sector_index = {s: i for i, s in enumerate(sectors)}
    n = len(tickers)
    return {
        "tickers": tickers,
        "names": names,
        "sectors": sec_names,
        "sector_idx": np.array([sector_index[s] for s in sec_names]),
        "tiers": tier_list,
        "vol_cats": vol_cats,
        "ref_prices": ref_prices,
        "base_prices": np.round(np.array(base_prices), 2),
        "betas_market": np.array(betas_market),
        "betas_sector": np.array(betas_sector),
        "ann_vols": np.array(ann_vols),
        "floats": np.array(floats),
        "turnovers": np.array(turnovers),
        "spread_bps_base": np.array(spreads),
        "jump_scales": np.array(jump_scales),
        "n_sectors": len(sectors),
    }


# ------------------------------------------------------------------- market

def tick_sigmas(meta: dict, dt: float) -> np.ndarray:
    """Per-symbol per-tick sigma (fractional) from market + sector + idio."""
    m = MARKET_PARAMS["chop"]["sigma"] * math.sqrt(dt)
    s = SECTOR_PARAMS["chop"]["sigma"] * math.sqrt(dt)
    idio_tick = meta["idio_vols"]  # per-tick, post-calibration
    return np.sqrt(
        (meta["betas_market"] * m) ** 2
        + (meta["betas_sector"] * s) ** 2
        + idio_tick**2
    ) + 1e-12


def calibrate_vols(
    meta: dict, rng: np.random.Generator, dt: float, n_ticks: int,
    start_epoch_ms: int, flash_crash: bool, iters: int = 3,
) -> dict:
    """Scale per-symbol idio vol so realized annualized vol hits tier targets.

    The warmup mirrors the main simulation exactly (regime chain, intraday
    vol multiplier, flash crash) so the calibrated vols hold for the real run.
    """
    ticks_per_year = TICKS_PER_YEAR / dt
    lam = GARCH_LAMBDA_PER_SEC ** dt
    p_jump = 1.0 - math.exp(-NEWS_RATE_PER_SEC * dt)
    P = regime_transition_per_tick(dt)
    crash_ticks = max(1, int(FLASH_CRASH_DUR_S / dt))
    recover_ticks = max(1, int(FLASH_RECOVER_S / dt))
    flash_start = None
    flash_amt = 0.0
    if flash_crash:
        flash_start = int(rng.integers(int(n_ticks * 0.55), int(n_ticks * 0.82)))
        flash_amt = rng.uniform(-0.085, -0.055)

    for _ in range(iters):
        returns = np.zeros((n_ticks, len(meta["tickers"])))
        n = len(meta["tickers"])
        idio_var = np.full(n, 0.02)
        regime = 0
        prices = meta["base_prices"].copy()
        prev_rounded = meta["base_prices"].copy()
        t_epoch = start_epoch_ms + int(dt * 1000)
        for k in range(n_ticks):
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
            minute_of_day = minute_of_day_local(t_epoch)
            ivm = float(intraday_vol_multiplier(np.array([minute_of_day]))[0])
            shock = 0.0
            if flash_start is not None:
                if flash_start <= k < flash_start + crash_ticks:
                    shock = flash_amt / crash_ticks
                elif flash_start + crash_ticks <= k < flash_start + crash_ticks + recover_ticks:
                    shock = -flash_amt * FLASH_RECOVERY_FRAC / recover_ticks
            z = rng.standard_normal(n)
            shock_idio = meta["idio_vols"] * np.sqrt(idio_var) * z * ivm
            idio_var = lam * idio_var + (1 - lam) * (z**2)
            jumps = rng.random(n) < p_jump
            if jumps.any():
                signs = np.where(rng.random(n) < 0.5, -1.0, 1.0)
                shock_idio = shock_idio + signs * jumps * rng.uniform(*JUMP_SIZE, size=n) * meta["jump_scales"]
            r = (
                meta["betas_market"] * rm
                + meta["betas_sector"] * rs[meta["sector_idx"]]
                + shock_idio
                + shock
            )
            # realized vol is measured on the ROUNDED mid prices (what the
            # engine, bots and validation actually see), so tick-size
            # quantization noise is part of the calibration target
            # safety bound: clamp the per-tick return; far above any real move
            # (largest jumps ~6%), it only guards against numerical explosion
            prices = np.clip(
                prices * np.exp(np.clip(r, -MAX_TICK_RETURN, MAX_TICK_RETURN)),
                MIN_PRICE, MAX_PRICE,
            )
            rounded = np.round(prices, 2)
            with np.errstate(divide="ignore", invalid="ignore"):
                returns[k] = np.log(rounded / prev_rounded)
            prev_rounded = rounded
            t_epoch += int(dt * 1000)
        realized = returns.std(axis=0, ddof=1) * math.sqrt(ticks_per_year)
        ratio = meta["ann_vols"] / np.maximum(realized, 1e-9)
        meta["idio_vols"] = meta["idio_vols"] * np.power(ratio, 0.6)
    return meta


def simulate(
    meta: dict,
    rng: np.random.Generator,
    minutes: int,
    spacing_ms: int,
    start_epoch_ms: int,
    flash_crash: bool,
    microstructure: bool,
):
    n = len(meta["tickers"])
    total = int(minutes * 60_000 / spacing_ms)
    dt = spacing_ms / 1000.0
    lam = GARCH_LAMBDA_PER_SEC ** dt
    p_jump = 1.0 - math.exp(-NEWS_RATE_PER_SEC * dt)
    P = regime_transition_per_tick(dt)
    crash_ticks = max(1, int(FLASH_CRASH_DUR_S / dt))
    recover_ticks = max(1, int(FLASH_RECOVER_S / dt))

    prices = meta["base_prices"].copy()
    prev_close = meta["base_prices"].copy()
    idio_var = np.full(n, 0.02)  # EWMA of squared idio returns (init 2%)

    # per-symbol volume per tick: float * turnover * window fraction / total,
    # normalized by E[vol_mult * ivm] so realized turnover hits the tier target
    window_frac = minutes / TRADING_MINUTES_PER_DAY
    vol_per_tick = (meta["floats"] * meta["turnovers"] * window_frac) / total / VOL_MULT_MEAN

    # flash crash: -7% market shock, late in the event, then partial recovery
    flash_start = None
    flash_amt = 0.0
    if flash_crash:
        flash_start = int(rng.integers(int(total * 0.55), int(total * 0.82)))
        flash_amt = rng.uniform(-0.085, -0.055)

    regime = 0  # bull
    rows: list[tuple] = []
    flush = 20_000

    t_epoch = start_epoch_ms + spacing_ms
    for k in range(1, total + 1):
        # regime transition (per-tick probabilities)
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

        # market shock, sector shocks (share 45% of the market shock)
        rm = mp["mu"] * dt + mp["sigma"] * math.sqrt(dt) * rng.standard_normal()
        rs = (
            sp["mu"] * dt
            + sp["sigma"] * math.sqrt(dt) * rng.standard_normal(meta["sector_idx"].max() + 1)
            + 0.45 * rm
        )
        minute_of_day = minute_of_day_local(t_epoch)
        ivm = float(intraday_vol_multiplier(np.array([minute_of_day]))[0])

        # flash crash: total move distributed over the (dt-scaled) crash window
        shock = 0.0
        if flash_start is not None:
            if flash_start <= k < flash_start + crash_ticks:
                shock = flash_amt / crash_ticks
            elif flash_start + crash_ticks <= k < flash_start + crash_ticks + recover_ticks:
                shock = -flash_amt * FLASH_RECOVERY_FRAC / recover_ticks

        # pure idiosyncratic shock; vol state is an EWMA of z^2 (mean 1,
        # clusters on big shocks, never decays), so news jumps — added
        # afterwards — never feed the volatility state
        z = rng.standard_normal(n)
        shock_idio = meta["idio_vols"] * np.sqrt(idio_var) * z * ivm
        idio_var = lam * idio_var + (1 - lam) * (z**2)

        # news jumps, scaled in size by market-cap tier
        jumps = rng.random(n) < p_jump
        if jumps.any():
            signs = np.where(rng.random(n) < 0.5, -1.0, 1.0)
            shock_idio = shock_idio + signs * jumps * rng.uniform(*JUMP_SIZE, size=n) * meta["jump_scales"]

        r = (
            meta["betas_market"] * rm
            + meta["betas_sector"] * rs[meta["sector_idx"]]
            + shock_idio
            + shock
        )
        # safety bound: per-tick return clamp + global price floor/ceiling;
        # never hit in normal runs (largest per-tick moves are news jumps ~6%)
        prices = np.clip(
            prices * np.exp(np.clip(r, -MAX_TICK_RETURN, MAX_TICK_RETURN)),
            MIN_PRICE, MAX_PRICE,
        )

        vol_mult = 1.0 + 6.0 * np.abs(shock_idio) / (meta["idio_vols"] + 1e-12)
        # round lots (100) for liquid names, 10-lots for thin names, so the
        # share flow is realistic and the floor never dominates turnover
        lot = np.where(vol_per_tick >= 100.0, 100.0, 10.0)
        volumes = np.maximum(
            np.round(vol_per_tick * vol_mult * ivm / lot) * lot, 1.0
        ).astype(int)

        if microstructure:
            # spread widens with realized vol and intraday activity
            spread_bps = meta["spread_bps_base"] * (
                1.0 + 0.8 * np.abs(shock_idio) / (meta["idio_vols"] + 1e-12)
            ) * (0.8 + 0.4 * ivm)
            half = np.maximum(spread_bps * 0.5 * 1e-4, 1e-4)  # fractional half-spread
            bid = np.maximum(np.round((prices * (1 - half)) / 0.01) * 0.01, 0.01)
            ask = np.maximum(bid + 0.01, np.round((prices * (1 + half)) / 0.01) * 0.01)

            # OHLC bar structure around the tick move
            bar_frac = np.abs(r) * 0.6 + 1e-4
            hi_u = rng.uniform(0.2, 1.0, n)
            lo_u = rng.uniform(0.2, 1.0, n)
            high = np.maximum(prices, prev_close) * (1 + bar_frac * hi_u)
            low = np.maximum(
                np.minimum(prices, prev_close) * (1 - bar_frac * lo_u), 0.01
            )
            open_ = prev_close

            # aggressor direction follows the tick's signed move
            sigma_est = tick_sigmas(meta, dt)
            zscore = r / sigma_est
            p_buy = 1.0 / (1.0 + np.exp(-np.clip(1.8 * zscore, -30.0, 30.0)))
            direction = np.where(rng.random(n) < p_buy, "B", "S")

            # round-lot depth scaled with liquidity tier
            depth = np.maximum(
                np.round(meta["floats"] * 2e-4 * vol_mult * ivm / prices / 100.0) * 100.0,
                100.0,
            ).astype(int)

            for i in range(n):
                rows.append((
                    t_epoch, meta["tickers"][i],
                    round(float(prices[i]), 2), int(volumes[i]),
                    round(float(open_[i]), 2),
                    round(float(high[i]), 2),
                    round(float(low[i]), 2),
                    round(float(bid[i]), 2), round(float(ask[i]), 2),
                    direction[i], int(depth[i]), int(depth[i]),
                ))
        else:
            for i in range(n):
                rows.append((t_epoch, meta["tickers"][i], round(float(prices[i]), 2), int(volumes[i])))

        prev_close = prices.copy()
        t_epoch += spacing_ms

        if len(rows) >= flush:
            yield rows
            rows = []
    if rows:
        yield rows


# ------------------------------------------------------------- validation

def validate(path: str, meta: dict, spacing_ms: int) -> int:
    """Re-read the CSV and compare realized stats against targets."""
    n = len(meta["tickers"])
    dt = spacing_ms / 1000.0
    ticks_per_year = TICKS_PER_YEAR / dt
    tickers = {t: i for i, t in enumerate(meta["tickers"])}

    first = {i: 0.0 for i in range(n)}
    last = {i: 0.0 for i in range(n)}
    rets = [[] for _ in range(n)]
    vols = [0] * n
    spreads = [[] for _ in range(n)]
    total_vol = [0] * n
    n_rows = 0
    jump_counts = [0] * n

    with open(path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        if not {"timestamp", "symbol", "price", "volume"} <= set(reader.fieldnames or []):
            print("error: dataset missing base columns", file=sys.stderr)
            return 1
        prev_px = [0.0] * n
        for row in reader:
            i = tickers.get(row["symbol"].strip().upper())
            if i is None:
                continue
            px = float(row["price"])
            if first[i] == 0.0:
                first[i] = px
            last[i] = px
            vols[i] += int(float(row["volume"] or 0))
            n_rows += 1
            if prev_px[i] > 0:
                rets[i].append(math.log(px / prev_px[i]))
            prev_px[i] = px
            if "bid" in reader.fieldnames and "ask" in reader.fieldnames:
                b, a = float(row["bid"]), float(row["ask"])
                if a > b > 0:
                    spreads[i].append((a - b) / ((a + b) / 2) * 1e4)

    realized_vol = []
    jump_rates = []
    warnings = 0
    print(f"\n=== validation: {path} ({n_rows:,} rows) ===")
    print(f"{'ticker':<12}{'tier':<7}{'vol':<11}{'px':>9}{'annVolT':>8}{'annVolR':>8}"
          f"{'spreadBps':>10}{'jumps/1e6':>10}{'turnover%':>9}  moves")
    for i, t in enumerate(meta["tickers"]):
        r = np.array(rets[i])
        sigma_rob = 1.4826 * float(np.median(np.abs(r))) if len(r) else 0.0
        thresh = max(5 * sigma_rob, 0.012)
        # realized vol excluding news jumps (jumps are validated separately,
        # so a single news event doesn't masquerade as base volatility)
        r_clean = r[np.abs(r) <= thresh]
        rv = float(r_clean.std(ddof=1) * math.sqrt(ticks_per_year)) if len(r_clean) > 1 else 0.0
        realized_vol.append(rv)
        jc = int((np.abs(r) > thresh).sum()) if len(r) else 0
        jump_counts[i] = jc
        jr = jc / (len(r) / 1e6) if len(r) else 0.0
        jump_rates.append(jr)
        spread = float(np.mean(spreads[i])) if spreads[i] else 0.0
        turnover = vols[i] / meta["floats"][i] * 100
        move = (last[i] / first[i] - 1) * 100
        vol_dev = abs(rv - meta["ann_vols"][i]) / meta["ann_vols"][i]
        if vol_dev > 0.35:
            warnings += 1
        print(f"{t:<12}{meta['tiers'][i]:<7}{meta['vol_cats'][i]:<11}{first[i]:>9.2f}"
              f"{meta['ann_vols'][i]:>8.2f}{rv:>8.2f}{spread:>10.1f}{jr:>10.1f}"
              f"{turnover:>9.2f}  {move:+.1f}%"
              f"{'  <-- vol deviates' if vol_dev > 0.35 else ''}")

    # cross-sectional correlation of log returns
    min_len = min(len(r) for r in rets)
    M = np.array([r[:min_len] for r in rets])
    corr = np.corrcoef(M)
    off = corr[np.triu_indices(n, k=1)]
    corr_mean = float(off.mean()) if off.size else 0.0

    exp_jumps_per_1e6 = (1.0 - math.exp(-NEWS_RATE_PER_SEC * dt)) * 1e6
    realized_jr = float(np.mean(jump_rates))
    print(f"\ncorrelation (mean |off-diag|): {corr_mean:.2f}  (target ~0.3-0.55)")
    print(f"jump rate per 1e6 ticks     : {realized_jr:.1f}  (expected {exp_jumps_per_1e6:.1f})")
    print(f"annualized vol (mean)       : {np.mean(realized_vol):.2f}  "
          f"(target {np.mean(meta['ann_vols']):.2f})")
    by_tier = {t: [] for t in TIER_ORDER}
    for i, t in enumerate(meta["tickers"]):
        by_tier[meta["tiers"][i]].append(np.mean(spreads[i]) if spreads[i] else 0.0)
    spread_report = ", ".join(
        f"{t} {np.mean(by_tier[t]):.1f} (t {TIERS[t]['spread_bps']:.1f})"
        for t in TIER_ORDER if by_tier[t]
    )
    print(f"spread bps by tier          : {spread_report}")
    print(f"flash crash                 : {'present (see moves < -3%)' if any((last[i]/first[i]-1)*100 < -3 for i in range(n)) else 'none'}")
    ok = warnings == 0
    print(f"validation                  : {'PASS' if ok else f'{warnings} WARNING(S)'}")
    return 0 if ok else 2


# ------------------------------------------------------------------- output

META_HEADER = (
    "Nasdaq Traded,Symbol,Security Name,Listing Exchange,Market Category,"
    "ETF,Round Lot Size,Test Issue,Financial Status,CQS Symbol,"
    "NASDAQ Symbol,NextShares"
)


def write_meta(meta: dict, path: str) -> None:
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(META_HEADER.split(","))
        for i, t in enumerate(meta["tickers"]):
            w.writerow(
                [
                    "Y", t, meta["names"][i], "N", "Q", "N", "100.0", "N",
                    "", t, t, "N",
                ]
            )


# -------------------------------------------------------------------- main

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--symbols", type=int, default=30, help="number of tickers (default 30)")
    ap.add_argument("--minutes", type=int, default=180, help="event length in minutes (default 180)")
    ap.add_argument("--spacing-ms", type=int, default=1000, help="tick spacing in ms (default 1000)")
    ap.add_argument("--seed", type=int, default=42, help="random seed (default 42)")
    ap.add_argument("--start-epoch-ms", type=int, default=None, help="first tick epoch ms (default: next weekday 09:30)")
    ap.add_argument("--flash-crash", action="store_true", help="inject a mid-event flash crash")
    ap.add_argument("--no-microstructure", action="store_true", help="emit only timestamp,symbol,price,volume")
    ap.add_argument("--no-calibrate", action="store_true", help="skip idio-vol calibration warmup")
    ap.add_argument("--no-validate", action="store_true", help="skip the post-generation validation report")
    ap.add_argument("--out", default="tools/output", help="output directory (default tools/output)")
    args = ap.parse_args()

    if args.minutes <= 0 or args.spacing_ms <= 0:
        print("error: minutes and spacing-ms must be positive", file=sys.stderr)
        return 1

    out_dir = os.path.abspath(args.out)
    os.makedirs(out_dir, exist_ok=True)
    dataset_path = os.path.join(out_dir, "paper_dataset.csv")
    meta_path = os.path.join(out_dir, "symbols_paper_meta.csv")

    start_epoch_ms = args.start_epoch_ms or next_weekday_epoch_ms()
    rng = np.random.default_rng(args.seed)

    meta = make_symbols(rng, args.symbols)

    total_ticks = args.minutes * 60_000 // args.spacing_ms
    dt = args.spacing_ms / 1000.0
    # initial idio vol guess: target ann vol minus market+sector contribution
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
        meta = calibrate_vols(
            meta, rng, dt, n_ticks=max(1200, min(3000, total_ticks // 3)),
            start_epoch_ms=start_epoch_ms, flash_crash=args.flash_crash,
        )

    header = ["timestamp", "symbol", "price", "volume"]
    if not args.no_microstructure:
        header += ["open", "high", "low", "bid", "ask", "direction", "bid_qty", "ask_qty"]

    rows = 0
    first_px: dict[str, float] = {}
    last_px: dict[str, float] = {}
    with open(dataset_path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(header)
        for chunk in simulate(
            meta, rng, args.minutes, args.spacing_ms, start_epoch_ms,
            args.flash_crash, not args.no_microstructure,
        ):
            w.writerows(chunk)
            rows += len(chunk)
            for rec in chunk:
                sym = rec[1]
                px = rec[2]
                if sym not in first_px:
                    first_px[sym] = px
                last_px[sym] = px

    write_meta(meta, meta_path)

    start_dt = datetime.fromtimestamp(start_epoch_ms / 1000)
    end_dt = datetime.fromtimestamp((start_epoch_ms + total_ticks * args.spacing_ms) / 1000)
    size_mb = os.path.getsize(dataset_path) / 1e6

    print(f"dataset  : {dataset_path} ({size_mb:.1f} MB)")
    print(f"meta     : {meta_path}")
    print(f"symbols  : {args.symbols}  ticks/symbol: {total_ticks}  rows: {rows:,}")
    print(f"window   : {start_dt:%Y-%m-%d %H:%M} -> {end_dt:%H:%M}  spacing {args.spacing_ms}ms  seed {args.seed}")
    print(f"flash    : {'yes (mid-event)' if args.flash_crash else 'no'}")
    print(f"micro    : {'on' if not args.no_microstructure else 'off'}")
    print(f"sectors  : {', '.join(sorted(set(meta['sectors'])))}")
    print(f"tiers    : {', '.join(f'{t}x{c}' for t, c in __import__('collections').Counter(meta['tiers']).items())}")
    print(f"volcats  : {', '.join(f'{v}x{c}' for v, c in __import__('collections').Counter(meta['vol_cats']).items())}")
    print(f"price range: Rs {min(meta['base_prices']):.2f} - Rs {max(meta['base_prices']):.2f}")

    print("\n=== simulated stock universe (virtual exchange, prices are simulated) ===")
    print(f"{'symbol':<12}{'company':<42}{'sector':<24}{'tier':<7}{'vol':<12}{'start Rs':>11}")
    for i, t in enumerate(meta["tickers"]):
        print(f"{t:<12}{meta['names'][i]:<42}{meta['sectors'][i]:<24}"
              f"{meta['tiers'][i]:<7}{meta['vol_cats'][i]:<12}{meta['base_prices'][i]:>11.2f}")
    print("price bands: "
          + ", ".join(f"{lb}-{ub}: {sum(1 for p in meta['base_prices'] if lb <= p < ub)}"
                      for lb, ub in [(50, 100), (100, 500), (500, 1000), (1000, 2000), (2000, 2500), (2500, 10_000), (10_000, 1e9)])
          + f" (below 50: {sum(1 for p in meta['base_prices'] if p < 50)})")

    moves = sorted(
        ((s, (last_px[s] / first_px[s] - 1) * 100) for s in first_px),
        key=lambda x: -x[1],
    )
    print(f"moves    : {', '.join(f'{s} {m:+.1f}%' for s, m in moves[:5])} ... "
          f"{', '.join(f'{s} {m:+.1f}%' for s, m in moves[-3:])}")

    if not args.no_validate:
        rc = validate(dataset_path, meta, args.spacing_ms)
        return rc
    return 0


if __name__ == "__main__":
    sys.exit(main())