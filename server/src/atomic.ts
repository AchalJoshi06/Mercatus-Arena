import { tx } from "./db.js";
import { broadcast } from "./ws.js";
import { config } from "./config.js";

let livePriceProvider: ((symbol: string) => number | undefined) | null = null;
/** Engine registers its in-memory price accessor so fills use the freshest price. */
let fillListener: ((symbol: string, qty: number, price: number) => void) | null = null;

/** Engine hook: counts successful team fills toward market volume. */
export function setFillListener(fn: ((symbol: string, qty: number, price: number) => void) | null) {
  fillListener = fn;
}

export function setLivePriceProvider(fn: ((symbol: string) => number | undefined) | null) {
  livePriceProvider = fn;
}

export type TradeAction = "BUY" | "SELL";

export interface OrderRequest {
  teamId: number;
  action: TradeAction;
  symbol: string;
  quantity: number;
  price: number | null;
  clientRef?: string;
}

export interface OrderResult {
  orderId: number;
  status: "SUCCESS" | "REJECTED";
  reason: string | null;
  priceExecuted: number | null;
  quantity: number;
  cashAfter: number;
  latencyMs: number;
  fee: number;
}

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

export async function executeOrder(req: OrderRequest): Promise<OrderResult> {
  const start = process.hrtime();
  const result = await tx<OrderResult>(async (client) => {
    const latencyMs = () => {
      const [sec, nsec] = process.hrtime(start);
      return Math.round(sec * 1000 + nsec / 1e6);
    };

    const reject = async (
      reason: string,
    ): Promise<OrderResult> => {
      const { rows } = await client.query(
        `insert into order_logs
           (team_id, action, symbol, quantity, price_requested, status, reason, latency_ms, client_ref, fee)
         values ($1, $2, $3, $4, $5, 'REJECTED', $6, $7, $8, 0)
         returning order_id`,
        [
          req.teamId,
          req.action,
          req.symbol,
          req.quantity,
          req.price,
          reason,
          latencyMs(),
          req.clientRef ?? null,
        ],
      );
      return {
        orderId: Number(rows[0].order_id),
        status: "REJECTED",
        reason,
        priceExecuted: null,
        quantity: req.quantity,
        cashAfter: 0,
        latencyMs: latencyMs(),
        fee: 0,
      };
    };

    const team = await client.query(
      `select team_id, cash_balance, is_frozen, total_fees from teams where team_id = $1 for update`,
      [req.teamId],
    );
    if (!team.rows[0]) return reject("UNKNOWN_TEAM");
    if (team.rows[0].is_frozen) return reject("TEAM_FROZEN");

    const state = await client.query(
      `select state, paused from event_config where id = true`,
    );
    if (state.rows[0].state !== "ACTIVE_MARKET") {
      return reject(`MARKET_NOT_ACTIVE:${state.rows[0].state}`);
    }
    if (state.rows[0].paused) return reject("MARKET_PAUSED");

    const px = await client.query(
      `select price from live_prices where symbol = $1`,
      [req.symbol],
    );
    if (!px.rows[0]) return reject("INVALID_SYMBOL");
    const enginePx = livePriceProvider?.(req.symbol);
    const marketPrice =
      enginePx !== undefined && Number.isFinite(enginePx) && enginePx > 0
        ? enginePx
        : Number(px.rows[0].price);

    let fillPrice = marketPrice;
    if (req.price !== null) {
      if (req.action === "BUY" && req.price < marketPrice) {
        return reject("LIMIT_NOT_REACHED");
      }
      if (req.action === "SELL" && req.price > marketPrice) {
        return reject("LIMIT_NOT_REACHED");
      }
      fillPrice = req.price;
    }
    fillPrice = round(fillPrice, 4);

    // Brokerage: ₹10 per trade after the first FREE_TRADES successful fills.
    // Fast path: if total_fees > 0 the team has already crossed the threshold —
    // skip the expensive count(*) on order_logs entirely.
    // Slow path: only count when still in the free window (≤ FREE_TRADES rows).
    let fee: number;
    if (Number(team.rows[0].total_fees) > 0) {
      fee = config.brokerage.feePerTrade;
    } else {
      const prior = await client.query(
        `select count(*)::int as n from order_logs
         where team_id = $1 and status = 'SUCCESS'
           and order_id > (select fee_window_start_order_id from teams where team_id = $1)`,
        [req.teamId],
      );
      fee = prior.rows[0].n + 1 > config.brokerage.freeTrades
        ? config.brokerage.feePerTrade
        : 0;
    }
    fee = round(fee, 2);


    if (req.action === "BUY") {
      const notional = round(fillPrice * req.quantity, 2);
      if (Number(team.rows[0].cash_balance) < notional + fee) {
        return reject("INSUFFICIENT_FUNDS");
      }
      await client.query(
        `update teams set cash_balance = cash_balance - $1 where team_id = $2`,
        [round(notional + fee, 2), req.teamId],
      );
      await client.query(
        `update teams set total_fees = total_fees + $1 where team_id = $2`,
        [fee, req.teamId],
      );
      await client.query(
        `insert into holdings (team_id, symbol, quantity, average_buy_price)
         values ($1, $2, $3, $4)
         on conflict (team_id, symbol) do update
         set quantity = holdings.quantity + excluded.quantity,
             average_buy_price =
               (holdings.average_buy_price * holdings.quantity + excluded.average_buy_price * excluded.quantity)
               / (holdings.quantity + excluded.quantity)`,
        [req.teamId, req.symbol, req.quantity, fillPrice],
      );
    } else {
      const holding = await client.query(
        // Read quantity AND average_buy_price under the same FOR UPDATE lock so
        // both values are captured atomically before the quantity is decremented.
        // Doing a second SELECT after the UPDATE is a race: another transaction
        // could delete a zero-quantity row between the two queries.
        `select quantity, average_buy_price from holdings
         where team_id = $1 and symbol = $2 for update`,
        [req.teamId, req.symbol],
      );
      if (!holding.rows[0] || Number(holding.rows[0].quantity) < req.quantity) {
        return reject("INSUFFICIENT_POSITION");
      }
      // Capture avgBuyPrice here — before the UPDATE that may zero-out the row.
      const avgBuyPrice = Number(holding.rows[0].average_buy_price ?? 0);
      await client.query(
        `update holdings set quantity = quantity - $1 where team_id = $2 and symbol = $3`,
        [req.quantity, req.teamId, req.symbol],
      );
      const pnlDelta = round(req.quantity * (fillPrice - avgBuyPrice), 2);
      await client.query(
        `update teams set realized_pnl = realized_pnl + $1 where team_id = $2`,
        [pnlDelta, req.teamId],
      );
      await client.query(
        `update teams set cash_balance = cash_balance + $1 where team_id = $2`,
        [round(fillPrice * req.quantity - fee, 2), req.teamId],
      );
      await client.query(
        `update teams set total_fees = total_fees + $1 where team_id = $2`,
        [fee, req.teamId],
      );
    }


    // Value holdings at the same price source used for fills (engine in-memory
    // price when available, else live_prices) so portfolio value is consistent.
    const hs = await client.query(
      `select h.symbol, h.quantity, lp.price
       from holdings h left join live_prices lp on lp.symbol = h.symbol
       where h.team_id = $1 and h.quantity > 0`,
      [req.teamId],
    );
    let holdingsValue = 0;
    for (const h of hs.rows) {
      const ep = livePriceProvider?.(h.symbol);
      const p = ep !== undefined && Number.isFinite(ep) && ep > 0 ? ep : Number(h.price ?? 0);
      holdingsValue += Number(h.quantity) * p;
    }
    await client.query(
      `update teams set total_portfolio_value = cash_balance + $2 where team_id = $1`,
      [req.teamId, round(holdingsValue, 2)],
    );

    const { rows } = await client.query(
      `insert into order_logs
         (team_id, action, symbol, quantity, price_requested, price_executed, status, latency_ms, client_ref, fee)
       values ($1, $2, $3, $4, $5, $6, 'SUCCESS', $7, $8, $9)
       returning order_id`,
      [
        req.teamId,
        req.action,
        req.symbol,
        req.quantity,
        req.price,
        fillPrice,
        latencyMs(),
        req.clientRef ?? null,
        fee,
      ],
    );

    const after = await client.query(
      `select cash_balance from teams where team_id = $1`,
      [req.teamId],
    );

    return {
      orderId: Number(rows[0].order_id),
      status: "SUCCESS",
      reason: null,
      priceExecuted: fillPrice,
      quantity: req.quantity,
      cashAfter: Number(after.rows[0].cash_balance),
      latencyMs: latencyMs(),
      fee,
    };
  });

  broadcast(
    {
      type: "order",
      orderId: result.orderId,
      status: result.status,
      reason: result.reason,
      action: req.action,
      symbol: req.symbol,
      quantity: req.quantity,
      priceExecuted: result.priceExecuted,
      cashAfter: result.cashAfter,
      latencyMs: result.latencyMs,
      fee: result.fee,
    },
    { teamId: req.teamId },
  );
  if (result.status === "SUCCESS" && result.priceExecuted != null) {
    fillListener?.(req.symbol, req.quantity, Number(result.priceExecuted));
  }

  // No cache invalidation here: no read endpoint caches trade-dependent data,
  // and wiping the whole cache on every trade defeats it at event trade rates.
  return result;
}
