import { Router } from "express";
import { query } from "../db.js";
import { serverError } from "../http.js";
import { engine } from "../engine.js";
import { cached } from "../cache.js";

export const marketRoutes = Router();

marketRoutes.get("/status", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(engine.getStatus());
});

marketRoutes.get("/snapshot", async (_req, res) => {
  try {
    const { rows } = await query(
      `select symbol, price, prev_price, updated_at from live_prices order by symbol`,
    );
    res.setHeader("Cache-Control", "public, max-age=1, s-maxage=1");
    res.json({
      prices: Object.fromEntries(rows.map((r) => [r.symbol, Number(r.price)])),
      updatedAt: rows[0]?.updated_at ?? null,
    });
  } catch (err) {
    serverError(res, err);
  }
});

marketRoutes.get("/leaderboard", async (_req, res) => {
  try {
    const cfg = await query(
      `select leaderboard_frozen from event_config where id = true`,
    );
    const frozen = cfg.rows[0].leaderboard_frozen;
    if (frozen) {
      const { rows } = await query(
        `select rank, team_id, team_name, total_portfolio_value
         from leaderboard_snapshot
         where captured_at = (select max(captured_at) from leaderboard_snapshot)
         order by rank`,
      );
      return res.json({ frozen: true, teams: rows });
    }
    const { rows } = await query(
      `select t.team_id, t.team_name,
              round(t.cash_balance + coalesce((
                select sum(h.quantity * lp.price)
                from holdings h
                left join live_prices lp on lp.symbol = h.symbol
                where h.team_id = t.team_id and h.quantity > 0
              ), 0), 2) as total_portfolio_value,
              rank() over (order by
                (t.cash_balance + coalesce((
                  select sum(h.quantity * lp.price)
                  from holdings h
                  left join live_prices lp on lp.symbol = h.symbol
                  where h.team_id = t.team_id and h.quantity > 0
                ), 0)) desc) as rank
       from teams t where t.role = 'team' order by rank`,
    );
    res.setHeader("Cache-Control", "no-store");
    res.json({ frozen: false, teams: rows });
  } catch (err) {
    serverError(res, err);
  }
});

marketRoutes.get("/symbols", (_req, res) => {
  res.json({ symbols: engine.getStatus().symbols });
});

marketRoutes.get("/depth", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(engine.getDepth());
});

const RES_MS: Record<string, number> = {
  "1s": 1_000,
  "5s": 5_000,
  "15s": 15_000,
  "30s": 30_000,
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "30m": 1_800_000,
  "1h": 3_600_000,
};

marketRoutes.get("/history", async (req, res) => {
  try {
    const status = engine.getStatus();
    const symbol = String(req.query.symbol ?? "").trim().toUpperCase();
    const resolution = String(req.query.resolution ?? "1m");
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 2000, 10000));
    if (!symbol || !status.symbols.includes(symbol)) {
      return res.status(400).json({ error: "UNKNOWN_SYMBOL" });
    }
    if (!RES_MS[resolution]) {
      return res.status(400).json({ error: "INVALID_RESOLUTION" });
    }
    const bucketMs = RES_MS[resolution];
    const anchor = status.liveStartAt ?? status.datasetStartAt ?? 0;
    const speed = status.replaySpeed;
    // Live mode: dataset time IS wall-clock time, so bars need no remapping.
    const live = status.datasetMode === "live";
    const started =
      !!status.startWallMs &&
      speed > 0 &&
      (status.paused ||
        status.state === "ACTIVE_MARKET" ||
        status.state === "API_FROZEN" ||
        status.state === "EVENT_CONCLUDED");
    const liveStart = status.liveStartAt ?? status.datasetEndAt ?? null;
    const maxUntil = status.datasetEndAt ?? Infinity;
    let until: number | null;
    if (live) {
      const pos = status.lastT > 0 ? status.lastT + 1 : status.liveStartAt ?? Date.now();
      until =
        req.query.until !== undefined ? Math.min(Number(req.query.until) || 0, pos) : pos;
    } else if (started) {
      // Include replayed live bars up to the current replay position.
      const pos = status.lastT > 0 ? status.lastT + 1 : liveStart;
      until =
        req.query.until !== undefined
          ? Math.min(Number(req.query.until) || 0, maxUntil, pos ?? maxUntil)
          : pos;
    } else {
      until =
        req.query.until !== undefined
          ? Math.min(Number(req.query.until) || 0, maxUntil)
          : liveStart ?? status.datasetEndAt;
    }
    // Wall-clock offset for completed replay loops (running market only).
    let wallBase = status.startWallMs;
    if (live) {
      // no replay offset
    } else if (started && status.state === "ACTIVE_MARKET" && !status.paused) {
      const span = (status.datasetEndAt ?? 0) - anchor;
      if (span > 0) {
        const cycles = Math.floor(((Date.now() - status.startWallMs) * speed) / span);
        wallBase = status.startWallMs + (cycles * span) / speed;
      }
    } else if (started && status.paused && status.lastT >= anchor) {
      // startWallMs is reset on pause; derive a stable base from the replay
      // position at the moment of pausing so bars don't drift per request.
      wallBase = (status.pausedAtMs ?? Date.now()) - (status.lastT - anchor) / speed;
    }

    if (!until || until <= 0) return res.json({ symbol, resolution, until: null, bars: [] });
    // Quantize `until` to 5s so concurrent viewers share one cached query;
    // clients fill the last few seconds from the live feed.
    const untilQ = Math.max(1, Math.floor(until / 5000) * 5000);
    const lowerT = Math.max(
      status.datasetStartAt ?? 0,
      // Only scan the window the response can contain (limit buckets back
      // from `until`); scanning the whole dataset made cold loads take ~7s.
      Math.floor(untilQ / bucketMs) * bucketMs - (limit - 1) * bucketMs,
    );
    const rows = await cached(
      `hist:${status.datasetId}:${symbol}:${bucketMs}:${limit}:${untilQ}`,
      5000,
      async () => (await query(
      `select floor(t / $3::bigint) * $3::bigint as bucket,
              min(price) as low,
              max(price) as high,
              (array_agg(price order by t))[1] as open,
              (array_agg(price order by t))[count(*)::int] as close,
              coalesce(sum(volume), 0) as volume
       from dataset_ticks
       where dataset_id = $1 and symbol = $2
         and t >= $4::bigint and t < $5::bigint
       group by bucket order by bucket desc limit $6`,
      [
        status.datasetId,
        symbol,
        bucketMs,
        lowerT,
        untilQ,
        limit,
      ],
    )).rows,
    );
    const bars = rows
      .reverse()
      .map((r) => {
        const datasetT = Number(r.bucket);
        let t = datasetT;
        if (live) {
          // already wall-clock
        } else if (started) {
          // Replayed live bars (>= anchor) advance forward from the current
          // cycle base; prior historical bars (< anchor) extend backward from
          // that same base so the two stay contiguous.
          if (datasetT >= anchor) {
            t = Math.floor(wallBase + (datasetT - anchor) / speed);
          } else {
            t = Math.floor(wallBase - (anchor - datasetT));
          }
        } else {
          // PRE_LAUNCH: shift timestamps so the live start anchor aligns with
          // Date.now(), projecting history backward.
          const pa = status.liveStartAt ?? status.datasetEndAt ?? Date.now();
          t = Math.floor(Date.now() - (pa - datasetT));
        }
        return {
          t,
          open: Number(r.open),
          high: Number(r.high),
          low: Number(r.low),
          close: Number(r.close),
          volume: Number(r.volume),
        };
      });
    res.setHeader("Cache-Control", "no-store");
    res.json({ symbol, resolution, until, bars });
  } catch (err) {
    serverError(res, err);
  }
});
