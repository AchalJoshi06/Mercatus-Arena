"use client";

import { useEffect, useState } from "react";
import { api, getToken, setToken as persistToken, fmt, fmtInr } from "@/lib/api";
import { useStatus } from "@/lib/useStatus";
import { Badge, Button, ConfirmDialog, Input, Kpi, PageHeader, Panel, Select, Tabs, TableWrap, Td, Th } from "./ui";
import { MarketChartCard } from "./MarketChartCard";
import { CandlesChart } from "./CandlesChart";
import { LeaderboardTable } from "./LeaderboardTable";

interface Metrics {
  latency: {
    requests: string;
    avg_latency_ms: string;
    p95_ms: number | null;
    p99_ms: number | null;
    errors: string;
  };
  fills: {
    team_id: number;
    filled: string;
    rejected: string;
    insufficient_funds: string;
    avg_trade_ms: string | null;
  }[];
  teams: {
    team_id: number;
    team_name: string;
    email: string;
    is_frozen: boolean;
    cash_balance: string;
    total_portfolio_value: string;
    api_key: string | null;
    role: string;
  }[];
  live: { symbol: string; price: string; prev_price: string }[];
}

interface CreatedUser {
  team_id: string;
  team_name: string;
  role: string;
  email: string;
  api_key: string | null;
}

function NumericStepper({
  value,
  min,
  max,
  step,
  onCommit,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onCommit: (n: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const n = Number(draft);
    if (Number.isFinite(n)) onCommit(Math.min(max, Math.max(min, n)));
    else setDraft(String(value));
  };
  return (
    <input
      type="number"
      min={min}
      max={max}
      step={step}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
      }}
      className="w-[68px] shrink-0 border border-line bg-panel2 px-1.5 py-1 text-right text-[12px] num text-ink focus:border-acc/40 focus:outline-none"
    />
  );
}

function fmtCompactInr(n: number) {
  if (n >= 1e7) return `₹${(n / 1e7).toLocaleString("en-IN", { maximumFractionDigits: n >= 1e10 ? 0 : 2 })} Cr`;
  if (n >= 1e5) return `₹${(n / 1e5).toFixed(2)} L`;
  return fmtInr(n, 0);
}

function mmss(sec: number) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(r).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function ParamRow({
  label,
  display,
  unit,
  min,
  max,
  step,
  value,
  onChange,
  onApply,
  applyLabel = "Apply",
  hint,
  tone = "acc",
}: {
  label: string;
  display: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (n: number) => void;
  onApply?: () => void;
  applyLabel?: string;
  hint?: string;
  tone?: "acc" | "sell";
}) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-[11px]">
        <span className="font-medium uppercase tracking-wider text-muted">{label}</span>
        <span className={`num font-semibold ${tone === "sell" ? "text-sell" : "text-ink"}`}>{display}</span>
      </div>
      <div className="flex items-center gap-2">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className={`min-w-0 flex-1 ${tone === "sell" ? "accent-[#ef5350]" : "accent-[#2dd4bf]"}`}
        />
        <NumericStepper value={value} min={min} max={max} step={step} onCommit={onChange} />
        <span className="w-3 shrink-0 text-[11px] text-dim">{unit}</span>
        {onApply && (
          <Button size="sm" variant="accent" onClick={onApply} className="shrink-0">
            {applyLabel}
          </Button>
        )}
      </div>
      {hint && <p className="mt-1 text-[10px] leading-snug text-dim">{hint}</p>}
    </div>
  );
}

export function AdminConsole() {
  const [token, setToken] = useState<string | null>(null);
  const [login, setLogin] = useState({ email: "", password: "" });
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [user, setUser] = useState({
    role: "team",
    team_name: "",
    email: "",
    password: "",
    starting_capital: "100000",
  });
  const [created, setCreated] = useState<CreatedUser[]>([]);
  const [cfg, setCfg] = useState({
    volatility: 1,
    replaySpeed: 1,
    shock: -0.05,
    flashSymbols: "",
    decay: 0.9,
    circuitPct: 10,
  });
  const [score, setScore] = useState({ team_id: "", code: "", report: "" });
  const [chartMode, setChartMode] = useState<"line" | "candles">("candles");
  const [activeSym, setActiveSym] = useState<string>("");
  const [liveStartMs, setLiveStartMs] = useState("");
  const status = useStatus();
  const [tab, setTab] = useState<"teams" | "prices" | "accounts" | "dataset" | "judge">("teams");
  const [confirm, setConfirm] = useState<null | {
    title: string;
    message: string;
    label: string;
    action: () => void;
  }>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  // metrics refresh so KPIs stay live
  useEffect(() => {
    if (!token) return;
    const t = setInterval(() => void refresh(), 10000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  useEffect(() => setToken(getToken("admin")), []);
  useEffect(() => {
    if (token) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  async function refresh() {
    if (!token) return;
    try {
      const m = await api<Metrics>("/api/admin/metrics", { token });
      setMetrics(m);
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  async function admin(action: string, body: Record<string, unknown> = {}) {
    if (!token) return;
    try {
      const r = await api<{ ok?: boolean; error?: string }>(action, {
        method: "POST",
        body,
        token,
      });
      setMsg(`${action} → ${r.ok ? "ok" : r.error}`);
      await refresh();
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  async function doLogin() {
    try {
      const r = await api<{ token: string }>("/api/auth/login", {
        method: "POST",
        body: login,
      });
      setToken(r.token);
      persistToken(r.token);
      setMsg("logged in");
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  async function createUser() {
    if (!token) return;
    try {
      const r = await api<{ user: CreatedUser; api_key: string | null }>(
        "/api/admin/users",
        {
          method: "POST",
          token,
          body: {
            role: user.role,
            team_name: user.team_name,
            email: user.email,
            password: user.password,
            ...(user.role === "team" && user.starting_capital
              ? { starting_capital: Number(user.starting_capital) }
              : {}),
          },
        },
      );
      setCreated((c) => [r.user, ...c].slice(0, 20));
      setMsg(`Created ${r.user.role} account — key ${r.api_key ?? "none"}`);
      setUser((u) => ({ ...u, team_name: "", email: "", password: "" }));
    } catch (e) {
      setMsg(`Create failed: ${(e as Error).message}`);
    }
  }

  async function uploadDataset(file: File) {
    if (!token) return;
    const form = new FormData();
    form.append("file", file);
    if (liveStartMs.trim()) form.append("live_start_ms", liveStartMs.trim());
    try {
      const r = await api<{ ok: boolean; rows: number }>("/api/admin/dataset", {
        method: "POST",
        form,
        token,
      });
      setMsg(`dataset uploaded: ${r.rows} rows`);
      await refresh();
    } catch (e) {
      setMsg(`dataset failed: ${(e as Error).message}`);
    }
  }

  async function generateSynthetic() {
    await admin("/api/admin/dataset/synthetic", {
      duration_minutes: 180,
      symbols: ["AAPL", "MSFT", "GOOG", "TSLA", "NVDA"],
    });
  }

  if (!token) {
    return (
      <div className="mx-auto max-w-sm">
        <Panel title="Admin sign in" className="p-0">
          <div className="space-y-4 p-5">
            <Input
              label="Email"
              value={login.email}
              onChange={(e) => setLogin({ ...login, email: e.target.value })}
            />
            <Input
              label="Password"
              type="password"
              value={login.password}
              onChange={(e) => setLogin({ ...login, password: e.target.value })}
            />
            {msg && <div className="text-sm text-sell">{msg}</div>}
            <Button onClick={doLogin} className="w-full">
              Sign in
            </Button>
          </div>
        </Panel>
      </div>
    );
  }

  const syms = status?.symbols?.length ? status.symbols : (metrics?.live ?? []).map((l) => l.symbol);
  const initPx = Object.fromEntries((metrics?.live ?? []).map((l) => [l.symbol, Number(l.price)]));
  const state = status?.state ?? "PRE_LAUNCH";
  const live = state === "ACTIVE_MARKET";
  const stateTone = live ? "#26a69a" : state === "EVENT_CONCLUDED" ? "#ef5350" : state === "API_FROZEN" ? "#f0b90b" : "#55657a";
  const elapsed =
    status?.eventStartedAt && state !== "PRE_LAUNCH"
      ? Math.max(0, (now - new Date(status.eventStartedAt).getTime()) / 1000)
      : null;
  const remaining = status?.scheduledEndAt
    ? Math.max(0, (new Date(status.scheduledEndAt).getTime() - now) / 1000)
    : null;
  const errors = metrics ? Number(metrics.latency.errors) : null;
  const p95 = metrics?.latency.p95_ms;
  const ctl = (action: string) => admin("/api/admin/control", { action });

  return (
    <div className="space-y-4">
      <PageHeader title="Admin Console" badge={<Badge color="#f0514c">admin</Badge>}>
        <div className="flex items-center gap-px border border-line bg-panel">
          {(["line", "candles"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setChartMode(m)}
              className={`px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-wider transition-colors ${
                m === chartMode ? "bg-acc/15 text-acc" : "text-muted hover:text-ink"
              }`}
            >
              {m}
            </button>
          ))}
        </div>
        <Button variant="ghost" size="sm" onClick={refresh}>
          Refresh
        </Button>
      </PageHeader>

      {msg && (
        <div className="num flex items-start justify-between gap-3 border border-line bg-panel px-3 py-2 text-[12px] text-muted">
          <span className="min-w-0 break-words">{msg}</span>
          <button onClick={() => setMsg(null)} className="shrink-0 text-dim hover:text-ink" aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}

      {/* KPI strip */}
      <div className="grid grid-cols-2 gap-px border border-line bg-line sm:grid-cols-4 xl:grid-cols-8">
        <Kpi label="State" value={state === "ACTIVE_MARKET" ? "ACTIVE" : state === "EVENT_CONCLUDED" ? "CONCLUDED" : state.replace("_", " ")} dot={stateTone} />
        <Kpi label="Elapsed" value={elapsed != null ? mmss(elapsed) : "—"} />
        <Kpi label="Remaining" value={remaining != null ? mmss(remaining) : "—"} />
        <Kpi label="Teams" value={metrics ? metrics.teams.filter((t) => t.role === "team").length : "—"} />
        <Kpi label="Turnover" value={status?.turnover != null ? fmtCompactInr(status.turnover) : "—"} tone="up" />
        <Kpi label="Tick" value={status?.tickCount ?? "—"} />
        <Kpi label="p95 latency" value={p95 != null ? `${p95.toFixed(1)} ms` : "—"} />
        <Kpi
          label="Errors"
          value={errors ?? "—"}
          tone={errors == null ? "neutral" : errors > 0 ? "down" : "up"}
        />
      </div>

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 space-y-4 lg:col-start-1 lg:row-start-1">
          {!syms.length ? (
            <div className="flex min-h-[320px] items-center justify-center border border-line bg-panel text-sm text-dim">
              Loading market data…
            </div>
          ) : chartMode === "candles" ? (
            <CandlesChart
              key={syms.join(",")}
              symbols={syms}
              initialPrices={initPx}
              state={state}
              active={activeSym || (syms[0] ?? "")}
              onActiveChange={setActiveSym}
            />
          ) : (
            <MarketChartCard
              symbols={syms}
              initialPrices={initPx}
              state={state}
              title="Market Simulation"
              loadHistory
              onActiveChange={setActiveSym}
            />
          )}
          <div className="overflow-x-auto">
            <LeaderboardTable />
          </div>
        </div>

        <Panel title="Market controls" pad={false} className="min-w-0 lg:col-start-2 lg:row-span-2 lg:row-start-1">
          <div className="space-y-4 p-4">
            {/* Run state */}
            <div className="space-y-2">
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-dim">
                <span>
                  Board <b className="num font-semibold text-muted">{status?.leaderboardFrozen ? "frozen" : "live"}</b>
                </span>
                <span>
                  API keys <b className="num font-semibold text-muted">{status?.credentialsRevealed ? "revealed" : "hidden"}</b>
                </span>
                <span>
                  Paused <b className="num font-semibold text-muted">{status?.paused ? "yes" : "no"}</b>
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  size="lg"
                  variant={live ? "ghost" : "primary"}
                  disabled={live}
                  onClick={() =>
                    setConfirm({
                      title: "Start a new event?",
                      message:
                        "This resets every team's cash, positions and order history and restarts the market clock.",
                      label: "Start event",
                      action: () => ctl("start"),
                    })
                  }
                >
                  ▶ Start
                </Button>
                <Button
                  size="lg"
                  variant={live ? "primary" : "ghost"}
                  disabled={!live}
                  onClick={() => ctl(status?.paused ? "resume" : "pause")}
                >
                  {status?.paused ? "▶ Resume" : "❚❚ Pause"}
                </Button>
              </div>
            </div>

            {/* Simulation */}
            <div className="space-y-3 border-t border-line pt-4">
              <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-dim">Simulation</div>
              <ParamRow
                label="Volatility"
                display={`×${cfg.volatility}`}
                unit="×"
                min={0.1}
                max={20}
                step={0.1}
                value={cfg.volatility}
                onChange={(n) => setCfg({ ...cfg, volatility: n })}
                onApply={() => admin("/api/admin/volatility", { multiplier: cfg.volatility })}
              />
              <ParamRow
                label="Replay speed"
                display={`×${cfg.replaySpeed}`}
                unit="×"
                min={0.1}
                max={20}
                step={0.1}
                value={cfg.replaySpeed}
                onChange={(n) => setCfg({ ...cfg, replaySpeed: n })}
                onApply={() => admin("/api/admin/config", { replay_speed: cfg.replaySpeed })}
              />
              <ParamRow
                label="Circuit band"
                display={`±${cfg.circuitPct.toFixed(1)}%`}
                unit="%"
                min={1}
                max={30}
                step={0.5}
                value={cfg.circuitPct}
                onChange={(n) => setCfg({ ...cfg, circuitPct: n })}
                onApply={() => admin("/api/admin/config", { circuit_pct: cfg.circuitPct / 100 })}
                hint="Price lock vs day open (per-symbol tiers ½×, 1×, 2×)."
              />
            </div>

            {/* Flash crash */}
            <div className="space-y-3 border-t border-line pt-4">
              <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-dim">Flash crash</div>
              <ParamRow
                label="Shock"
                display={`${(cfg.shock * 100).toFixed(0)}%`}
                unit="%"
                min={-0.1}
                max={0.1}
                step={0.01}
                value={cfg.shock}
                onChange={(n) => setCfg({ ...cfg, shock: n })}
                tone="sell"
              />
              <ParamRow
                label="Recovery decay"
                display={`×${cfg.decay.toFixed(2)}/tick`}
                unit="×"
                min={0.5}
                max={0.99}
                step={0.01}
                value={cfg.decay}
                onChange={(n) => setCfg({ ...cfg, decay: n })}
                tone="sell"
                hint="Higher = slower recovery (0.9 ≈ −10% back to −2% in ~15 ticks)."
              />
              <input
                type="text"
                placeholder="Symbols, comma separated (blank = all)"
                value={cfg.flashSymbols}
                onChange={(e) => setCfg({ ...cfg, flashSymbols: e.target.value })}
                className="w-full border border-line bg-panel2 px-2.5 py-1.5 text-[12px] text-ink placeholder:text-dim focus:border-acc/40 focus:outline-none"
              />
              <Button
                size="sm"
                variant="danger"
                className="w-full"
                onClick={() =>
                  admin("/api/admin/flash-crash", {
                    shock: cfg.shock,
                    decay: cfg.decay,
                    symbols: cfg.flashSymbols
                      .split(",")
                      .map((s) => s.trim())
                      .filter(Boolean),
                  })
                }
              >
                Trigger flash crash
              </Button>
            </div>

            {/* Event controls */}
            <div className="space-y-2 border-t border-line pt-4">
              <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-dim">Event</div>
              <div className="grid grid-cols-2 gap-2">
                <Button size="sm" variant="ghost" onClick={() => ctl("freeze_leaderboard")}>
                  Freeze board
                </Button>
                <Button size="sm" variant="ghost" onClick={() => ctl("unfreeze_leaderboard")}>
                  Unfreeze board
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    setConfirm({
                      title: "Reveal API keys",
                      message: "Reveal every team's API key to the participants? Teams will be able to see and use their keys immediately.",
                      label: "Reveal keys",
                      action: () => ctl("reveal_credentials"),
                    })
                  }
                >
                  Reveal API keys
                </Button>
                <Button size="sm" variant="ghost" onClick={() => ctl("hide_credentials")}>
                  Hide API keys
                </Button>
              </div>
            </div>

            {/* Danger zone */}
            <div className="border border-sell/35 bg-sell/5 p-3">
              <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-sell">Danger zone</div>
              <Button
                size="sm"
                variant="danger"
                className="w-full"
                onClick={() =>
                  setConfirm({
                    title: "Conclude event",
                    message: "Conclude the event now? Trading stops for everyone and the final standings are locked. This cannot be undone.",
                    label: "Conclude event",
                    action: () => ctl("halt"),
                  })
                }
              >
                Conclude event
              </Button>
            </div>
          </div>
        </Panel>

      {/* Secondary sections */}
      <section className="min-w-0 overflow-hidden border border-line bg-panel lg:col-start-1 lg:row-start-2">
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { id: "teams", label: "Teams & fills", count: metrics?.teams.length },
            { id: "prices", label: "Live prices", count: metrics?.live.length },
            { id: "accounts", label: "Create accounts" },
            { id: "dataset", label: "Dataset" },
            { id: "judge", label: "Judge scoring" },
          ]}
        />

        {tab === "teams" && (
          <TableWrap>
            <table className="w-full">
              <thead>
                <tr className="border-b border-line bg-panel2/50">
                  <Th>Team</Th>
                  <Th right>Portfolio</Th>
                  <Th right>Filled</Th>
                  <Th right>Rejected</Th>
                  <Th right>Avg trade</Th>
                  <Th right>API key</Th>
                </tr>
              </thead>
              <tbody>
                {(metrics?.teams ?? []).map((t) => {
                  const f = metrics?.fills.find((x) => x.team_id === t.team_id);
                  return (
                    <tr key={t.team_id} className="border-b border-line/50 last:border-0">
                      <Td mono={false}>
                        <span className="font-medium text-ink">{t.team_name}</span>
                        <span className="ml-1.5 text-dim">{t.role}</span>
                        {t.is_frozen && (
                          <span className="ml-1.5">
                            <Badge color="#ef5350">frozen</Badge>
                          </span>
                        )}
                      </Td>
                      <Td right>{fmtInr(t.total_portfolio_value)}</Td>
                      <Td right>{f?.filled ?? "0"}</Td>
                      <Td right>{f?.rejected ?? "0"}</Td>
                      <Td right>{f?.avg_trade_ms != null ? `${f.avg_trade_ms}ms` : "—"}</Td>
                      <Td right>
                        <code className="text-[11px] text-buy">{t.api_key ?? "—"}</code>
                      </Td>
                    </tr>
                  );
                })}
                {!metrics?.teams.length && (
                  <tr>
                    <td colSpan={6} className="px-4 py-6 text-center text-sm text-dim">
                      No accounts yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </TableWrap>
        )}

        {tab === "prices" && (
          <div className="max-h-[360px] overflow-y-auto">
            <div className="grid grid-cols-1 gap-px bg-line sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
              {(metrics?.live ?? []).map((l) => {
                const px = Number(l.price);
                const pv = Number(l.prev_price);
                const chg = pv ? ((px - pv) / pv) * 100 : 0;
                return (
                  <div key={l.symbol} className="flex items-center justify-between gap-3 bg-panel px-3 py-1.5">
                    <span className="font-mono text-[12px] font-bold text-ink">{l.symbol}</span>
                    <span className="flex items-baseline gap-3">
                      <span className="num text-[12px] text-ink">{fmt(l.price)}</span>
                      <span
                        className={`num w-14 text-right text-[11px] ${chg > 0 ? "text-buy" : chg < 0 ? "text-sell" : "text-dim"}`}
                      >
                        {chg > 0 ? "+" : ""}
                        {chg.toFixed(2)}%
                      </span>
                    </span>
                  </div>
                );
              })}
            </div>
            {!metrics?.live.length && <div className="px-4 py-6 text-center text-sm text-dim">No prices yet.</div>}
          </div>
        )}

        {tab === "accounts" && (
          <div className="grid gap-6 p-4 lg:grid-cols-2">
            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <Select label="Role" value={user.role} onChange={(e) => setUser({ ...user, role: e.target.value })}>
                  <option value="team">Student / Team</option>
                  <option value="evaluator">Evaluator (judge)</option>
                  <option value="admin">Admin</option>
                </Select>
                {user.role === "team" && (
                  <Input
                    label="Starting capital (₹)"
                    mono
                    value={user.starting_capital}
                    onChange={(e) => setUser({ ...user, starting_capital: e.target.value })}
                  />
                )}
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Input
                  label="Team / display name"
                  value={user.team_name}
                  onChange={(e) => setUser({ ...user, team_name: e.target.value })}
                />
                <Input
                  label="Email"
                  type="email"
                  value={user.email}
                  onChange={(e) => setUser({ ...user, email: e.target.value })}
                />
              </div>
              <Input
                label="Password (min 6 chars)"
                type="password"
                value={user.password}
                onChange={(e) => setUser({ ...user, password: e.target.value })}
              />
              <Button
                onClick={createUser}
                disabled={!user.team_name || !user.email || user.password.length < 6}
                className="w-full"
              >
                Create account
              </Button>
            </div>
            <div>
              <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-dim">
                Created this session
              </div>
              {created.length === 0 ? (
                <div className="border border-dashed border-line px-3 py-6 text-center text-[12px] text-dim">
                  Newly created accounts and their API keys appear here.
                </div>
              ) : (
                <div className="space-y-1">
                  {created.map((c, i) => (
                    <div
                      key={i}
                      className="flex items-center justify-between gap-2 border border-line bg-panel2/60 px-3 py-1.5 text-[12px]"
                    >
                      <span className="truncate text-ink">
                        {c.team_name} <span className="text-dim">· {c.role}</span>
                      </span>
                      {c.api_key ? (
                        <code className="num truncate text-buy">{c.api_key}</code>
                      ) : (
                        <Badge color="#55657a">no key</Badge>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {tab === "dataset" && (
          <div className="grid gap-3 p-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <label className="block text-sm">
              <span className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-dim">Upload CSV</span>
              <input
                type="file"
                accept=".csv,.txt"
                onChange={(e) => e.target.files?.[0] && uploadDataset(e.target.files[0])}
                className="w-full border border-line bg-panel2 px-2 py-1.5 text-sm text-muted file:mr-3 file:border-0 file:bg-panel file:px-3 file:py-1 file:text-sm file:text-ink"
              />
            </label>
            <Input
              label="Live start (epoch ms, optional)"
              mono
              value={liveStartMs}
              onChange={(e) => setLiveStartMs(e.target.value)}
            />
            <Button variant="ghost" onClick={generateSynthetic}>
              Generate synthetic (180 min)
            </Button>
          </div>
        )}

        {tab === "judge" && (
          <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_auto] lg:items-end">
            <Input label="Team ID" mono value={score.team_id} onChange={(e) => setScore({ ...score, team_id: e.target.value })} />
            <Input label="Code quality (0–100)" mono value={score.code} onChange={(e) => setScore({ ...score, code: e.target.value })} />
            <Input label="Report (0–100)" mono value={score.report} onChange={(e) => setScore({ ...score, report: e.target.value })} />
            <div className="flex gap-2">
              <Button
                onClick={() =>
                  admin("/api/admin/scoring", {
                    team_id: Number(score.team_id),
                    code_quality: Number(score.code),
                    strategy_report: Number(score.report),
                  })
                }
              >
                Save
              </Button>
              <Button variant="accent" onClick={() => admin("/api/admin/scoring/compute", {})}>
                Compute
              </Button>
            </div>
          </div>
        )}
      </section>

      </div>

      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          message={confirm.message}
          confirmLabel={confirm.label}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            const a = confirm.action;
            setConfirm(null);
            a();
          }}
        />
      )}
    </div>
  );
}
