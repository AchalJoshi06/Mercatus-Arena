# Mercatus Arena

> Real-time algorithmic paper-trading platform for TechVerse 2026.

---

## What It Does

Mercatus Arena simulates a live stock market where student teams deploy trading algorithms against synthetic market data. Every team trades the identical shared market feed over REST + WebSocket, and the platform measures per-request millisecond latency. Final standings blend live trading PnL with judge-scored code quality and strategy reports.

**Core loop:**

1. Admin uploads or generates a synthetic market dataset (realistic price series with sector correlation, volatility regimes, and flash crashes).
2. The engine replays the dataset at configurable speed, injecting noise, personality drift, and synthetic order-book activity.
3. Teams connect via WebSocket to receive live tick data, then place buy/sell orders via REST using their API key.
4. Orders execute atomically against live prices with full position tracking, cash management, and brokerage fees.
5. A scoring engine reconstructs each team's equity curve, computes risk-adjusted metrics, and blends them with judge scores.

---

## Architecture

```
+-----------------------------------------------------+
|                    Next.js 15                        |
|  Trading Desk | Admin Console | Leaderboard | Docs   |
+----------+--------------------------+----------------+
           | REST + WS               | REST
           v                         v
+-----------------------------------------------------+
|              Express + PostgreSQL                    |
|                                                      |
|  +----------+  +----------+  +--------------------+ |
|  |  Engine   |  |  Auth    |  |  Scoring Engine    | |
|  |  (tick    |  |  (JWT +  |  |  (equity curve,    | |
|  |   loop)   |  |  API key)|  |   drawdown, risk)  | |
|  +----------+  +----------+  +--------------------+ |
|  +----------+  +----------+  +--------------------+ |
|  |  Atomic   |  |  Rate    |  |  Autograder        | |
|  |  Orders   |  |  Limiter |  |  (LLM code review) | |
|  +----------+  +----------+  +--------------------+ |
+---------------------------+-------------------------+
                            |
                       PostgreSQL 16
```

**Monorepo workspaces:** `server/` and `web/` managed via npm workspaces.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js >= 20, TypeScript (strict) |
| Server | Express 4, ws (WebSocket), pg (PostgreSQL), bcryptjs, jsonwebtoken, multer |
| Database | PostgreSQL 16, atomic order execution, Postgres-backed rate limiting |
| Frontend | Next.js 15 (App Router), React 19, Tailwind CSS 4, lightweight-charts, motion |
| Auth | JWT + bcrypt, helmet, express-rate-limit, production env guards |
| Testing | Vitest + Supertest -- 42 tests |
| Infra | Docker Compose (local Postgres), Render blueprint (render.yaml), Vercel-ready frontend |

---

## Event Lifecycle

```
PRE_LAUNCH --> ACTIVE_MARKET --> API_FROZEN --> EVENT_CONCLUDED
```

| State | Trading | Prices | Leaderboard | Description |
|-------|---------|--------|-------------|-------------|
| `PRE_LAUNCH` | Blocked | Frozen | Hidden | Admin configures teams, uploads datasets |
| `ACTIVE_MARKET` | Open | Ticking | Live | Teams trade in real time |
| `API_FROZEN` | Blocked | Ticking | Frozen | No new orders; prices still move |
| `EVENT_CONCLUDED` | Blocked | Frozen | Final | Scoring computed, rankings final |

**Auto-transitions** driven by two timestamps in `event_config`:

- `api_freeze_at` -- when the API freezes (blackout period before end)
- `scheduled_end_at` -- when the event concludes

The engine checks these every tick and transitions automatically.

---

## Database Schema

13 tables total. Schema self-heals on startup via `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE ADD COLUMN IF NOT EXISTS`.

### teams

| Column | Type | Notes |
|--------|------|-------|
| `id` | SERIAL PRIMARY KEY | |
| `name` | TEXT NOT NULL UNIQUE | Team display name |
| `email` | TEXT NOT NULL UNIQUE | Login email |
| `password_hash` | TEXT NOT NULL | bcrypt hash |
| `role` | TEXT DEFAULT 'team' | `team`, `admin`, or `evaluator` |
| `api_key` | TEXT UNIQUE | `sk_` followed by 48 hex chars |
| `cash` | NUMERIC DEFAULT 100000 | Starting capital in rupees |
| `frozen` | BOOLEAN DEFAULT false | Admin can freeze a team |
| `token_version` | INTEGER DEFAULT 0 | Bump to revoke all JWTs |
| `created_at` | TIMESTAMPTZ | |

### holdings

| Column | Type | Notes |
|--------|------|-------|
| `id` | SERIAL PRIMARY KEY | |
| `team_id` | INTEGER REFERENCES teams(id) | |
| `symbol` | TEXT NOT NULL | |
| `quantity` | INTEGER DEFAULT 0 | Long-only (CHECK >= 0) |
| `avg_buy_price` | NUMERIC DEFAULT 0 | Weighted average |
| UNIQUE | (team_id, symbol) | One position per symbol per team |

### order_logs

| Column | Type | Notes |
|--------|------|-------|
| `id` | SERIAL PRIMARY KEY | |
| `team_id` | INTEGER REFERENCES teams(id) | |
| `symbol` | TEXT NOT NULL | |
| `side` | TEXT NOT NULL | `BUY` or `SELL` |
| `qty` | INTEGER NOT NULL | |
| `price` | NUMERIC | NULL for market orders |
| `status` | TEXT NOT NULL | `FILLED`, `REJECTED`, `PARTIAL` |
| `reason` | TEXT | Rejection reason if applicable |
| `fill_price` | NUMERIC | Actual execution price |
| `latency_ms` | NUMERIC | Server-side processing time |
| `fee` | NUMERIC DEFAULT 0 | Brokerage fee |
| `created_at` | TIMESTAMPTZ | |

### submissions

| Column | Type | Notes |
|--------|------|-------|
| `id` | SERIAL PRIMARY KEY | |
| `team_id` | INTEGER REFERENCES teams(id) | |
| `report_url` | TEXT | Strategy report PDF URL |
| `code_url` | TEXT | Code repository URL |
| `created_at` | TIMESTAMPTZ | |

### scoring

| Column | Type | Notes |
|--------|------|-------|
| `id` | SERIAL PRIMARY KEY | |
| `team_id` | INTEGER UNIQUE | One score per team |
| `pnl_rank` | INTEGER | Rank by PnL (1 = best) |
| `pnl_score` | NUMERIC | Normalized PnL component |
| `drawdown_score` | NUMERIC | Max drawdown penalty |
| `risk_score` | NUMERIC | Sharpe-style risk metric |
| `consistency_score` | NUMERIC | Fraction of positive equity buckets |
| `efficiency_score` | NUMERIC | Penalty for rejects + slow API |
| `code_quality` | NUMERIC | Judge score (0-100) |
| `strategy_report` | NUMERIC | Judge score (0-100) |
| `final_score` | NUMERIC | Composite score |
| `updated_at` | TIMESTAMPTZ | |

### event_config (singleton -- exactly one row)

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `id` | INTEGER | 1 | Primary key |
| `state` | TEXT | `PRE_LAUNCH` | Current lifecycle state |
| `start_capital` | NUMERIC | 100000 | Per-team starting cash |
| `tick_interval_ms` | INTEGER | 1000 | Milliseconds between ticks |
| `replay_speed` | NUMERIC | 1.0 | Dataset replay multiplier |
| `volatility_multiplier` | NUMERIC | 1.0 | Global volatility scaler |
| `circuit_pct` | NUMERIC | 5 | Circuit breaker band (%) |
| `api_freeze_at` | TIMESTAMPTZ | NULL | When API auto-freezes |
| `scheduled_end_at` | TIMESTAMPTZ | NULL | When event auto-concludes |
| `api_revealed` | BOOLEAN | false | Whether API keys are visible |
| `leaderboard_frozen` | BOOLEAN | false | Whether rankings are frozen |
| `crash_auto` | BOOLEAN | true | Auto flash crashes enabled |
| `crash_window_s` | INTEGER | 600 | Seconds between crash windows |
| `crash_shock_min_pct` | NUMERIC | 2 | Minimum crash shock (%) |
| `crash_shock_max_pct` | NUMERIC | 4 | Maximum crash shock (%) |
| `crash_prob_none` | NUMERIC | 0.03 | Probability of no crash per window |
| `crash_prob_two` | NUMERIC | 0.02 | Probability of two shocks per window |
| `dataset_id` | INTEGER | NULL | FK to active market_datasets row |

### market_datasets

| Column | Type | Notes |
|--------|------|-------|
| `id` | SERIAL PRIMARY KEY | |
| `name` | TEXT NOT NULL | Dataset label |
| `symbols` | TEXT[] NOT NULL | Array of symbol tickers |
| `start_t` | BIGINT NOT NULL | First tick timestamp |
| `end_t` | BIGINT NOT NULL | Last tick timestamp |
| `uploaded_by` | INTEGER | FK to teams |
| `created_at` | TIMESTAMPTZ | |

### dataset_ticks

| Column | Type | Notes |
|--------|------|-------|
| `id` | SERIAL PRIMARY KEY | |
| `dataset_id` | INTEGER | FK to market_datasets |
| `seq` | BIGINT NOT NULL | Sequence number within dataset |
| `t` | BIGINT NOT NULL | Timestamp (ms since epoch) |
| `symbol` | TEXT NOT NULL | |
| `price` | NUMERIC NOT NULL | |
| `volume` | INTEGER DEFAULT 0 | |

Index: `(dataset_id, seq, symbol)` for fast sequential reads.

### market_state

| Column | Type | Notes |
|--------|------|-------|
| `dataset_id` | INTEGER PRIMARY KEY | FK to market_datasets |
| `last_t` | BIGINT DEFAULT 0 | Last replayed tick position |

### live_prices

| Column | Type | Notes |
|--------|------|-------|
| `symbol` | TEXT PRIMARY KEY | |
| `price` | NUMERIC NOT NULL | Current price |
| `prev_price` | NUMERIC | Previous tick price |

### leaderboard_snapshot

| Column | Type | Notes |
|--------|------|-------|
| `id` | SERIAL PRIMARY KEY | |
| `snapshot` | JSONB NOT NULL | Full leaderboard array |
| `created_at` | TIMESTAMPTZ | |

### request_logs

| Column | Type | Notes |
|--------|------|-------|
| `id` | SERIAL PRIMARY KEY | |
| `method` | TEXT NOT NULL | HTTP method |
| `path` | TEXT NOT NULL | Request path |
| `status` | INTEGER | HTTP status code |
| `latency_ms` | NUMERIC | Response time |
| `team_id` | INTEGER | Authenticated team (if any) |
| `created_at` | TIMESTAMPTZ | |

### rate_limits

| Column | Type | Notes |
|--------|------|-------|
| `key` | TEXT PRIMARY KEY | Rate limit bucket key |
| `count` | INTEGER DEFAULT 1 | Current count |
| `expires_at` | TIMESTAMPTZ NOT NULL | Window expiry |

---

## Authentication

Two independent auth mechanisms:

### 1. JWT Bearer Tokens (Portal)

Used by the web frontend (Trading Desk, Admin Console, etc.).

```
Authorization: Bearer <jwt>
```

- 24-hour expiry
- Payload: `{ id, email, role }`
- Token versioning: each team has a `token_version` column. Bumping it (via logout or password change) instantly revokes all existing tokens.

### 2. API Key Header (Trading API)

Used by team trading bots.

```
x-api-key: sk_<48 hex chars>
```

- Generated on team registration
- Direct database lookup, no JWT overhead
- Masked in all admin/evaluator views until explicitly revealed

### Middleware Stack

```
requirePortal -> requireAdmin / requireRole("evaluator") -> requireApiKey
```

- `requirePortal`: Verifies JWT, attaches `req.user`
- `requireAdmin`: Checks `role === 'admin'`
- `requireRole(r)`: Checks `role === r`
- `requireApiKey`: Looks up team by `x-api-key` header, attaches `req.team`

---

## API Reference

Base URL: `http://localhost:4040` -- all routes under `/api`.

### Auth Routes (`/api/auth/`)

| Method | Path | Auth | Body | Description |
|--------|------|------|------|-------------|
| POST | `/register` | None | `{ name, email, password, code? }` | Create team (optional registration code) |
| POST | `/login` | None | `{ email, password }` | Returns `{ team, token }` |
| POST | `/logout` | JWT | -- | Revokes token (bumps token_version) |
| POST | `/password` | JWT | `{ current, next }` | Change password |
| GET | `/me` | JWT | -- | Current user profile |

### Trade Routes (`/api/trade/`)

| Method | Path | Auth | Body | Description |
|--------|------|------|------|-------------|
| POST | `/buy` | API Key | `{ symbol, qty, price? }` | Buy order (market or limit) |
| POST | `/sell` | API Key | `{ symbol, qty, price? }` | Sell order (market or limit) |

Order response shape:

```json
{
  "orderId": 123,
  "status": "FILLED",
  "symbol": "RELIANCE",
  "side": "BUY",
  "qty": 10,
  "fillPrice": 2456.78,
  "fee": 0,
  "latencyMs": 12.34
}
```

### Team Routes (`/api/team/`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/portfolio` | JWT | Full portfolio (cash, positions, live prices) |
| GET | `/trades` | JWT | Order history (limit 200-1000) |
| POST | `/submission` | JWT | Upload strategy PDF + code link |
| GET | `/submission` | JWT | View own submission |

### Market Routes (`/api/market/`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/status` | None | Full engine status |
| GET | `/snapshot` | None | All current prices |
| GET | `/leaderboard` | None | Live or frozen leaderboard |
| GET | `/symbols` | None | Available symbol list |
| GET | `/depth` | None | Order books + circuit status |
| GET | `/history` | None | OHLCV candle data (1s/1m/5m/15m/1h) |

### Admin Routes (`/api/admin/`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/control` | Admin | Start/pause/resume/halt/reveal/freeze |
| POST | `/config` | Admin | Update event config |
| POST | `/volatility` | Admin | Set volatility multiplier |
| POST | `/flash-crash` | Admin | Trigger manual flash crash |
| GET | `/crash-config` | Admin | View auto-crash settings |
| POST | `/crash-config` | Admin | Toggle auto-crash |
| POST | `/dataset` | Admin | Upload CSV dataset |
| POST | `/dataset/synthetic` | Admin | Generate synthetic dataset |
| POST | `/users` | Admin | Create team/evaluator/admin |
| GET | `/teams` | Admin | List all teams |
| POST | `/teams/:id/freeze` | Admin | Toggle team frozen state |
| POST | `/teams/:id/reset` | Admin | Reset team to starting capital |
| PATCH | `/teams/:id` | Admin | Edit team fields |
| DELETE | `/teams/:id` | Admin | Delete team |
| GET | `/teams/:id/audit` | Admin | Order + request logs |
| POST | `/scoring` | Admin | Set judge scores |
| POST | `/scoring/compute` | Admin | Recompute all final scores |
| GET | `/scoring` | Admin | View all scores |
| POST | `/autograde` | Admin | Run LLM autograder |
| GET | `/metrics` | Admin | Latency, fills, live prices |

### Evaluator Routes (`/api/evaluator/`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/teams` | Evaluator | List teams for evaluation |
| GET | `/teams/:id/audit` | Evaluator | Team trade audit |
| GET | `/teams/:id/submission` | Evaluator | View team submission |
| POST | `/scoring` | Evaluator | Set code quality + report scores |
| POST | `/scoring/compute` | Evaluator | Recompute final scores |
| GET | `/scoring` | Evaluator | View all scores |
| GET | `/metrics` | Evaluator | System metrics |

---

## WebSocket Protocol

**Connection:** `ws://host:4040/ws` with JWT in `Authorization: Bearer` header or `mercatus.<token>` subprotocol.

**Authentication:** Server verifies JWT on connect. Invalid token = connection rejected.

**Heartbeat:** Server sends `ping` every 30 seconds. Client must respond with `pong`.

### Server to Client Frames

| Type | Payload | Description |
|------|---------|-------------|
| `hello` | Full market status + 600-tick history | Sent on connect |
| `tick` | `{ t, ts, prices[], books[] }` | Market data update (every tick) |
| `trade` | `{ symbol, side, qty, price, ts }` | Synthetic trade by the engine |
| `order` | `{ orderId, status, symbol, side, qty, fillPrice, fee, latencyMs }` | Team's own order result (filtered) |
| `state` | `{ state, paused? }` | Event lifecycle state change |
| `flash` | `{ shock, symbols, decay }` | Flash crash trigger |
| `circuit` | `{ symbol, side, level }` | Circuit breaker event |
| `crash_config` | `{ auto }` | Auto-crash toggle notification |
| `credentials_revealed` | -- | Admin revealed API keys |
| `leaderboard_frozen` | -- | Leaderboard snapshot taken |

### Order Frames (team-filtered)

When a team places an order, the result is broadcast **only to that team** via the `order` frame. Other teams do not see it.

---

## Trading Mechanics

### Order Types

**Market order:** `price` omitted. Fills immediately at the current `live_prices` price.

**Limit order:** `price` provided. Fills only when the market crosses your limit:
- BUY: fills only if current market price >= your limit price
- SELL: fills only if current market price <= your limit price
- If not met: rejected with `LIMIT_NOT_REACHED`

### Position Tracking

- Long-only. Shorting is rejected (`INSUFFICIENT_POSITION` when closing more than held).
- Weighted average buy price updated on each buy.
- FIFO realized PnL calculated in portfolio route.

### Brokerage

| Condition | Fee |
|-----------|-----|
| First 100 successful fills | Free |
| After 100 fills | 10 rupees per trade |

Fee is deducted from cash at fill time.

### Rejection Reasons

| Reason | When |
|--------|------|
| `UNKNOWN_TEAM` | API key not found |
| `TEAM_FROZEN` | Team is frozen by admin |
| `MARKET_NOT_ACTIVE:<state>` | Market is not in ACTIVE_MARKET state |
| `MARKET_PAUSED` | Market is paused |
| `INVALID_SYMBOL` | Symbol not in current dataset |
| `LIMIT_NOT_REACHED` | Limit order price not met by market |
| `INSUFFICIENT_FUNDS` | Not enough cash for buy |
| `INSUFFICIENT_POSITION` | Trying to sell more than held |

### Order Execution Flow

All trades execute inside a PostgreSQL transaction:

1. `SELECT ... FOR UPDATE` on team row (row-level locking)
2. Validate: team not frozen, market is active, symbol exists
3. Check limit order conditions (if applicable)
4. Calculate brokerage fee (10 rupees after first 100 fills)
5. BUY: debit cash (notional + fee), upsert holdings (weighted avg buy price)
6. SELL: validate position, debit holdings, credit cash (notional - fee)
7. Recompute `total_portfolio_value` (cash + sum of holdings * live price)
8. Log order to `order_logs`
9. Broadcast result via WebSocket to the team only

---

## Market Engine

The `EventEngine` class in `server/src/engine.ts` is the heart of the system.

### Tick Loop

Runs every 1000ms (configurable via `TICK_INTERVAL_MS`). Each tick:

1. Advance replay cursor through dataset ticks at `replay_speed` multiplier
2. For each symbol in the current tick batch:
   - Read base price from dataset
   - Apply noise (random walk)
   - Apply personality drift (per-symbol bias)
   - Apply flash crash shock (if active)
   - Apply random wiggle
   - Clamp to circuit breaker bands
3. Update `live_prices` table
4. Generate synthetic order book (5-level bid/ask)
5. Run 1-3 synthetic trades per tick
6. Broadcast tick + trade frames to all WebSocket clients
7. Check auto-transition timestamps (api_freeze_at, scheduled_end_at)

### Price Generation Formula

```
final_price = base_price * (1 + noise + drift + shock + wiggle)
```

Where:
- `base_price`: from dataset_ticks (interpolated between ticks)
- `noise`: random walk scaled by volatility
- `drift`: per-symbol personality bias (mulberry32 PRNG seeded by symbol hash)
- `shock`: flash crash decay envelope (exponential decay)
- `wiggle`: tiny random perturbation for micro-movement

### Personality System

Each symbol gets deterministic, restart-safe behavior via `mulberry32` PRNG seeded by symbol hash:

| Property | Range | Description |
|----------|-------|-------------|
| `drift` | +/-0.0003/s | Per-second return bias (some symbols trend up/down) |
| `vol` | 0.35 - 2.75 | Volatility multiplier (sleepy vs. wild) |
| `periodSec` | 900 - 3600s | Regime cycle period (sine wave) |
| `phase` | random | Offset so symbols are out of sync |

### Circuit Breaker

Per-symbol price bands based on `circuit_pct` (default 5%):

| Level | Band | Action |
|-------|------|--------|
| 0 | price < 0.5x band | Normal |
| 1 | 0.5x <= price < 1x band | Warning broadcast |
| 2 | 1x <= price < 2x band | Price clamped, broadcast |
| 3 | price >= 2x band | Hard clamp, broadcast |

When a price hits a band boundary, it is clamped and a `circuit` frame is broadcast to all clients.

### Synthetic Order Book

Each tick generates a 5-level bid/ask book per symbol:
- Spread: 0.1% - 0.5% of mid price (random)
- Depth: random quantity at each level
- 1-3 synthetic trades executed per tick at bid/ask prices

### Wall-Clock Continuity

On restart, the engine recalculates `startWallMs` from the current dataset position to resume correctly without losing time.

---

## Scoring System

### Composite Formula

```
final_score = 0.60 * pnl_score + 0.20 * code_quality + 0.15 * strategy_report + 0.05 * efficiency
```

### PnL Score Breakdown (of the 60%)

```
pnl_score = 0.45 * norm + 0.20 * drawdown + 0.15 * risk + 0.20 * consistency
```

Where:

**Normalization (45%):**
- 50% rank position (how you rank vs other teams)
- 50% return magnitude (normalized to best return)
- Blended 50/50 into a single 0-100 score

**Drawdown (20%):**
- Reconstructs equity curve from all fills
- Finds maximum drawdown (peak-to-trough decline)
- Exponential penalty: `100 * exp(-6 * max_drawdown)`
- Severe drawdowns get very low scores

**Risk (15%):**
- Sharpe-style ratio: `tanh(mean_returns / std_returns)`
- Penalizes volatile equity curves with unstable returns
- Bounded to 0-100 via tanh

**Consistency (20%):**
- Divides equity curve into 12 time buckets
- Counts fraction of buckets with non-negative equity change
- More consistent returns = higher score

### Equity Curve Reconstruction

1. Collect all fills from `order_logs` for the team
2. Find first and last trade timestamps
3. Create 60 evenly-spaced sample points between them
4. At each point, calculate: cash + sum(positions * price_at_time)
5. `price_at_time()` uses binary search on `dataset_ticks` to find the exact price

### Efficiency Score

```
efficiency = 100 - 70 * reject_rate - penalty(avg_latency - 50ms)
```

- Penalizes rejected orders (wasted API calls)
- Penalizes slow API usage (>50ms average)
- Normalized to 0-100

### Admin Metrics

`adminMetrics()` provides operational visibility:
- Request counts by endpoint
- p95/p99 latency percentiles
- Per-team fill/reject rates
- Live price snapshots

---

## Flash Crash System

### Manual Triggers

Admin triggers via `POST /api/admin/flash-crash`:
- `shock`: percentage (e.g., -5 for 5% drop)
- `symbols`: optional array of specific symbols (random if omitted)
- `decay`: decay rate (default 0.9 per tick)

### Automatic System

Enabled by default (`CRASH_AUTO=1`):

| Parameter | Default | Description |
|-----------|---------|-------------|
| `crash_window_s` | 600 | Seconds between crash windows (10 min) |
| `crash_prob_none` | 0.03 | 3% chance of no crash per window |
| `crash_prob_two` | 0.02 | 2% chance of two shocks per window |
| (implicit) | 0.95 | 95% chance of one shock per window |
| `crash_shock_min_pct` | 2 | Minimum shock magnitude (%) |
| `crash_shock_max_pct` | 4 | Maximum shock magnitude (%) |

Per window:
1. Roll probability to decide number of shocks (0, 1, or 2)
2. Select random 3-5% of symbols (at least 1), excluding recently crashed symbols
3. Apply shock magnitude (2-4% randomly)
4. Decay: `shock * 0.9^n` per tick until it reaches zero

### Crash State Tracking

- `crash_shocks`: Map of symbol -> current shock magnitude
- `crash_decay`: Decay rate per tick
- `last_crash_window`: Timestamp of last window check
- Shocked symbols are excluded from the next window's selection pool

---

## Rate Limiting

Three limiters, all Postgres-backed:

| Limiter | Key | Window | Limit | Scope |
|---------|-----|--------|-------|-------|
| `apiLimiter` | IP address | 1 min | 300 requests | Global API |
| `authLimiter` | IP address | 1 min | 500 requests | Auth endpoints |
| `tradeLimiter` | team_id | 1 min | 60 requests | Trading endpoints |

### Store

- **Primary:** `PgRateLimitStore` using the `rate_limits` table with atomic `INSERT ON CONFLICT` (upsert)
- **Fallback:** `MemoryStore` if `RATE_LIMIT_STORE=memory`
- Auto-cleanup: every 256 increments, deletes expired rows

### Behavior

When rate limit exceeded: returns `429 Too Many Requests` with `Retry-After` header.

---

## Frontend

### Pages (Next.js App Router)

| Route | Component | Access |
|-------|-----------|--------|
| `/` | Landing page | Public |
| `/login` | Login form | Public |
| `/register` | Registration form | Public |
| `/dashboard` | Trading desk | Team |
| `/admin` | Admin console | Admin |
| `/manage-teams` | Team management | Admin |
| `/evaluator` | Judge desk | Evaluator |
| `/leaderboard` | Rankings | Authenticated |
| `/allocations` | API allocations | Admin/Evaluator |
| `/api` | API key display | Team |
| `/docs` | Documentation | Authenticated |

### Shell Layout (TerminalShell.tsx)

- Top navbar: logo, clock, event timer, state indicator, role badge, profile dropdown
- Left sidebar: role-based navigation (9 items filtered by role)
- Market state color coding: green (active), gold (frozen), red (concluded), gray (pre-launch)
- Wallet display for teams; aggregate stats for admin/evaluator

### Key Components

**TradingConsole.tsx**: Order entry panel (symbol selector, qty, limit price, BUY/SELL) + scrolling trade log. Uses `liveFeed` WebSocket for real-time order confirmations.

**CandlesChart.tsx**: Full candlestick chart using lightweight-charts:
- 4 chart types: Candle, Line, Area, Volume Candles
- 9 timeframes: 1s to 1h
- Historical data from `/api/market/history`
- Live tick aggregation into candles
- Volume histogram, VWAP, OHLCV stats, circuit breaker badges

**AdminConsole.tsx**: Market control panel:
- Start/Pause/Resume/Halt controls
- Volatility slider (0.1x - 20x)
- Replay speed slider (0.1x - 20x)
- Circuit band slider (1% - 30%)
- Flash crash controls
- Credential reveal/hide, leaderboard freeze
- Account creation form
- Dataset upload + synthetic generation
- Judge scoring panel
- Live metrics, teams table, live prices table

**EvaluatorConsole.tsx**: Judge evaluation desk:
- Clickable team leaderboard
- Market chart with trade markers (buy/sell overlays)
- Full trade audit table
- Submission viewer
- Judge scoring form (code quality 0-100, report 0-100)

**ManageTeams.tsx**: Admin team management:
- CRUD operations (create, edit, delete)
- Freeze/unfreeze, reset to start capital
- Inline audit modal (orders + API requests)
- Edit modal (name, email, password, role, cash, frozen)

**LeaderboardTable.tsx / LeaderboardMini.tsx**: Portfolio rankings with live price updates.

**DepthPanel.tsx**: Order book depth display (5-level bid/ask).

### Frontend Libraries (web/lib/)

- `api.ts`: HTTP client, WebSocket LiveFeed manager, token storage, formatters
- `useStatus.ts`: Polling hook for market status
- `utils.ts`: cn() class name merger (clsx + tailwind-merge)

---

## Deployment

### Local Development

```bash
docker compose up -d        # Start PostgreSQL
npm install                  # Install all workspace deps
npm run dev                  # Start server + web concurrently
```

### Render (Production)

`render.yaml` defines a free-tier web service:

- Auto-generates `JWT_SECRET` if not provided
- Build: `npm install && npm run build`
- Start: `npm run start`

### Docker Compose

```yaml
services:
  postgres:
    image: postgres:16-alpine
    ports: ["5432:5432"]
    environment:
      POSTGRES_DB: mercatus
      POSTGRES_USER: mercatus
      POSTGRES_PASSWORD: mercatus
```

---

## Environment Variables

All variables with their defaults:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 4040 | Server port |
| `DATABASE_URL` | -- | PostgreSQL connection string |
| `JWT_SECRET` | -- | Token signing secret (required) |
| `ADMIN_EMAIL` | -- | Default admin login email |
| `ADMIN_PASSWORD` | -- | Default admin login password |
| `REGISTRATION_CODE` | -- | Optional code gate for team registration |
| `TICK_INTERVAL_MS` | 1000 | Milliseconds between market ticks |
| `DEFAULT_START_CAPITAL` | 100000 | Per-team starting cash (rupees) |
| `DEFAULT_EVENT_MINUTES` | 180 | Event duration in minutes |
| `DEFAULT_BLACKOUT_MINUTES` | 20 | Leaderboard blackout before end |
| `DEFAULT_API_FREEZE_MINUTES` | 15 | API freeze before event end |
| `CRASH_AUTO` | 1 | Enable automatic flash crashes |
| `CRASH_WINDOW_S` | 600 | Seconds between crash windows |
| `CRASH_SHOCK_MIN_PCT` | 2 | Minimum flash crash shock (%) |
| `CRASH_SHOCK_MAX_PCT` | 4 | Maximum flash crash shock (%) |
| `CRASH_PROB_NONE` | 0.03 | Probability of no crash per window |
| `CRASH_PROB_TWO` | 0.02 | Probability of two shocks per window |
| `FEE_PER_TRADE` | 10 | Brokerage fee per trade (rupees) |
| `FREE_TRADES` | 100 | Number of free trades before fee kicks in |
| `RATE_LIMIT_API` | 300 | API requests per minute per IP |
| `RATE_LIMIT_AUTH` | 500 | Auth requests per minute per IP |
| `RATE_LIMIT_TRADE` | 60 | Trade requests per minute per team |
| `RATE_LIMIT_STORE` | postgres | Rate limit backend (`postgres` or `memory`) |
| `LLM_API_KEY` | -- | OpenAI-compatible API key for autograder |
| `LLM_MODEL` | gpt-4o-mini | Model for autograder |
| `NODE_ENV` | development | `production` enables strict guards |
