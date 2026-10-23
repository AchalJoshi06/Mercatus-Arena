"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api, fmtInr, getToken } from "@/lib/api";
import { poller } from "@/lib/poller";
import { useStatus } from "@/lib/useStatus";
import { fmtSignedInr, fmtSignedPct, toneClass } from "@/lib/fmtSigned";
import { PPanel, Pill } from "./PPanel";

interface Row {
  rank: number | string;
  team_id: number | string;
  team_name: string;
  total_portfolio_value: string;
}

const MEDAL: Record<number, string> = { 1: "#f0b90b", 2: "#aab6c4", 3: "#cd7f32" };

function RankMark({ rank }: { rank: number }) {
  const c = MEDAL[rank];
  if (c) {
    return (
      <span
        className="inline-grid h-7 w-7 place-items-center font-mono text-[12px] font-black"
        style={{ backgroundColor: c, color: "#080b11" }}
      >
        {rank}
      </span>
    );
  }
  return (
    <span className="inline-grid h-7 w-7 place-items-center border border-line bg-panel2 font-mono text-[12px] text-muted">
      {rank}
    </span>
  );
}

/**
 * variant "full": podium cards + complete ranked table.
 * variant "embedded": table only, no panel chrome (used inside dashboard tabs).
 * compact (legacy): panel with the top 5 rows.
 */
export function LeaderboardTable({
  compact = false,
  variant = "panel",
}: {
  compact?: boolean;
  variant?: "panel" | "full" | "embedded";
}) {
  const status = useStatus();
  const capital = status?.startCapital || 100000;
  const [frozen, setFrozen] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [myId, setMyId] = useState<string | null>(null);

  useEffect(() => {
    const token = getToken();
    if (!token) return;
    api<{ team_id: number | string }>("/api/auth/me", { token })
      .then((m) => setMyId(String(m.team_id)))
      .catch(() => {});
  }, []);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api<{ frozen: boolean; teams: Row[] }>("/api/market/leaderboard")
        .then((d) => {
          if (!alive) return;
          setFrozen(d.frozen);
          setRows(d.teams);
        })
        .catch(() => {});
    void load();
    const unsub = poller.register(`leaderboard:table:${variant}`, load, compact ? 5000 : 3000);
    return () => {
      alive = false;
      unsub();
    };
  }, [compact, variant]);

  const shown = compact ? rows.slice(0, 5) : rows;
  const th = "px-3 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-dim";

  const table = (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[460px]">
        <thead>
          <tr className="border-b border-line bg-panel2/50">
            <th className={`${th} w-14 text-left`}>Rank</th>
            <th className={`${th} text-left`}>Team</th>
            <th className={`${th} text-right`}>Portfolio</th>
            <th className={`${th} text-right`}>PnL</th>
            <th className={`${th} text-right`}>Return</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => {
            const rank = Number(r.rank);
            const v = Number(r.total_portfolio_value);
            const pnl = v - capital;
            const mine = myId != null && String(r.team_id) === myId;
            const medal = MEDAL[rank];
            return (
              <tr
                key={r.team_id}
                className={`border-b border-line/50 last:border-0 ${mine ? "bg-acc/10" : ""}`}
                style={medal ? { boxShadow: `inset 3px 0 0 ${medal}` } : mine ? { boxShadow: "inset 3px 0 0 #2dd4bf" } : undefined}
              >
                <td className="px-3 py-3">
                  <RankMark rank={rank} />
                </td>
                <td className="px-3 py-3">
                  <span className="font-semibold text-ink">{r.team_name}</span>
                  {mine && (
                    <span className="ml-2 align-middle">
                      <Pill>you</Pill>
                    </span>
                  )}
                </td>
                <td className="num whitespace-nowrap px-3 py-3 text-right text-[13px] font-semibold text-ink">
                  {fmtInr(v)}
                </td>
                <td className={`num whitespace-nowrap px-3 py-3 text-right text-[13px] ${toneClass(pnl)}`}>
                  {fmtSignedInr(pnl)}
                </td>
                <td className={`num whitespace-nowrap px-3 py-3 text-right text-[13px] font-semibold ${toneClass(pnl)}`}>
                  {fmtSignedPct((pnl / capital) * 100)}
                </td>
              </tr>
            );
          })}
          {rows.length === 0 && (
            <tr>
              <td colSpan={5} className="px-4 py-10 text-center text-sm text-dim">
                No teams registered yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );

  const frozenNote = frozen && (
    <div className="border-b border-gold/20 bg-gold/10 px-4 py-2 text-[12px] text-gold">
      Rankings frozen at blackout. Standings no longer change.
    </div>
  );

  if (variant === "embedded") {
    return (
      <div>
        {frozenNote}
        {table}
        {rows.length > 0 && (
          <Link
            href="/leaderboard"
            className="block border-t border-line px-4 py-2.5 text-center text-[12px] text-acc hover:bg-panel2/60"
          >
            Open full leaderboard →
          </Link>
        )}
      </div>
    );
  }

  const top3 = rows.slice(0, 3);

  return (
    <div className="space-y-4">
      {variant === "full" && top3.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-3">
          {top3.map((r) => {
            const rank = Number(r.rank);
            const v = Number(r.total_portfolio_value);
            const pnl = v - capital;
            const c = MEDAL[rank];
            const mine = myId != null && String(r.team_id) === myId;
            return (
              <div
                key={r.team_id}
                className="border bg-panel p-4"
                style={{ borderColor: `${c}66`, background: `linear-gradient(135deg, ${c}1f, transparent 65%)` }}
              >
                <div className="flex items-center gap-3">
                  <RankMark rank={rank} />
                  <div className="min-w-0 flex-1 truncate font-semibold text-ink">{r.team_name}</div>
                  {mine && <Pill>you</Pill>}
                </div>
                <div className="num mt-3 text-xl font-bold text-ink">{fmtInr(v)}</div>
                <div className={`num mt-0.5 text-[12px] ${toneClass(pnl)}`}>
                  {fmtSignedInr(pnl)} · {fmtSignedPct((pnl / capital) * 100)}
                </div>
              </div>
            );
          })}
        </div>
      )}
      <PPanel
        title="Rankings"
        right={<Pill color={frozen ? "#f0b90b" : "#26a69a"}>{frozen ? "frozen" : "live"}</Pill>}
        pad={false}
      >
        {frozenNote}
        {table}
        {compact && rows.length > 5 && (
          <Link
            href="/leaderboard"
            className="block border-t border-line px-4 py-2 text-center text-[11px] text-acc hover:bg-panel2/60 hover:underline"
          >
            +{rows.length - 5} more, see full board →
          </Link>
        )}
      </PPanel>
    </div>
  );
}
