import { Router, type Response } from "express";
import { requirePortal, requireAdmin } from "../auth.js";
import { query } from "../db.js";
import { engine } from "../engine.js";
import { parseDatasetCsv, ingestDataset } from "../dataset.js";
import { generateSyntheticDataset } from "../generator.js";
import { adminMetrics, computeScores, setJudgeScores } from "../scoring.js";
import { autogradeSubmissions } from "../autograder.js";
import multer from "multer";
import { serverError } from "../http.js";
import type { AuthedRequest } from "../auth.js";
import { config } from "../config.js";

export const adminRoutes = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });

const adminOnly = [requirePortal, requireAdmin];

adminRoutes.post("/control", ...adminOnly, async (req: AuthedRequest, res: Response) => {
  try {
    const { action } = req.body ?? {};
    switch (action) {
      case "start": {
        const cfg = await query(
          `select start_capital, replay_speed from event_config where id = true`,
        );
        await engine.startEvent({
          startCapital: Number(req.body.start_capital ?? cfg.rows[0].start_capital),
          eventMinutes: Number(req.body.event_minutes ?? config.defaultEventMinutes),
          blackoutMinutes: Number(req.body.blackout_minutes ?? config.defaultBlackoutMinutes),
          apiFreezeMinutes: Number(req.body.api_freeze_minutes ?? config.defaultApiFreezeMinutes),
        });
        return res.json({ ok: true, state: "ACTIVE_MARKET" });
      }
      case "pause":
        await engine.pause();
        return res.json({ ok: true, paused: true });
      case "resume":
        await engine.resume();
        return res.json({ ok: true, paused: false });
      case "halt":
        await engine.conclude();
        return res.json({ ok: true, state: "EVENT_CONCLUDED" });
      case "reveal_credentials":
        await engine.revealCredentials();
        return res.json({ ok: true, credentials_revealed: true });
      case "hide_credentials":
        await engine.hideCredentials();
        return res.json({ ok: true, credentials_revealed: false });
      case "freeze_leaderboard":
        await engine.freezeLeaderboard();
        return res.json({ ok: true, leaderboard_frozen: true });
      case "unfreeze_leaderboard":
        await engine.unfreezeLeaderboard();
        return res.json({ ok: true, leaderboard_frozen: false });
      default:
        return res.status(400).json({ error: "UNKNOWN_ACTION" });
    }
  } catch (err) {
    serverError(res, err);
  }
});

adminRoutes.post("/config", ...adminOnly, async (req: AuthedRequest, res: Response) => {
  try {
    const b = req.body ?? {};
    const fields: [string, unknown][] = [];
    for (const key of [
      "start_capital",
      "replay_speed",
      "noise_sigma",
      "volatility_multiplier",
      "circuit_pct",
    ] as const) {
      if (b[key] !== undefined && b[key] !== null) fields.push([key, b[key]]);
    }
    if (fields.length > 0) {
      const sets = fields.map(([k], i) => `${k} = $${i + 1}`).join(", ");
      await query(`update event_config set ${sets} where id = true`, fields.map(([, v]) => v));
      await engine.reloadConfig();
    }
    res.json({ ok: true });
  } catch (err) {
    serverError(res, err);
  }
});

adminRoutes.post("/volatility", ...adminOnly, async (req: AuthedRequest, res: Response) => {
  const m = Number(req.body?.multiplier);
  if (!Number.isFinite(m) || m < 0.1 || m > 50) {
    return res.status(400).json({ error: "INVALID_MULTIPLIER" });
  }
  await engine.setVolatility(m);
  res.json({ ok: true, multiplier: m });
});

adminRoutes.post("/flash-crash", ...adminOnly, async (req: AuthedRequest, res: Response) => {
  const shock = Number(req.body?.shock);
  if (!Number.isFinite(shock) || shock < -0.1 || shock > 0.1) {
    return res.status(400).json({ error: "INVALID_SHOCK" });
  }
  const raw = req.body?.symbols;
  if (raw !== undefined && !Array.isArray(raw)) {
    return res.status(400).json({ error: "INVALID_SYMBOLS" });
  }
  const symbols: string[] | undefined = raw?.map((s: unknown) => String(s));
  if (symbols?.length) {
    const known = new Set(engine.getStatus().symbols);
    const valid = symbols.filter((s) => known.has(s.trim().toUpperCase()));
    if (valid.length === 0) {
      return res.status(400).json({ error: "NO_VALID_SYMBOLS" });
    }
  }
  try {
    const decay = req.body?.decay === undefined
      ? undefined
      : Number(req.body?.decay);
    if (decay !== undefined && (!Number.isFinite(decay) || decay < 0.05 || decay > 0.999)) {
      return res.status(400).json({ error: "INVALID_DECAY" });
    }
    await engine.triggerFlashCrash(shock, symbols, decay);
    res.json({ ok: true, shock, decay: decay ?? engine.getStatus().flashDecay });
  } catch (err) {
    serverError(res, err);
  }
});

adminRoutes.get("/crash-config", ...adminOnly, async (_req, res) => {
  res.json(engine.getCrashConfig());
});

adminRoutes.post("/crash-config", ...adminOnly, async (req, res) => {
  const auto = req.body?.auto;
  if (typeof auto !== "boolean") {
    return res.status(400).json({ error: "INVALID_AUTO" });
  }
  await engine.setCrashAuto(auto);
  res.json(engine.getCrashConfig());
});

adminRoutes.post("/dataset", ...adminOnly, upload.single("file"), async (req: AuthedRequest, res: Response) => {
  try {
    if (!req.file) return res.status(400).json({ error: "NO_FILE" });
    const text = req.file.buffer.toString("utf-8");
    const ticks = parseDatasetCsv(text);
    const liveStartMs =
      req.body?.live_start_ms !== undefined && req.body?.live_start_ms !== ""
        ? Number(req.body.live_start_ms)
        : null;
    const datasetId = await ingestDataset(req.file.originalname, ticks, liveStartMs);
    await engine.reloadDataset();
    res.json({ ok: true, datasetId, rows: ticks.length, symbols: [...new Set(ticks.map((t) => t.symbol))] });
  } catch (err) {
    console.error("[mercatus] dataset:", err);
    res.status(400).json({ error: "INVALID_DATASET" });
  }
});

adminRoutes.post("/dataset/synthetic", ...adminOnly, async (req: AuthedRequest, res: Response) => {
  try {
    const b = req.body ?? {};
    const result = await generateSyntheticDataset({
      durationMinutes: Number(b.duration_minutes ?? 180),
      spacingMs: Number(b.spacing_ms ?? 1000),
      symbols: Array.isArray(b.symbols) ? b.symbols : ["AAPL", "MSFT", "GOOG", "TSLA", "NVDA"],
      seed: b.seed !== undefined ? Number(b.seed) : 42,
    });
    await engine.reloadDataset();
    res.json({ ok: true, ...result });
  } catch (err) {
    serverError(res, err);
  }
});

adminRoutes.post("/users", ...adminOnly, async (req, res) => {
  const { role, team_name, email, password, starting_capital } = req.body ?? {};
  if (!["admin", "evaluator", "team"].includes(role)) {
    return res.status(400).json({ error: "INVALID_ROLE" });
  }
  if (
    typeof team_name !== "string" ||
    typeof email !== "string" ||
    typeof password !== "string"
  ) {
    return res.status(400).json({ error: "INVALID_FIELDS" });
  }
  const name = team_name.trim();
  const cleanEmail = email.trim().toLowerCase();
  if (name.length < 2 || name.length > 64) {
    return res.status(400).json({ error: "INVALID_TEAM_NAME" });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(cleanEmail) || cleanEmail.length > 254) {
    return res.status(400).json({ error: "INVALID_EMAIL" });
  }
  if (password.length < config.minPasswordLength) {
    return res.status(400).json({ error: "WEAK_PASSWORD" });
  }
  const exists = await query(
    `select team_id from teams where email = $1 or team_name = $2`,
    [cleanEmail, name],
  );
  if (exists.rows[0]) return res.status(409).json({ error: "EMAIL_OR_NAME_TAKEN" });

  const { hashPassword, generateApiKey, maskApiKey } = await import("../auth.js");
  const cfg = await query(`select start_capital from event_config where id = true`);
  const capital =
    role === "team"
      ? Number(starting_capital ?? cfg.rows[0].start_capital)
      : 0;
  const apiKey = role === "team" ? generateApiKey() : null;
  const { rows } = await query(
    `insert into teams (team_name, role, email, password_hash, api_key, cash_balance, starting_capital, total_portfolio_value)
     values ($1, $2, $3, $4, $5, $6, $6, $6)
     returning team_id, team_name, role, email`,
     [name, role, cleanEmail, await hashPassword(password), apiKey, capital],
  );
  res.status(201).json({
    user: rows[0],
    api_key: apiKey ? maskApiKey(apiKey) : null,
  });
});

adminRoutes.get("/teams", ...adminOnly, async (_req, res) => {
  const cfg = await query(`select credentials_revealed from event_config where id = true`);
  const revealed = cfg.rows[0].credentials_revealed;
  const { rows } = await query(
    `select t.team_id, t.team_name, t.role, t.email, t.is_frozen, t.cash_balance,
            t.total_portfolio_value, t.created_at,
            case when $1 then t.api_key else null end as api_key
     from teams t order by t.role desc, t.team_name`,
    [revealed],
  );
  res.json({ teams: rows });
});

adminRoutes.post("/teams/:id/freeze", ...adminOnly, async (req, res) => {
  const frozen = req.body?.frozen !== false;
  await query(`update teams set is_frozen = $1 where team_id = $2 and role = 'team'`, [
    frozen,
    Number(req.params.id),
  ]);
  res.json({ ok: true, frozen });
});

adminRoutes.post("/teams/:id/reset", ...adminOnly, async (req, res) => {
  const cfg = await query(`select start_capital from event_config where id = true`);
  await query(
    `update teams set cash_balance = $1, total_portfolio_value = $1,
            token_version = token_version + 1
     where team_id = $2 and role = 'team'`,
    [Number(cfg.rows[0].start_capital), Number(req.params.id)],
  );
  await query(`delete from holdings where team_id = $1`, [Number(req.params.id)]);
  res.json({ ok: true });
});

adminRoutes.patch("/teams/:id", ...adminOnly, async (req: AuthedRequest, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: "INVALID_TEAM_ID" });
    }
    const b = req.body ?? {};
    const { rows } = await query(
      `select team_name, email, role from teams where team_id = $1`,
      [id],
    );
    const target = rows[0];
    if (!target) return res.status(404).json({ error: "TEAM_NOT_FOUND" });
    if (target.role === "admin") {
      return res.status(400).json({ error: "CANNOT_MODIFY_ADMIN" });
    }

    const sets: string[] = [];
    const vals: unknown[] = [];
    let bumpVersion = false;

    if (b.team_name !== undefined) {
      const name = String(b.team_name).trim();
      if (name.length < 2 || name.length > 64) {
        return res.status(400).json({ error: "INVALID_TEAM_NAME" });
      }
      sets.push(`team_name = $${vals.length + 1}`);
      vals.push(name);
    }
    if (b.email !== undefined) {
      const email = String(b.email).trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 254) {
        return res.status(400).json({ error: "INVALID_EMAIL" });
      }
      sets.push(`email = $${vals.length + 1}`);
      vals.push(email);
    }
    if (b.password !== undefined && b.password !== "") {
      if (String(b.password).length < config.minPasswordLength) {
        return res.status(400).json({ error: "WEAK_PASSWORD" });
      }
      const { hashPassword } = await import("../auth.js");
      sets.push(`password_hash = $${vals.length + 1}`);
      vals.push(await hashPassword(String(b.password)));
      bumpVersion = true;
    }
    if (b.role !== undefined) {
      if (!["team", "evaluator", "admin"].includes(b.role)) {
        return res.status(400).json({ error: "INVALID_ROLE" });
      }
      if (b.role === "admin" || target.role === "admin") {
        return res.status(400).json({ error: "CANNOT_CHANGE_ADMIN_ROLE" });
      }
      sets.push(`role = $${vals.length + 1}`);
      vals.push(b.role);
    }
    if (b.is_frozen !== undefined) {
      if (typeof b.is_frozen !== "boolean") {
        return res.status(400).json({ error: "INVALID_FROZEN" });
      }
      sets.push(`is_frozen = $${vals.length + 1}`);
      vals.push(b.is_frozen);
    }
    if (b.cash_balance !== undefined) {
      const cash = Number(b.cash_balance);
      if (!Number.isFinite(cash) || cash < 0) {
        return res.status(400).json({ error: "INVALID_CASH" });
      }
      sets.push(`cash_balance = $${vals.length + 1}`);
      vals.push(Math.round(cash * 100) / 100);
    }
    if (sets.length === 0) {
      return res.status(400).json({ error: "NOTHING_TO_UPDATE" });
    }

    const finalName =
      b.team_name !== undefined ? String(b.team_name).trim() : target.team_name;
    const finalEmail =
      b.email !== undefined ? String(b.email).trim().toLowerCase() : target.email;
    const dup = await query(
      `select team_id from teams where (email = $1 or team_name = $2) and team_id <> $3`,
      [finalEmail, finalName, id],
    );
    if (dup.rows[0]) return res.status(409).json({ error: "EMAIL_OR_NAME_TAKEN" });

    if (bumpVersion) sets.push("token_version = token_version + 1");
    const updated = await query(
      `update teams set ${sets.join(", ")} where team_id = $${vals.length + 1}
       returning team_id, team_name, role, email, is_frozen`,
      [...vals, id],
    );
    res.json({ ok: true, team: updated.rows[0] });
  } catch (err) {
    serverError(res, err);
  }
});

adminRoutes.delete("/teams/:id", ...adminOnly, async (req: AuthedRequest, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: "INVALID_TEAM_ID" });
    }
    if (id === req.team!.team_id) {
      return res.status(400).json({ error: "CANNOT_DELETE_SELF" });
    }
    const { rows } = await query(`select role from teams where team_id = $1`, [id]);
    const target = rows[0];
    if (!target) return res.status(404).json({ error: "TEAM_NOT_FOUND" });
    if (target.role === "admin") {
      return res.status(400).json({ error: "CANNOT_DELETE_ADMIN" });
    }
    const deleted = await query(`delete from teams where team_id = $1`, [id]);
    res.json({ ok: true, deleted: (deleted.rowCount ?? 0) > 0 });
  } catch (err) {
    serverError(res, err);
  }
});

adminRoutes.get("/teams/:id/audit", ...adminOnly, async (req, res) => {
  const trades = await query(
    `select order_id, action, symbol, quantity, price_executed, price_requested, status, reason, latency_ms, fee, timestamp_ms
     from order_logs where team_id = $1 order by order_id desc limit 500`,
    [Number(req.params.id)],
  );
  const reqLogs = await query(
    `select method, path, status, latency_ms, created_at
     from request_logs where team_id = $1 order by id desc limit 500`,
    [Number(req.params.id)],
  );
  res.json({ trades: trades.rows, requests: reqLogs.rows });
});

adminRoutes.post("/scoring", ...adminOnly, async (req, res) => {
  const { team_id, code_quality, strategy_report } = req.body ?? {};
  if (!team_id || !Number.isFinite(Number(code_quality)) || !Number.isFinite(Number(strategy_report))) {
    return res.status(400).json({ error: "INVALID_SCORING_INPUT" });
  }
  await setJudgeScores(Number(team_id), Number(code_quality), Number(strategy_report));
  res.json({ ok: true });
});

adminRoutes.post("/scoring/compute", ...adminOnly, async (_req, res) => {
  const scores = await computeScores();
  res.json({ scores: scores.rows });
});

adminRoutes.get("/scoring", ...adminOnly, async (_req, res) => {
  const { rows } = await query(
    `select s.team_id, t.team_name, s.pnl_rank, s.pnl_score, s.drawdown_score,
            s.risk_score, s.consistency_score, s.efficiency_score,
            s.code_quality_score, s.strategy_report_score, s.final_score
     from scoring s join teams t on t.team_id = s.team_id
     order by s.final_score desc nulls last`,
  );
  res.json({ scores: rows });
});

adminRoutes.post("/autograde", ...adminOnly, async (req, res) => {
  try {
    const apiKey = process.env.LLM_API_KEY ?? config.llm.apiKey;
    if (!apiKey) {
      return res
        .status(503)
        .json({ error: "LLM_API_KEY_NOT_SET", message: "Set LLM_API_KEY to enable automatic grading." });
    }
    const teamId = req.body?.team_id ? Number(req.body.team_id) : undefined;
    const results = await autogradeSubmissions({ teamId });
    res.json({ ok: true, graded: results.length, results });
  } catch (err) {
    serverError(res, err);
  }
});

adminRoutes.get("/metrics", ...adminOnly, async (_req, res) => {
  res.json(await adminMetrics());
});

adminRoutes.post("/leaderboard/freeze", ...adminOnly, async (_req, res) => {
  await engine.freezeLeaderboard();
  res.json({ ok: true, frozen: true });
});
