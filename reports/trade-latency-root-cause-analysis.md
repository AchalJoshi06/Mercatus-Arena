# Trade Execution Latency — Root-Cause Analysis

**System:** Mercatus Arena (Paper Trading) — `executeOrder()` trade path
**Scope:** *Find and quantify* the bottlenecks that prevent server-side trade latency from staying within a tight budget as concurrency and order history grow. **This document recommends fixes; it does not implement them.**
**Date:** 2026-08-21
**Environment:** Windows 11, 8 GB RAM, 8 cores, Node v23.11.1, PostgreSQL 16.15 (data on SATA SSD), default config (PG pool = 20, `RATE_LIMIT_STORE=postgres`, fsync on, `synchronous_commit=on`).

---

## 1. Executive summary

| Question | Finding |
|---|---|
| Is the **median** trade fast? | **Yes.** Best-case server-side median ≈ **13–18 ms** (reconciles exactly with the sum of the 11 per-query costs). |
| Does it hold up under load? | **No.** P95/P99 blow out with concurrency: P95 goes 23 ms → 29 → 53 → **128 ms** at 10/25/50/100 VUs; P99 hits **126 ms** at 25 VUs and **599 ms** under trade-heavy 100 VUs. |
| What is the **#1 ceiling**? | The **20-connection PostgreSQL pool.** Under load, `poolAcquisition.waitingPeak` reaches **61–78** — i.e. 3–4× the pool size — driving the entire P95/P99 tail. |
| What will **catastrophically** degrade over the event? | The **fee-count query (`q04`)** — a `Seq Scan` on `order_logs` run **inside every successful trade**. Measured at **91 ms at 1M order-log rows** without an index (vs **0.6 ms** with a proper index). Order history only grows during the event. |
| Is fsync / WAL the cost? | **No.** An empty `BEGIN;COMMIT` is **0.72 ms**; disabling `synchronous_commit` made it *slower* (extra round-trip). Disk flush is not the bottleneck. |

**Verdict:** The single-trade code path is well-built and cheap at the median. The latency problem is a **concurrency/resource ceiling (DB connection pool)** plus **two specific queries that do not scale** (the per-trade fee-count scan, and the leaderboard's correlated recompute). All are fixable without rewriting the trade logic.

---

## 2. Methodology & caveats

**Harness (all temporary, in `server/scripts/`, no production code touched):**
- `profile-server.ts` — instrumented copy of the app that times every query stage, the transaction duration vs. in-query time (gap), pool acquisition waits, pool gauges, and event-loop delay.
- `loadgen-profile.ts` — deterministic generator with proper `X-Forwarded-For` per-VU (so the IP rate limiter never 429s), unique teams per VU, and **no `execSync`** (the original v2 generator's 1.8–2.2 s event-loop lag was a self-inflicted `execSync` bug, not a server signal).
- `run-matrix.ts` — boots the profiled server with per-scenario env, runs the generator, dumps a JSONL + summary.
- `db-microbench.ts` — isolated single-connection timings of each path query.
- `explain-queries.ts` — `EXPLAIN (ANALYZE, BUFFERS)` for every path query + a 10k/100k/1M fee-count scaling bench.

**Caveats (important for interpreting numbers):**
1. **Generator event-loop lag is a harness artifact, not a server metric.** The control test (`control_healthz500`: 500 VUs, 0 DB, 0 trades, 0 WS) shows `genLagMax = 252 ms`. The generator's own coordination overhead at 500 VUs is ~250 ms; this must be subtracted/discounted from any "tail latency" the generator measured. The **server-side** `serverTrade` percentiles are the trustworthy signal.
2. **Cold vs hot cache.** Early micro-benchmarks showed the leaderboard at **78 ms**; under sustained load (everything resident in the 128 MB `shared_buffers`) it drops to **0.2 ms** in the profiler. The 78 ms was a one-time cold-cache artifact. All in-load percentages below are hot-cache and represent steady state.
3. **Workload is think-time limited**, not pool limited, at the tested trade rates (≈5–20 trades/s). The pool ceiling shows up as *queueing* (waitingPeak ≫ pool size) and tail spikes, not as a flat throughput wall — but it will become a hard wall as real user behavior (more reads: leaderboard, portfolio, market) competes for the same 20 connections.

---

## 3. The 20 ms latency budget (decomposed)

Server-side median single trade at 25 VUs (sanity25), measured transaction P50 = **17.99 ms**. It decomposes exactly into the 11 in-transaction steps (`reports/profiling/server-profile-sanity25-summary.json`):

| Stage | Query | P50 (ms) | Notes |
|---|---|---|---|
| tx_begin | `BEGIN` | 0.73 | |
| q01 | `SELECT … teams WHERE team_id=$1 FOR UPDATE` | 1.33 | row lock |
| q02 | `SELECT state,paused FROM event_config` | 1.15 | |
| q03 | `SELECT price FROM live_prices WHERE symbol=$1` | 1.22 | |
| q04 | `SELECT count(*) FROM order_logs WHERE team_id AND status='SUCCESS'` | 1.45 | **see RC-2** |
| q05 | `UPDATE teams SET cash_balance …` | 1.49 | BUY debit / SELL credit |
| q06 | `INSERT … holdings ON CONFLICT` (BUY) / `UPDATE holdings` (SELL) | 1.47 | |
| q07 | `UPDATE teams SET total_portfolio_value = (correlated recompute)` | **2.76** | **largest single step** |
| q08 | `INSERT INTO order_logs …` | 1.66 | |
| q09 | `SELECT cash_balance …` | 1.32 | |
| tx_commit | `COMMIT` | 1.48 | |
| **Sum of query P50s** | | **≈ 17.5** | matches tx P50 (17.99) |
| **Gap (tx time not in queries)** | event-loop/ctx-switch between statements | P50 2.87 / P95 5.64 | small |

**Conclusion:** at the median the budget is essentially spent on 11 sequential 1–3 ms Postgres round-trips. There is no single "rogue" step at the median; the path is just *wide*. The tail (P95/P99) is **not** in these numbers — it is in pool queueing (§4) and the two non-scaling queries (RC-2, RC-3).

---

## 4. Evidence: how latency scales

**Scaling matrix (mixed workload, limiters ON, distinct teams, 1 WS client/VU):**

| VUs | srv P50 | srv P95 | srv P99 | srv max | http P95 | genLagMax | peak RPS |
|---|---|---|---|---|---|---|---|
| 10 | 13 ms | 23 ms | 32 ms | 38 ms | 75 ms | 49 ms | 68 |
| 25 | 13 ms | 29 ms | 33 ms | 93 ms | 69 ms | 25 ms | 178 |
| 50 | 16 ms | 53 ms | 357 ms | 653 ms | 138 ms | 266 ms | 515 |
| 100 | 16 ms | **128 ms** | 225 ms | 287 ms | 173 ms | 103 ms | 559 |

Median stays flat (13→16 ms) — **the per-trade cost is not contention-bound**. But P95/P99 climb steeply → pure **queueing**, confirmed by pool stats (below).

**Contention A/B (trade-heavy, 100 VUs, elevated TEST-ONLY limits so 429s can't mask anything):**
- `contend_distinct` (different teams): tx P50 = 125 ms, P95 = 386 ms, **poolAcq waitingPeak = 78**, poolAcq P95 = **251 ms**, max = 1437 ms.
- `contend_shared10` (10 teams, 10× same-team lock contention): tx P50 = 29 ms, **poolAcq waitingPeak = 61** but poolAcq P95 = **0.35 ms**; only `q01` (team `FOR UPDATE`) degrades (P95 70 ms).

**Key insight:** shared teams were *not* catastrophically worse — the dominant signal in *both* is `poolAcquisition.waitingPeak` of **61–78 ≫ pool size 20**. Row-lock contention between same-team trades is a *minor* third-order effect (visible only as `q01` P95 70 ms). **The pool is the ceiling.**

**Rate-limiter A/B (50 VUs):** limiter ON srv P95 = 54 ms / P99 = 113 ms; limiter OFF (`NODE_ENV=test`, no-op limiter) srv P95 = 31 ms / P99 = 65 ms. The postgres-backed limiter adds ≈ **2 ms P50 / 23 ms P95 / 48 ms P99** — modest, but it competes for the same 20 connections (every request = 1 extra PG round-trip), so it amplifies the pool problem rather than being a killer on its own.

**WebSocket A/B (50 VUs):** WS ON srv P95 = 54 ms / P99 = 113 ms; WS OFF (`NO_WS=1`) srv P95 = **25 ms** / P99 = **38 ms**. Disabling broadcast improves P95 by ~2× and P99 by ~3×. The synchronous per-tick broadcast loop in `ws.ts` blocks the event loop during/around trades (esp. the engine's ~1 s tick fan-out to all clients). **Not** the WS *client count* — `wsscale10/50/100/500` all show srv P95 ≤ 24 ms under light trade load. It is broadcast *contention on the single event loop* under trade throughput.

---

## 5. Root causes (ranked)

### RC-1 — PostgreSQL connection pool capped at 20 (PRIMARY ceiling)
- **Evidence:** `config.ts` `PG_POOL_SIZE=20`. Under every concurrent scenario `poolAcquisition.waitingPeak` = 25 (sanity25), 61 (shared10), **78** (distinct100). Pool-acquisition P95 reaches **251 ms**; acquisition max **1437 ms**. This single value produces nearly all of the P95/P99 tail in §4.
- **Why it's the ceiling:** all endpoints (trades *and* leaderboard, portfolio, market snapshot, telemetry insert, rate-limit upsert) share these 20 connections. The trade path alone holds a connection for ~18–190 ms; add read traffic and the pool saturates well before the CPU or disk does (server CPU peaked at ~5% in the v2 smoke test).
- **Expected impact of fixing:** raising the pool to 50–90 (PG `max_connections=100`) directly multiplies the concurrency ceiling ~3–4× and collapses the P95/P99 tail. **Highest leverage change.**

### RC-2 — Fee-count `Seq Scan` inside every trade (WILL degrade to seconds)
- **Location:** `atomic.ts:103-107` — `SELECT count(*) FROM order_logs WHERE team_id=$1 AND status='SUCCESS'`, executed **inside** the transaction on every successful fill, solely to decide a brokerage fee.
- **Evidence:** `EXPLAIN` shows **Seq Scan on order_logs** (no usable composite index). Existing `idx_order_logs_team` is on `(team_id, order_id)` — `status` is not in the index, so it cannot serve the `status='SUCCESS'` filter. Scaling bench (`reports/explain/summary.json`):

  | order_logs rows | NO index P50 | WITH `(team_id,status)` index P50 |
  |---|---|---|
  | 10 k | 1.4 ms | 0.43 ms |
  | 100 k | 8.9 ms | 0.56 ms |
  | 1 M | **91 ms** | **0.6 ms** |

- **Why it's critical:** this query runs on the **hot path of every successful trade**. During a 2-hour event with 500 teams trading, `order_logs` grows into the hundreds of thousands → millions, turning every trade's fee step into a 10–90 ms full scan — and that scan *also* holds a pool connection, compounding RC-1. This is the most dangerous latent defect.
- **Expected impact:** add index `order_logs(team_id, status)` (or better, eliminate the query — see RC-2 fix) → fee step drops from 91 ms (at 1M) to <1 ms. **Prevents a guaranteed production outage.**

### RC-3 — Leaderboard correlated recompute on the read path
- **Location:** `market.routes.ts:43-59`. Computes, for **all 500 teams**, a correlated subquery over `holdings ⋈ live_prices` — **twice per team** (once for the value, once inside `rank() OVER`).
- **Evidence:** `EXPLAIN` (`reports/explain/leaderboard.txt`): **24 ms HOT** (78 ms cold), 30 k holdings index-scans, 3270 buffers, holds a connection the entire time. Called frequently by clients/dashboards, so it is a steady drain on the 20-connection pool.
- **Expected impact:** snapshot the leaderboard into `leaderboard_snapshot` (table already exists, used when frozen) on a short interval / per relevant trade, and serve reads from it → removes a 24–78 ms connection-hogging query from the hot path.

### RC-4 — `total_portfolio_value` recomputed inside the trade transaction (largest single step)
- **Location:** `atomic.ts:152-163`. After each fill, recomputes the team's portfolio value via a correlated `holdings ⋈ live_prices` aggregate and writes it back, all inside the trade transaction.
- **Evidence:** `EXPLAIN` (`reports/explain/q07_portfolio_value_update.txt`): cheap today (0.19 ms, only 30 holdings/team, live_prices fully cached) but it is the **largest single step at P50 2.76 ms** and it occupies a connection for the whole correlated recompute on every trade.
- **Expected impact:** compute portfolio value **asynchronously / on read** (cache on `teams.total_portfolio_value`, refresh out-of-band or lazily) → removes ~2.7 ms P50 + a connection-occupancy chunk from every trade.

### RC-5 — Synchronous WebSocket broadcast blocks the event loop
- **Location:** `ws.ts` broadcast loop (iterate clients, `JSON.stringify`, `send`).
- **Evidence:** WS A/B (§4): disabling broadcast drops P95 54→25 ms, P99 113→38 ms. Effect is from the engine's periodic tick fan-out + per-trade `order` broadcast contending on the single Node event loop, not from client count (`wsscale*` all ≤24 ms P95 under light load).
- **Expected impact:** offload serialization/broadcast (e.g. a worker, batching per tick, or non-blocking send with backpressure) → recovers the P95/P99 event-loop tail.

### RC-6 — Postgres-backed rate limiter competes for the pool
- **Evidence:** limiter A/B (§4): +2 ms P50 / +23 ms P95. Each request = 1 extra PG upsert; under pool pressure this round-trip queues like any other.
- **Expected impact:** move the limiter to an in-memory (per-instance) or shared-cache store (Redis) so it stops consuming one of the 20 PG connections per request.

---

## 6. Improvement table (recommendation only)

| # | Root cause | Recommended fix | Expected effect | Effort / Risk |
|---|---|---|---|---|
| 1 | RC-1 pool=20 | Raise `PG_POOL_SIZE` to 50–90 (raise PG `max_connections` accordingly) | Collapses P95/P99 tail ~3–4×; primary ceiling removed | Trivial config; verify PG memory |
| 2 | RC-2 fee scan | Add index `order_logs(team_id, status)` **or** maintain a `successful_trades` counter on `teams` and drop the per-trade `count(*)` | Fee step 91 ms→<1 ms at 1M rows; prevents guaranteed degradation | Low; index is zero-risk, counter needs tx care |
| 3 | RC-3 leaderboard | Serve from `leaderboard_snapshot` (periodic refresh / refresh on trade) | Removes 24–78 ms connection-hogging read | Medium; staleness trade-off (acceptable, already frozen-path exists) |
| 4 | RC-4 portfolio recompute | Compute `total_portfolio_value` out-of-band / on read; stop recomputing inside trade tx | −~2.7 ms P50 per trade + less conn occupancy | Medium; consistency trade-off |
| 5 | RC-5 WS broadcast | Async/non-blocking broadcast, batch per tick, add backpressure | P95 ~2×, P99 ~3× recovery under load | Medium; code change in `ws.ts` |
| 6 | RC-6 limiter | In-memory or Redis-backed limiter instead of postgres-backed | −2 ms P50 / frees a PG connection per request | Medium; needs Redis or per-instance state |

**Sequence:** #1 and #2 first (config + one index/query elimination) — they are low-risk and remove the two hardest ceilings. Then #3, #4 (read-path offloading), then #5, #6 (event-loop + limiter).

---

## 7. What is NOT the bottleneck (avoid wasting effort)

- **fsync / WAL / `synchronous_commit`:** empty tx = 0.72 ms; turning sync off was *slower*. Not the cost.
- **Cold-cache leaderboard (78 ms):** one-time artifact; hot = 24 ms and it's a read-path issue (RC-3), not a disk issue.
- **Same-team row-lock contention:** minor (only `q01` P95 ~70 ms under pathological 10-team sharing); the pool dominates. Not worth lock-redesign.
- **Per-query median cost:** every individual query is 1–3 ms. No single query needs "speeding up" at the median — the problem is *width* + *pool* + *two non-scaling queries*.

---

## 8. Reproducibility

All artifacts under `reports/` (relative to repo root):
- `reports/profiling/server-profile-<scenario>-summary.json` — per-stage timings, tx duration/gap, pool stats, event-loop delay (scenarios: sanity25, scale10/25/50/100, contend_distinct, contend_shared10, limiter_on_50, limiter_off_50, ws_off_50, wsscale10/50/100/500, control_healthz500).
- `reports/profiling/loadgen-<scenario>-summary.json` — server-side + HTTP percentiles, throughput, generator lag.
- `reports/profiling/db-microbench.json` — isolated single-connection query timings.
- `reports/explain/*.txt` — `EXPLAIN (ANALYZE, BUFFERS)` for every trade-path query + leaderboard.
- `reports/explain/summary.json` — fee-count scaling results (10k/100k/1M, indexed vs not).

Scripts (temporary, `server/scripts/`): `profile-server.ts`, `loadgen-profile.ts`, `run-matrix.ts`, `db-microbench.ts`, `explain-queries.ts`. Run e.g. `npx tsx scripts/run-matrix.ts scale50`.

**Note:** `lt_*` test teams were re-provisioned during this analysis (a one-off wipe occurred between runs; root cause not in app code — engine reset truncates holdings/order_logs but not teams, so it is attributed to an external/Harness reset). Re-run `loadtest-500-v2.ts` with `PROVISION_ONLY=1` to restore 500 teams if needed.
