import { describe, it, expect, beforeAll } from "vitest";
import { query } from "../src/db.js";
import { migrate } from "../src/schema.js";
import { computeScores, setJudgeScores, adminMetrics } from "../src/scoring.js";

beforeAll(async () => {
  await migrate();
  await query(`delete from scoring`);
  await query(`delete from order_logs where team_id in (select team_id from teams where email like 'score-%@test')`);
  await query(`delete from teams where email like 'score-%@test'`);
});

async function addTeam(name: string, pv: number, start: number = pv) {
  const { rows } = await query(
    `insert into teams (team_name, role, email, cash_balance, total_portfolio_value, starting_capital)
     values ($1, 'team', $2, $3, $3, $4)
     returning team_id`,
    [name, `score-${name}@test`, pv, start],
  );
  return Number(rows[0].team_id);
}

describe("scoring", () => {
  it("computes finals with the 60/20/15/5 formula", async () => {
    const a = await addTeam("alpha", 150_000, 100_000);
    const b = await addTeam("bravo", 100_000);
    const c = await addTeam("charlie", 50_000, 100_000);

    await setJudgeScores(b, 80, 90);
    await setJudgeScores(c, 60, 70);

    const { rows } = await computeScores();
    const byTeam = Object.fromEntries(rows.map((r) => [r.team_id, r]));

    // No order logs: drawdown 0 -> 100, risk (ret>0) -> 100, consistency -> 50,
    // efficiency (no orders) -> 80. Rank 1 of 3 -> norm = 0.5*100 + 0.5*100 = 100.
    // pnl = 0.45*100 + 0.2*100 + 0.15*100 + 0.2*50 = 90
    // final = 0.6*90 + 0.2*0 + 0.15*0 + 0.05*80 = 58
    expect(Number(byTeam[a].final_score)).toBe(58);
    // rank 2: norm = 0.5*66.67 + 0 (ret=0) = 33.33
    // pnl = 0.45*33.33 + 20 + 7.5 + 10 = 52.5
    // final = 31.5 + 16 + 13.5 + 4 = 65
    expect(Number(byTeam[b].final_score)).toBeCloseTo(65, 1);
    // rank 3: norm = 0.5*33.33 = 16.67; pnl = 7.5+20+7.5+10 = 45
    // final = 27 + 12 + 10.5 + 4 = 53.5
    expect(Number(byTeam[c].final_score)).toBeCloseTo(53.5, 1);

    expect(byTeam[a].pnl_rank).toBe(1);
    expect(Number(byTeam[a].pnl_score)).toBeCloseTo(90, 1);
    expect(Number(byTeam[a].efficiency_score)).toBe(80);
  });

  it("penalizes rejected orders in the efficiency score", async () => {
    const t = await addTeam("epsilon", 100_000);
    await query(
      `insert into order_logs (team_id, action, symbol, quantity, status, reason, latency_ms)
       values
         ($1, 'BUY',  'AAPL', 10, 'SUCCESS',  null,  40),
         ($1, 'BUY',  'AAPL', 10, 'REJECTED', 'INSUFFICIENT_FUNDS', 25),
         ($1, 'SELL', 'AAPL', 10, 'REJECTED', 'INSUFFICIENT_POSITION', 30)`,
      [t],
    );
    const { rows } = await computeScores();
    const row = rows.find((r) => Number(r.team_id) === t)!;
    // reject rate 2/3 -> -46.67; avg latency 31.7ms -> 0 penalty; eff = 53.33
    expect(Number(row.efficiency_score)).toBeCloseTo(53.33, 1);
  });

  it("exposes admin metrics", async () => {
    const m = await adminMetrics();
    expect(m).toHaveProperty("latency");
    expect(m).toHaveProperty("fills");
    expect(Array.isArray(m.teams)).toBe(true);
    expect(Array.isArray(m.live)).toBe(true);
  });
});