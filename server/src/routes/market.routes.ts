import { Router } from "express";
import { query } from "../db.js";
import { serverError } from "../http.js";
import { engine } from "../engine.js";

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
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
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
    const liveStart = status.liveStartAt ?? status.datasetEndAt ?? null;
    const until =
      req.query.until !== undefined
        ? Math.min(Number(req.query.until) || 0, status.datasetEndAt ?? Infinity)
        : liveStart ?? status.datasetEndAt;
    if (!until || until <= 0) return res.json({ symbol, resolution, until: null, bars: [] });
    const { rows } = await query(
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
        status.datasetStartAt ?? 0,
        Math.floor(until),
        limit,
      ],
    );
    const bars = rows
      .reverse()
      .map((r) => {
        const datasetT = Number(r.bucket);
        let t = datasetT;
        if (status.startWallMs && status.datasetStartAt && status.replaySpeed > 0) {
          t = Math.floor(status.startWallMs + (datasetT - status.datasetStartAt) / status.replaySpeed);
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
