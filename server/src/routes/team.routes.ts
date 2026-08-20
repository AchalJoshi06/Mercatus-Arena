import { Router, type Response } from "express";
import { requirePortal } from "../auth.js";
import { query } from "../db.js";
import { serverError } from "../http.js";
import type { AuthedRequest } from "../auth.js";
import multer from "multer";

export const teamRoutes = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const round2 = (n: number) => Math.round(n * 100) / 100;

teamRoutes.get("/portfolio", requirePortal, async (req: AuthedRequest, res: Response) => {
  try {
    const team = await query(
      `select t.team_id, t.team_name, t.cash_balance, t.starting_capital,
              round(t.cash_balance + coalesce((
                select sum(h.quantity * lp.price)
                from holdings h
                left join live_prices lp on lp.symbol = h.symbol
                where h.team_id = t.team_id and h.quantity > 0
              ), 0), 2) as total_portfolio_value,
              round(coalesce((
                select sum((lp.price - h.average_buy_price) * h.quantity)
                from holdings h
                left join live_prices lp on lp.symbol = h.symbol
                where h.team_id = t.team_id and h.quantity > 0
              ), 0), 2) as unrealized_pnl,
              (select count(*) from order_logs
               where team_id = t.team_id and status = 'SUCCESS')::int as trades_count
       from teams t where t.team_id = $1`,
      [req.team!.team_id],
    );
    const positions = await query(
      `select h.symbol, h.quantity, h.average_buy_price, lp.price as current_price,
              round(h.quantity * lp.price, 2) as market_value,
              round((lp.price - h.average_buy_price) * h.quantity, 2) as unrealized_pnl
       from holdings h
       left join live_prices lp on lp.symbol = h.symbol
       where h.team_id = $1 and h.quantity > 0
       order by h.symbol`,
      [req.team!.team_id],
    );
    const fills = await query(
      `select action, symbol, quantity, price_executed, fee, timestamp_ms
       from order_logs
       where team_id = $1 and status = 'SUCCESS' and price_executed is not null
       order by order_id asc`,
      [req.team!.team_id],
    );
    // FIFO realized PnL: match sells against buys in order of execution.
    const lots = new Map<string, { qty: number; cost: number }[]>();
    let realized = 0;
    let fees = 0;
    for (const f of fills.rows) {
      const px = Number(f.price_executed);
      const qty = Number(f.quantity);
      fees += Number(f.fee ?? 0);
      if (f.action === "BUY") {
        const q = lots.get(f.symbol) ?? [];
        q.push({ qty, cost: px });
        lots.set(f.symbol, q);
      } else {
        let remaining = qty;
        const q = lots.get(f.symbol) ?? [];
        while (remaining > 0 && q.length > 0) {
          const lot = q[0];
          const take = Math.min(remaining, lot.qty);
          realized += take * (px - lot.cost);
          lot.qty -= take;
          remaining -= take;
          if (lot.qty <= 0) q.shift();
        }
        lots.set(f.symbol, q);
      }
    }
    res.json({
      ...team.rows[0],
      realized_pnl: round2(realized - fees),
      positions: positions.rows,
      livePrices: Object.fromEntries(
        (await query(`select symbol, price from live_prices`)).rows.map((r) => [
          r.symbol,
          Number(r.price),
        ]),
      ),
    });
  } catch (err) {
    serverError(res, err);
  }
});

teamRoutes.get("/trades", requirePortal, async (req: AuthedRequest, res: Response) => {
  try {
    const limit = Math.min(Number(req.query.limit ?? 200), 1000);
    const { rows } = await query(
      `select order_id, action, symbol, quantity, price_requested, price_executed,
              status, reason, latency_ms, fee, timestamp_ms
       from order_logs where team_id = $1
       order by order_id desc limit $2`,
      [req.team!.team_id, limit],
    );
    res.json({ trades: rows });
  } catch (err) {
    serverError(res, err);
  }
});

teamRoutes.post(
  "/submission",
  requirePortal,
  upload.single("pdf"),
  async (req: AuthedRequest, res: Response) => {
    try {
      const codeRepositoryLink = req.body?.code_link ?? null;
      const pdf = req.file;
      if (!pdf && !codeRepositoryLink) {
        return res.status(400).json({ error: "NOTHING_TO_SUBMIT" });
      }
      if (pdf) {
        const magic = pdf.buffer.subarray(0, 5).toString("latin1");
        if (magic !== "%PDF-") {
          return res.status(415).json({ error: "UNSUPPORTED_FILE_TYPE" });
        }
      }
      const { rows } = await query(
        `insert into submissions (team_id, pdf_storage_url, pdf_data, pdf_name, code_repository_link)
         values ($1, $2, $3, $4, $5)
         on conflict (team_id) do update
         set pdf_data = excluded.pdf_data,
             pdf_name = excluded.pdf_name,
             code_repository_link = excluded.code_repository_link,
             updated_at = now()
         returning submission_id, updated_at`,
        [
          req.team!.team_id,
          pdf ? `upload:${pdf.originalname}` : null,
          pdf ? pdf.buffer : null,
          pdf ? pdf.originalname : null,
          codeRepositoryLink,
        ],
      );
      res.json({ submitted: rows[0] });
    } catch (err) {
      serverError(res, err);
    }
  },
);

teamRoutes.get("/submission", requirePortal, async (req: AuthedRequest, res: Response) => {
  const { rows } = await query(
    `select pdf_storage_url, pdf_name, code_repository_link, submitted_at, updated_at
     from submissions where team_id = $1`,
    [req.team!.team_id],
  );
  res.json(rows[0] ?? null);
});
