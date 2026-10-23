"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  api,
  fmtInr,
  getActive,
  getAccounts,
  logoutActive,
  removeAccount,
  switchAccount,
  type Account,
} from "@/lib/api";
import { useStatus } from "@/lib/useStatus";
import { poller } from "@/lib/poller";
import { Badge } from "./ui";

interface Me {
  team_id: number;
  team_name: string;
  role: "team" | "admin" | "evaluator";
  email: string;
}

interface BoardRow {
  total_portfolio_value: string;
}

interface Wallet {
  cash_balance: string;
}

type Role = "team" | "admin" | "evaluator";

interface NavItem {
  href: string;
  label: string;
  icon: string;
  roles?: readonly Role[];
}

const NAV: NavItem[] = [
  { href: "/dashboard", label: "Trading Desk", icon: "◧", roles: ["team"] },
  { href: "/admin", label: "Admin Console", icon: "✦", roles: ["admin"] },
  { href: "/manage-teams", label: "Manage Teams", icon: "⛃", roles: ["admin"] },
  { href: "/evaluator", label: "Judge Desk", icon: "⚖", roles: ["evaluator"] },
  { href: "/leaderboard", label: "Leaderboard", icon: "≣" },
  { href: "/docs", label: "Documentation", icon: "▤" },
  { href: "/api", label: "API Keys", icon: "⌥", roles: ["team"] },
  { href: "/allocations", label: "API Allocations", icon: "⛁", roles: ["admin", "evaluator"] },
  { href: "/allocations", label: "Team Details", icon: "⛁", roles: ["team"] },
];

export function TerminalShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [aggregate, setAggregate] = useState<{ teams: number; funds: number } | null>(null);
  const [wallet, setWallet] = useState<number | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const accounts: Account[] = getAccounts();
  const [now, setNow] = useState<Date | null>(null);
  const status = useStatus();

  useEffect(() => {
    const requiredRole =
      pathname.startsWith("/admin") || pathname.startsWith("/manage-teams")
        ? "admin"
        : pathname.startsWith("/evaluator")
          ? "evaluator"
          : undefined;
    const acct = getActive(requiredRole);
    if (!acct) {
      setMe(null);
      return;
    }
    if (typeof window !== "undefined" && window.sessionStorage) {
      window.sessionStorage.setItem("mercatus_active_tab", String(acct.team_id));
    }
    let cancelled = false;
    api<Me>("/api/auth/me", { token: acct.token })
      .then((m) => {
        if (!cancelled) setMe(m);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const status = (err as { status?: number })?.status;
        // Only drop the session on a genuine 401 (invalid / expired token).
        // 403 FORBIDDEN (lacking permission for specific route) must NOT delete
        // the account or trigger logout.
        if (status === 401) {
          removeAccount(acct.team_id);
          const rest = getAccounts();
          if (rest.length) {
            switchAccount(rest[rest.length - 1].team_id);
            window.location.reload();
          } else {
            setMe(null);
          }
        }
      });
    return () => {
      cancelled = true;
    };
  }, [pathname]);

  useEffect(() => {
    if (!me || me.role !== "team") {
      setWallet(null);
      return;
    }
    const token = getActive()?.token ?? null;
    if (!token) return;
    let alive = true;
    const load = () =>
      api<Wallet>("/api/team/portfolio", { token })
        .then((p) => alive && setWallet(Number(p.cash_balance)))
        .catch(() => {});
    void load();
    const unsub = poller.register("shell:wallet", load, 5000);
    return () => {
      alive = false;
      unsub();
    };
  }, [me]);

  useEffect(() => {
    const tick = () => setNow(new Date());
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api<{ teams: BoardRow[] }>("/api/market/leaderboard")
        .then((d) => {
          if (!alive) return;
          const rows = d.teams ?? [];
          setAggregate({
            teams: rows.length,
            funds: rows.reduce((s, r) => s + Number(r.total_portfolio_value), 0),
          });
        })
        .catch(() => {});
    void load();
    const unsub = poller.register("shell:leaderboard", load, 10000);
    return () => {
      alive = false;
      unsub();
    };
  }, []);

  const visible = NAV.filter((n) => {
    if (n.roles) return me ? n.roles.includes(me.role) : false;
    return !!me;
  });

  const isActive = (href: string) => pathname.startsWith(href);

  const stateColor =
    status?.state === "ACTIVE_MARKET"
      ? "#2ecc71"
      : status?.state === "API_FROZEN"
        ? "#f0b90b"
        : status?.state === "EVENT_CONCLUDED"
          ? "#f0514c"
          : "#55657a";

  const stateLabel =
    status?.state === "ACTIVE_MARKET"
      ? "Market open"
      : status?.state === "API_FROZEN"
        ? "API frozen"
        : status?.state === "EVENT_CONCLUDED"
          ? "Concluded"
          : "Pre-launch";

  const clock = now?.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const elapsed =
    status?.eventStartedAt && status.state !== "PRE_LAUNCH"
      ? Math.max(0, Math.floor((Date.now() - new Date(status.eventStartedAt).getTime()) / 1000))
      : null;
  const elapsedStr =
    elapsed != null
      ? `T+ ${String(Math.floor(elapsed / 60)).padStart(2, "0")}:${String(elapsed % 60).padStart(2, "0")}`
      : "T− " + (status?.scheduledEndAt ? "pre-launch" : "—");

  return (
    <div className="flex min-h-screen flex-col bg-bg">
      {/* Top navbar */}
      <header className="flex h-14 shrink-0 items-center gap-4 border-b border-line bg-panel px-4">
        <Link href="/dashboard" className="flex items-center gap-2.5">
          <span className="grid h-7 w-7 place-items-center bg-acc font-mono text-[13px] font-black text-bg">
            M
          </span>
          <div className="leading-tight">
            <div className="font-display text-[14px] font-bold tracking-tight text-ink">
              MERCATUS<span className="text-acc">.ARENA</span>
            </div>
          </div>
        </Link>

        <div className="ml-auto flex items-center gap-3">
          {/* Event time */}
          <div className="hidden items-center gap-3 border border-line bg-panel2 px-3 py-1.5 lg:flex">
            <span className="num text-[12px] font-semibold text-ink">{clock ?? "--:--:--"}</span>
            <span className="text-[10px] uppercase tracking-wider text-dim">{elapsedStr}</span>
            <span className="h-3 w-px bg-line2" />
            <span className="num text-[11px] text-muted">tick {status?.tickCount ?? "—"}</span>
          </div>

          {/* Admin / evaluator aggregates */}
          {me && me.role !== "team" && (
            <div className="hidden items-center gap-3 xl:flex">
              <div className="border border-line bg-panel2 px-3 py-1.5">
                <div className="text-[9px] uppercase tracking-wider text-dim">Total Teams</div>
                <div className="num text-[12px] font-bold text-ink">{aggregate?.teams ?? "—"}</div>
              </div>
              <div className="border border-line bg-panel2 px-3 py-1.5">
                <div className="text-[9px] uppercase tracking-wider text-dim">Market Volume</div>
                <div className="num text-[12px] font-bold text-buy">{fmtInr(aggregate?.funds ?? 0, 0)}</div>
              </div>
            </div>
          )}

          {/* Student wallet */}
          {me && me.role === "team" && (
            <div className="hidden items-center gap-2 border border-line bg-panel2 px-3 py-1.5 md:flex">
              <div className="text-[9px] uppercase tracking-wider text-dim">Available Funds</div>
              <div className="num text-[12px] font-bold text-buy">{fmtInr(wallet ?? 0, 0)}</div>
            </div>
          )}

          <div className="hidden items-center gap-2 border border-line bg-panel2 px-3 py-1.5 md:flex">
            <span
              className={`h-1.5 w-1.5 ${status?.state === "ACTIVE_MARKET" ? "live-dot bg-buy" : ""}`}
              style={{ backgroundColor: stateColor }}
            />
            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
              {stateLabel}
            </span>
          </div>

          {me ? (
            <div className="flex items-center gap-3">
              <Badge
                color={
                  me.role === "admin"
                    ? "#f0514c"
                    : me.role === "evaluator"
                      ? "#f0b90b"
                      : "#2dd4bf"
                }
              >
                {me.role}
              </Badge>
              <div className="relative">
                <button
                  onClick={() => setProfileOpen((o) => !o)}
                  className="flex items-center gap-2 border border-line bg-panel2 px-3 py-1.5 text-[12px] text-ink transition-colors hover:border-line2"
                >
                  <span className="grid h-5 w-5 place-items-center bg-acc font-mono text-[10px] font-black text-bg">
                    {(me.team_name[0] ?? "?").toUpperCase()}
                  </span>
                  <span className="hidden max-w-[120px] truncate sm:block">{me.team_name}</span>
                  <span className="text-[10px] text-dim">▾</span>
                </button>
                {profileOpen && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setProfileOpen(false)} />
                    <div className="absolute right-0 z-50 mt-2 w-72 max-h-[80vh] overflow-y-auto border border-line bg-panel shadow-xl">
                      <div className="border-b border-line px-4 py-3">
                        <div className="truncate text-[13px] font-semibold text-ink">{me.team_name}</div>
                        <div className="truncate text-[11px] text-dim">{me.email}</div>
                      </div>

                      {accounts.length > 1 && (
                        <div className="border-b border-line py-1">
                          <div className="px-4 py-1.5 text-[9px] uppercase tracking-wider text-dim">
                            Switch account
                          </div>
                          {accounts.map((a) => (
                            <button
                              key={a.team_id}
                              onClick={() => {
                                switchAccount(a.team_id);
                                setProfileOpen(false);
                                window.location.reload();
                              }}
                              className={`flex w-full items-center gap-2 px-4 py-2 text-left text-[12px] transition-colors hover:bg-panel2 ${
                                a.team_id === me.team_id ? "text-acc" : "text-ink"
                              }`}
                            >
                              <span
                                className="h-1.5 w-1.5 rounded-full"
                                style={{ backgroundColor: a.team_id === me.team_id ? "#2dd4bf" : "#55657a" }}
                              />
                              <span className="truncate">{a.team_name}</span>
                              <span className="ml-auto text-[10px] text-dim">{a.role}</span>
                            </button>
                          ))}
                        </div>
                      )}

                      <button
                        onClick={() => {
                          setProfileOpen(false);
                          window.location.href = "/login";
                        }}
                        className="block w-full px-4 py-2.5 text-left text-[12px] text-muted transition-colors hover:bg-panel2"
                      >
                        + Add another account
                      </button>
                      <button
                        onClick={() => {
                          logoutActive();
                          setProfileOpen(false);
                          window.location.reload();
                        }}
                        className="block w-full px-4 py-2.5 text-left text-[12px] text-sell transition-colors hover:bg-panel2"
                      >
                        Sign out ({me.team_name})
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          ) : (
            <div className="flex gap-2">
              <Link
                href="/login"
                className="border border-line bg-panel2 px-4 py-1.5 text-[12px] text-muted transition-colors hover:border-line2 hover:text-ink"
              >
                Sign in
              </Link>
              <Link
                href="/register"
                className="bg-acc px-4 py-1.5 text-[12px] font-semibold text-bg transition-all hover:brightness-110"
              >
                Register
              </Link>
            </div>
          )}
        </div>
      </header>

      <div className="flex min-w-0 flex-1">
        {/* Left sidebar */}
        <aside className="w-[316px] shrink-0 border-r border-line bg-panel/60">
          <nav className="space-y-0.5 p-3 pb-6">
            {visible.map((n) => (
              <Link
                key={`${n.href}-${n.label}`}
                href={n.href}
                className={`flex items-center gap-3 px-4 py-2.5 text-[13px] font-medium transition-colors ${
                  isActive(n.href)
                    ? "border-l-2 border-acc bg-panel2 text-ink"
                    : "border-l-2 border-transparent text-muted hover:bg-panel2/50 hover:text-ink"
                }`}
              >
                <span className="w-4 text-center text-muted">{n.icon}</span>
                {n.label}
                {isActive(n.href) && <span className="ml-auto h-1.5 w-1.5 bg-acc" />}
              </Link>
            ))}
          </nav>
        </aside>

        {/* Main content */}
        <div className="flex min-w-0 flex-1 flex-col">
          <main className="flex-1 px-6 py-5">{children}</main>
          <footer className="border-t border-line py-3 text-center text-[10px] uppercase tracking-widest text-dim">
            Mercatus Arena · TechVerse 2026 · real-time evaluation terminal
          </footer>
        </div>
      </div>
    </div>
  );
}
