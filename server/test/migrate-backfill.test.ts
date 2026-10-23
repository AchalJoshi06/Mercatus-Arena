import { describe, it, expect, beforeAll } from "vitest";
import { query } from "../src/db.js";
import { migrate } from "../src/schema.js";
import { hashPassword } from "../src/auth.js";

// Simulates upgrading a database that predates teams.realized_pnl/total_fees:
// existing SUCCESS order_logs must be replayed (average cost) into the new columns.
describe("realized_pnl / total_fees backfill", () => {
  let teamId: number;
  let idleTeamId: number;

  beforeAll(async () => {
    await migrate();
    await query(`delete from teams where email like 'backfill-%@test'`);
    const mk = async (name: string) =>
      Number(
        (
          await query(
            `insert into teams (team_name, role, email, password_hash)
             values ($1, 'team', $2, $3) returning team_id`,
            [name, `backfill-${name}@test`, await hashPassword("x")],
          )
        ).rows[0].team_id,
      );
    teamId = await mk("trader");
    idleTeamId = await mk("idle");
    const fill = (action: string, symbol: string, qty: number, px: number, fee: number, status = "SUCCESS") =>
      query(
        `insert into order_logs (team_id, action, symbol, quantity, price_executed, status, fee)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [teamId, action, symbol, qty, px, status, fee],
      );
    await fill("BUY", "BFA", 10, 100, 0);
    await fill("BUY", "BFA", 10, 200, 10); // avg 150
    await fill("SELL", "BFA", 5, 300, 10); // +750
    await fill("BUY", "BFB", 4, 50, 10);
    await fill("SELL", "BFB", 4, 40, 10); // -40
    await fill("SELL", "BFA", 100, 999, 0, "REJECTED"); // ignored

    // Pretend the columns never existed.
    await query(`alter table teams drop column realized_pnl, drop column total_fees`);
    await migrate();
  });

  it("replays successful fills into realized_pnl and total_fees", async () => {
    const { rows } = await query(
      `select realized_pnl, total_fees from teams where team_id = $1`,
      [teamId],
    );
    expect(Number(rows[0].realized_pnl)).toBe(710);
    expect(Number(rows[0].total_fees)).toBe(40);
  });

  it("leaves teams without trades at zero", async () => {
    const { rows } = await query(
      `select realized_pnl, total_fees from teams where team_id = $1`,
      [idleTeamId],
    );
    expect(Number(rows[0].realized_pnl)).toBe(0);
    expect(Number(rows[0].total_fees)).toBe(0);
  });

  it("does not re-run once the columns exist", async () => {
    await query(`update teams set realized_pnl = 1 where team_id = $1`, [teamId]);
    await migrate();
    const { rows } = await query(`select realized_pnl from teams where team_id = $1`, [teamId]);
    expect(Number(rows[0].realized_pnl)).toBe(1);
  });
});
