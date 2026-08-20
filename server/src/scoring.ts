import { query } from "./db.js";

// Final composite: 60% PnL score (normalization/drawdown/risk/consistency),
// 20% code quality, 15% strategy report, 5% efficiency (failed orders, API).
const FINAL_WEIGHTS = { pnl: 0.6, code: 0.2, report: 0.15, efficiency: 0.05 };
const PNL_WEIGHTS = { norm: 0.45, drawdown: 0.2, risk: 0.15, consistency: 0.2 };
const CONSISTENCY_BUCKETS = 12;

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

interface TeamRow {
  team_id: number;
  team_name: string;
  total_portfolio_value: string;
  starting_capital: string;
}

interface OrderRow {
  order_id: number;
  team_id: number;
  action: "BUY" | "SELL";
  symbol: string;
  quantity: string;
  price_executed: string | null;
  status: string;
  reason: string | null;
  latency_ms: number | null;
  timestamp_ms: string;
  fee: string | null;
}

interface CurvePoint {
  ts: number;
  eq: number;
}

function linearInterp(curve: CurvePoint[], ts: number): number {
  if (ts <= curve[0].ts) return curve[0].eq;
  const last = curve[curve.length - 1];
  if (ts >= last.ts) return last.eq;
  for (let i = 1; i < curve.length; i++) {
    if (curve[i].ts >= ts) {
      const a = curve[i - 1];
      const b = curve[i];
      const span = b.ts - a.ts;
      if (span <= 0) return b.eq;
      return a.eq + ((b.eq - a.eq) * (ts - a.ts)) / span;
    }
  }
  return last.eq;
}

export async function computeScores() {
  const { rows: teams } = await query<TeamRow>(
    `select team_id, team_name, total_portfolio_value, starting_capital
     from teams where role = 'team'`,
  );
  const scorable = teams.filter((t) => Number(t.starting_capital) > 0);
  if (scorable.length === 0) {
    return query(`select * from scoring where false`);
  }

  const ev = (
    await query(
      `select event_started_at, scheduled_end_at, replay_speed from event_config where id = true`,
    )
  ).rows[0] as { event_started_at: string | null; scheduled_end_at: string | null; replay_speed: string } | null;
  const eventStartMs = ev?.event_started_at ? Date.parse(ev.event_started_at) : null;
  const replay = Number(ev?.replay_speed ?? 1);

  const ds = (
    await query(
      `select dataset_id, start_t, end_t from market_datasets where is_active = true limit 1`,
    )
  ).rows[0] as { dataset_id: number; start_t: string; end_t: string } | null;

  let ticksBySymbol: Map<string, { t: number; price: number }[]> | null = null;
  if (ds && eventStartMs) {
    const { rows } = await query(
      `select t, symbol, price from dataset_ticks where dataset_id = $1 order by symbol, t`,
      [ds.dataset_id],
    );
    ticksBySymbol = new Map();
    for (const r of rows) {
      const arr = ticksBySymbol.get(r.symbol) ?? [];
      arr.push({ t: Number(r.t), price: Number(r.price) });
      ticksBySymbol.set(r.symbol, arr);
    }
  }

  const ids = scorable.map((t) => t.team_id);
const { rows: orderRows } = await query<OrderRow>(
    `select order_id, team_id, action, symbol, quantity, price_executed,
            status, reason, latency_ms, timestamp_ms, fee
     from order_logs where team_id = any($1)`,
    [ids],
  );
  const ordersByTeam = new Map<number, OrderRow[]>();
  for (const o of orderRows) {
    const arr = ordersByTeam.get(o.team_id) ?? [];
    arr.push(o);
    ordersByTeam.set(o.team_id, arr);
  }

  const priceAt = (symbol: string, tsMs: number): number | null => {
    if (!ds || !ticksBySymbol || eventStartMs === null) return null;
    const arr = ticksBySymbol.get(symbol);
    if (!arr || arr.length === 0) return null;
    const t = clamp(
      Number(ds.start_t) + (tsMs - eventStartMs) * replay,
      Number(ds.start_t),
      Number(ds.end_t),
    );
    let lo = 0;
    let hi = arr.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid].t <= t) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return best === -1 ? arr[0].price : arr[best].price;
  };

  const equityCurve = (
    orders: OrderRow[],
    startCap: number,
    finalTpv: number,
  ): CurvePoint[] => {
    const sorted = orders
      .filter((o) => o.status === "SUCCESS" && o.price_executed != null)
      .sort((a, b) => Date.parse(a.timestamp_ms) - Date.parse(b.timestamp_ms) || a.order_id - b.order_id);

    // Timeline: order fills + evenly spaced marks to capture holding drift.
    const events: { ts: number; order?: OrderRow }[] = [];
    for (const o of sorted) events.push({ ts: Date.parse(o.timestamp_ms), order: o });
    if (sorted.length > 0) {
      const t0 = events[0].ts;
      const t1 = events[events.length - 1].ts;
      const sampleCount = Math.min(60, Math.floor((t1 - t0) / 60_000));
      for (let i = 1; i < sampleCount; i++) {
        const ts = t0 + Math.floor(((t1 - t0) * i) / sampleCount);
        if (!events.some((e) => Math.abs(e.ts - ts) < 1000)) events.push({ ts });
      }
    }
    events.sort((a, b) => a.ts - b.ts || (a.order ? 0 : 1));

    const pos = new Map<string, number>();
    const lastFill = new Map<string, number>();
    let cash = startCap;
    const curve: CurvePoint[] = [];
    for (const ev of events) {
if (ev.order) {
        const o = ev.order;
        const px = Number(o.price_executed);
        const qty = Number(o.quantity);
        const fee = Number(o.fee ?? 0);
        if (o.action === "BUY") {
          cash -= px * qty + fee;
          pos.set(o.symbol, (pos.get(o.symbol) ?? 0) + qty);
        } else {
          cash += px * qty - fee;
          pos.set(o.symbol, Math.max(0, (pos.get(o.symbol) ?? 0) - qty));
        }
        lastFill.set(o.symbol, px);
      }
      let mtm = 0;
      for (const [s, q] of pos) {
        if (q <= 0) continue;
        // Mark the just-traded symbol at its own fill price (self-consistent);
        // everything else uses the dataset price, falling back to last fill.
        const p =
          ev.order?.symbol === s ? lastFill.get(s)! : priceAt(s, ev.ts) ?? lastFill.get(s) ?? 0;
        mtm += q * p;
      }
      curve.push({ ts: ev.ts, eq: cash + mtm });
    }
    const finalTs = curve.length > 0 ? curve[curve.length - 1].ts : Date.now();
    if (curve.length > 0 && curve[curve.length - 1].ts === finalTs) {
      curve[curve.length - 1].eq = finalTpv;
    } else {
      curve.push({ ts: finalTs, eq: finalTpv });
    }
    return curve;
  };

  const perTeam = new Map<
    number,
    { ret: number; curve: CurvePoint[]; orders: OrderRow[] }
  >();
  for (const t of scorable) {
    const orders = ordersByTeam.get(t.team_id) ?? [];
    const startCap = Number(t.starting_capital);
    const finalTpv = Number(t.total_portfolio_value);
    perTeam.set(t.team_id, {
      ret: startCap > 0 ? finalTpv / startCap - 1 : 0,
      curve: equityCurve(orders, startCap, finalTpv),
      orders,
    });
  }

  const maxRet = Math.max(...[...perTeam.values()].map((p) => p.ret));
  const ranked = [...scorable].sort(
    (a, b) => Number(b.total_portfolio_value) - Number(a.total_portfolio_value),
  );
  const cnt = ranked.length;

  const rows: { team_id: number; score: Record<string, number> }[] = [];
  ranked.forEach((t, i) => {
    const { ret, curve, orders: teamOrders } = perTeam.get(t.team_id)!;

    // Normalization: blend of rank position and return magnitude.
    const rankScore = 100 * (1 - i / cnt);
    const magScore = maxRet > 0 ? clamp((100 * Math.max(0, ret)) / maxRet, 0, 100) : 50;
    const normScore = PNL_WEIGHTS.norm === 0 ? 0 : rankScore * 0.5 + magScore * 0.5;

    // Drawdown from the reconstructed equity curve.
    let mdd = 0;
    let peak = 0;
    for (const p of curve) {
      if (p.eq > peak) peak = p.eq;
      const dd = peak > 0 ? (peak - p.eq) / peak : 0;
      if (dd > mdd) mdd = dd;
    }
    const ddScore = 100 * Math.exp(-6 * mdd);

    // Risk: volatility of per-interval returns -> Sharpe-style score.
    let riskScore: number;
    const intervals: number[] = [];
    for (let k = 1; k < curve.length; k++) {
      const prev = curve[k - 1].eq;
      if (prev > 0) intervals.push((curve[k].eq - prev) / prev);
    }
    if (intervals.length === 0) {
      riskScore = ret > 0 ? 100 : 50;
    } else {
      const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      const std = Math.sqrt(
        intervals.reduce((a, b) => a + (b - mean) ** 2, 0) / intervals.length,
      );
      riskScore =
        std === 0
          ? mean >= 0
            ? 100
            : 0
          : clamp(50 + 50 * Math.tanh((mean / std) * 0.8), 0, 100);
    }

    // Consistency: fraction of equal time buckets with non-negative equity change.
    let consistencyScore = 50;
    if (curve.length >= 2) {
      const t0 = curve[0].ts;
      const t1 = curve[curve.length - 1].ts;
      if (t1 > t0) {
        let good = 0;
        for (let b = 0; b < CONSISTENCY_BUCKETS; b++) {
          const a = t0 + ((t1 - t0) * b) / CONSISTENCY_BUCKETS;
          const c = t0 + ((t1 - t0) * (b + 1)) / CONSISTENCY_BUCKETS;
          if (linearInterp(curve, c) >= linearInterp(curve, a)) good++;
        }
        consistencyScore = (100 * good) / CONSISTENCY_BUCKETS;
      }
    }

    const pnlScore =
      PNL_WEIGHTS.norm * normScore +
      PNL_WEIGHTS.drawdown * ddScore +
      PNL_WEIGHTS.risk * riskScore +
      PNL_WEIGHTS.consistency * consistencyScore;

    // Efficiency: penalize rejected orders and slow API usage.
    let effScore = 80;
    if (teamOrders.length > 0) {
      const rejected = teamOrders.filter((o) => o.status === "REJECTED").length;
      const rejectRate = rejected / teamOrders.length;
      const avgMs =
        teamOrders.reduce((a, o) => a + (o.latency_ms ?? 0), 0) / teamOrders.length;
      effScore = clamp(100 - 70 * rejectRate - clamp((avgMs - 50) / 30, 0, 30), 0, 100);
    }

    rows.push({
      team_id: t.team_id,
      score: {
        pnl_rank: i + 1,
        pnl_score: round(pnlScore),
        drawdown_score: round(ddScore),
        risk_score: round(riskScore),
        consistency_score: round(consistencyScore),
        efficiency_score: round(effScore),
        final_score: 0,
      },
    });
  });

  // Merge judge scores (code 20% / report 15%) from the scoring table.
  const judge = (
    await query(
      `select team_id, code_quality_score, strategy_report_score
       from scoring where team_id = any($1)`,
      [ids],
    )
  ).rows as { team_id: number; code_quality_score: string | null; strategy_report_score: string | null }[];
  const judgeByTeam = new Map(judge.map((j) => [j.team_id, j]));

  for (const r of rows) {
    const j = judgeByTeam.get(r.team_id);
    const code = Number(j?.code_quality_score ?? 0);
    const report = Number(j?.strategy_report_score ?? 0);
    r.score.final_score = round(
      FINAL_WEIGHTS.pnl * r.score.pnl_score! +
        FINAL_WEIGHTS.code * code +
        FINAL_WEIGHTS.report * report +
        FINAL_WEIGHTS.efficiency * r.score.efficiency_score!,
    );
  }

  const values: unknown[] = [];
  rows.forEach((r, i) => {
    const s = r.score;
    values.push(
      r.team_id,
      s.pnl_rank,
      s.pnl_score,
      s.drawdown_score,
      s.risk_score,
      s.consistency_score,
      s.efficiency_score,
      s.final_score,
    );
  });
  const cols = 8;
  const placeholders = rows
    .map(
      (_, i) =>
        `(${Array.from(
          { length: cols },
          (_, j) => `$${i * cols + j + 1}`,
        ).join(",")})`,
    )
    .join(",");
  await query(
    `insert into scoring (team_id, pnl_rank, pnl_score, drawdown_score, risk_score,
                          consistency_score, efficiency_score, final_score)
     values ${placeholders}
     on conflict (team_id) do update
     set pnl_rank = excluded.pnl_rank,
         pnl_score = excluded.pnl_score,
         drawdown_score = excluded.drawdown_score,
         risk_score = excluded.risk_score,
         consistency_score = excluded.consistency_score,
         efficiency_score = excluded.efficiency_score,
         final_score = excluded.final_score,
         updated_at = now()`,
    values,
  );

  return query(
    `select team_id, pnl_rank, pnl_score, drawdown_score, risk_score,
            consistency_score, efficiency_score, code_quality_score,
            strategy_report_score, final_score
     from scoring order by final_score desc nulls last`,
  );
}

export async function setJudgeScores(
  teamId: number,
  codeQuality: number,
  strategyReport: number,
) {
  return query(
    `insert into scoring (team_id, code_quality_score, strategy_report_score)
     values ($1, $2, $3)
     on conflict (team_id) do update
     set code_quality_score = excluded.code_quality_score,
         strategy_report_score = excluded.strategy_report_score,
         updated_at = now()`,
    [teamId, codeQuality, strategyReport],
  );
}

export async function adminMetrics() {
  const latency = await query(
    `select
       count(*) as requests,
       round(avg(latency_ms), 1) as avg_latency_ms,
       percentile_cont(0.95) within group (order by latency_ms) as p95_ms,
       percentile_cont(0.99) within group (order by latency_ms) as p99_ms,
       count(*) filter (where status >= 400) as errors
     from request_logs`,
  );
  const fills = await query(
    `select team_id,
       count(*) filter (where status = 'SUCCESS') as filled,
       count(*) filter (where status = 'REJECTED') as rejected,
       count(*) filter (where reason = 'INSUFFICIENT_FUNDS') as insufficient_funds,
       round(avg(latency_ms) filter (where status = 'SUCCESS'), 1) as avg_trade_ms
     from order_logs
     group by team_id`,
  );
  const { rows: teamRows } = await query(
    `select team_id, team_name, email, is_frozen, cash_balance, total_portfolio_value,
            api_key, role
     from teams order by role desc, team_name`,
  );
  const teams = teamRows.map((t) => ({
    ...t,
    api_key: t.api_key ? mask(t.api_key) : null,
  }));
  const live = await query(`select * from live_prices order by symbol`);
  return { latency: latency.rows[0], fills: fills.rows, teams, live: live.rows };
}

export const mask = (k: string | null) =>
  k ? `${k.slice(0, 6)}...${k.slice(-4)}` : null;
