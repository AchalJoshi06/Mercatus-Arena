"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  api,
  getToken,
  liveFeed,
  PricesMap,
  fmtInr,
  type STATUS,
} from "@/lib/api";
import { useStatus } from "@/lib/useStatus";
import { poller } from "@/lib/poller";
import { PPanel, Pill } from "@/components/PPanel";
import { DepthPanel } from "@/components/DepthPanel";
import { fmtSignedInr, fmtSignedPct, toneClass } from "@/lib/fmtSigned";
import { AreaChart } from "@/components/AreaChart";
import { EventBanner } from "@/components/EventBanner";
import { TickerTape } from "@/components/TickerTape";
import { CandlesChart } from "@/components/CandlesChart";
import { TradingSidebar } from "@/components/TradingSidebar";
import { OrderTicket, OrdersTable, useOrderLog } from "@/components/TradingConsole";
import { LeaderboardTable } from "@/components/LeaderboardTable";
import { PositionsTable, type Portfolio } from "@/components/TradePanel";
import { SubmissionPanel } from "@/components/TradeLog";

interface Me {
  role: string;
  api_key: string | null;
  credentials_revealed: boolean;
  team_name: string;
}

export default function DashboardPage() {
  const router = useRouter();
  const [token, setTokenState] = useState<string | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<PricesMap>({});
  const [history, setHistory] = useState<number[]>([]);
  const [activeSym, setActiveSym] = useState<string>("");
  const status = useStatus();
  const orderLog = useOrderLog();
  const [tab, setTab] = useState<"positions" | "orders" | "leaderboard" | "submissions">("positions");
  const [chartH, setChartH] = useState(340);
  const [rank, setRank] = useState<{ rank: number; of: number } | null>(null);
  const pollUnsub = useRef<(() => void) | null>(null);

  useEffect(() => {
    const t = getToken();
    setTokenState(t);
    if (!t) {
      router.replace("/login");
      return;
    }
    api<Me>("/api/auth/me", { token: t })
      .then((m) => {
        setMe(m);
        if (m.role === "admin" || m.role === "evaluator") {
          router.replace(m.role === "admin" ? "/admin" : "/evaluator");
        }
      })
      .catch(() => {
        router.replace("/login");
      });

    const load = () =>
      api<Portfolio>("/api/team/portfolio", { token: t })
        .then((p) => {
          setPortfolio(p);
          setHistory((h) => {
            const next = [...h, Number(p.total_portfolio_value)];
            return next.slice(-240);
          });
        })
        .catch((e) => setError((e as Error).message));
    void load();
    pollUnsub.current = poller.register("dashboard:portfolio", load, 3000);
    return () => {
      if (pollUnsub.current) pollUnsub.current();
    };
  }, [router]);

  useEffect(() => {
    const un = liveFeed.subscribe((p) => setLive(p));
    return un;
  }, []);

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1280px)");
    const apply = () => setChartH(mq.matches ? 400 : window.innerWidth >= 768 ? 380 : 300);
    apply();
    window.addEventListener("resize", apply);
    return () => window.removeEventListener("resize", apply);
  }, []);

  const teamId = portfolio?.team_id;
  useEffect(() => {
    if (teamId == null) return;
    const load = () =>
      api<{ teams: { team_id: string | number; rank: string | number }[] }>("/api/market/leaderboard")
        .then((d) => {
          const mine = d.teams.find((t) => String(t.team_id) === String(teamId));
          setRank(mine ? { rank: Number(mine.rank), of: d.teams.length } : null);
        })
        .catch(() => {});
    void load();
    return poller.register("dashboard:rank", load, 5000);
  }, [teamId]);

  useEffect(() => {
    if (!activeSym && portfolio) {
      setActiveSym(Object.keys(portfolio.livePrices)[0] ?? "");
    }
  }, [portfolio, activeSym]);

  if (error && !portfolio) {
    return (
      <div className="mx-auto max-w-sm py-20 text-center">
        <p className="text-sell">{error}</p>
        <Link href="/login" className="mt-4 inline-block text-acc hover:underline">
          Sign in again
        </Link>
      </div>
    );
  }

  if (!token || !portfolio || !me) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3">
        <span className="inline-block h-8 w-8 animate-spin rounded-full border-2 border-line border-t-acc" />
        <span className="text-sm text-dim">Loading trading desk…</span>
      </div>
    );
  }

  const capital = Number(portfolio.starting_capital) || 1;
  const total = Number(portfolio.total_portfolio_value);
  const cash = Number(portfolio.cash_balance);
  const pnl = total - capital;
  const pnlPct = (pnl / capital) * 100;
  const realized = Number(portfolio.realized_pnl ?? 0);
  const unrealized = Number(portfolio.unrealized_pnl ?? 0);
  const tradesUsed = portfolio.trades_count ?? 0;
  const freeTradesLeft = Math.max(0, 100 - tradesUsed);
  const symbols = Object.keys(portfolio.livePrices);
  const prices = { ...portfolio.livePrices, ...live };
  const state = status?.state ?? "PRE_LAUNCH";
  const apiKey = me.credentials_revealed ? me.api_key : null;
  const refresh = () => api<Portfolio>("/api/team/portfolio", { token }).then(setPortfolio);

  const kpis: { label: string; value: string; tone?: number; sub?: string }[] = [
    { label: "Portfolio value", value: fmtInr(total) },
    { label: "Cash", value: fmtInr(cash) },
    { label: "Realized PnL", value: fmtSignedInr(realized), tone: realized },
    { label: "Unrealized PnL", value: fmtSignedInr(unrealized), tone: unrealized },
    { label: "Total PnL", value: fmtSignedPct(pnlPct), tone: pnl, sub: fmtSignedInr(pnl) },
    { label: "Free trades left", value: String(freeTradesLeft), sub: `${tradesUsed} used` },
    { label: "Rank", value: rank ? `#${rank.rank}` : "—", sub: rank ? `of ${rank.of} ${rank.of === 1 ? "team" : "teams"}` : undefined },
  ];

  const tabs = [
    { id: "positions", label: "Positions", count: portfolio.positions.length },
    { id: "orders", label: "Orders", count: orderLog.log.length },
    { id: "leaderboard", label: "Leaderboard" },
    { id: "submissions", label: "Submissions" },
  ] as const;

  return (
    <div className="flex w-full min-w-0 flex-col gap-4 xl:grid xl:grid-cols-[244px_minmax(0,1fr)_280px]">
      <div className="order-1 min-w-0 xl:col-span-3 xl:row-start-1">
        <EventBanner status={status ?? ({ state: "PRE_LAUNCH" } as STATUS)} />
      </div>

      <div className="order-2 min-w-0 flex flex-wrap items-center gap-x-3 gap-y-1 xl:col-span-3 xl:row-start-2">
        <h1 className="truncate font-display text-xl font-bold tracking-tight text-ink">{portfolio.team_name}</h1>
        <Pill>desk</Pill>
        <span className="text-[12px] text-dim">
          {me.credentials_revealed && me.api_key ? (
            <>
              API key <code className="num bg-panel2 px-1.5 py-0.5 text-buy">{me.api_key}</code>
            </>
          ) : (
            "API key sealed until launch"
          )}
        </span>
      </div>

      {/* KPI strip */}
      <div className="order-[6] min-w-0 grid grid-cols-2 gap-px border border-line bg-line sm:grid-cols-4 xl:order-3 xl:col-span-3 xl:row-start-3 xl:grid-cols-7">
        {kpis.map((k, i) => (
          <div
            key={k.label}
            className={`min-w-0 bg-panel px-4 py-3 ${i === 0 ? "col-span-2 sm:col-span-4 xl:col-span-1" : ""}`}
          >
            <div className="text-[10px] font-semibold uppercase tracking-wider text-dim">{k.label}</div>
            <div className={`num mt-1 whitespace-nowrap text-[17px] font-bold ${k.tone != null ? toneClass(k.tone) : "text-ink"}`}>
              {k.value}
            </div>
            <div className="num mt-0.5 h-4 text-[11px] text-muted">{k.sub ?? ""}</div>
          </div>
        ))}
      </div>

      {/* Watchlist */}
      <div className="relative order-[8] min-w-0 xl:order-4 xl:col-start-1 xl:row-start-4 xl:min-h-[560px]">
        <TradingSidebar symbols={symbols} prices={prices} active={activeSym} onSelect={setActiveSym} state={state} />
      </div>

      {/* Chart + depth */}
      <div className="order-3 flex min-w-0 flex-col gap-4 xl:order-5 xl:col-start-2 xl:row-start-4">
        <CandlesChart
          symbols={symbols}
          initialPrices={portfolio.livePrices}
          state={state}
          height={chartH}
          active={activeSym}
          onActiveChange={setActiveSym}
        />
        <DepthPanel symbol={activeSym} last={prices[activeSym]} state={state} />
      </div>

      {/* Ticket + portfolio */}
      <div className="order-4 flex min-w-0 flex-col gap-4 xl:order-6 xl:col-start-3 xl:row-start-4">
        <OrderTicket
          portfolio={portfolio}
          apiKey={apiKey}
          symbol={activeSym}
          symbols={[...symbols].sort()}
          onSymbolChange={setActiveSym}
          orderLog={orderLog}
          onTraded={refresh}
        />
        <PPanel className="flex flex-1 flex-col" bodyClassName="flex flex-1 flex-col" title="Portfolio" right={<Pill color={pnl >= 0 ? "#26a69a" : "#ef5350"}>{fmtSignedPct(pnlPct)}</Pill>}>
          <div className="num text-2xl font-bold text-ink">{fmtInr(total)}</div>
          <div className={`num text-[12px] ${toneClass(pnl)}`}>{fmtSignedInr(pnl)} vs start</div>
          <div className="mt-3 min-h-14 flex-1">
            <AreaChart data={history} height={56} id="portfolio" />
          </div>
        </PPanel>
      </div>

      {/* Positions / Orders / Leaderboard / Submissions */}
      <div className="order-7 min-w-0 xl:order-7 xl:col-span-3 xl:row-start-5">
        <section className="overflow-hidden border border-line bg-panel">
          <div role="tablist" className="flex overflow-x-auto border-b border-line bg-panel2/60">
            {tabs.map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={tab === t.id}
                onClick={() => setTab(t.id)}
                className={`flex shrink-0 items-center gap-2 border-b-2 px-4 py-3 text-[11px] font-bold uppercase tracking-[0.12em] transition-colors ${
                  tab === t.id ? "border-acc text-ink" : "border-transparent text-dim hover:text-muted"
                }`}
              >
                {t.label}
                {"count" in t && <span className="num bg-line px-1.5 text-[10px] text-muted">{t.count}</span>}
              </button>
            ))}
          </div>
          {tab === "positions" && <PositionsTable portfolio={portfolio} live={live} />}
          {tab === "orders" && <OrdersTable orderLog={orderLog} />}
          {tab === "leaderboard" && <LeaderboardTable variant="embedded" />}
          {tab === "submissions" && <SubmissionPanel />}
        </section>
      </div>

      <div className="order-9 min-w-0 overflow-hidden xl:col-span-3 xl:row-start-6">
        <TickerTape symbols={symbols} prices={prices} state={state} />
      </div>
    </div>
  );
}
