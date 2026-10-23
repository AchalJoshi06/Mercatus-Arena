"use client";

import { useEffect, useState } from "react";
import { api, getToken, setToken as persistToken, fmt, fmtInr } from "@/lib/api";
import { Badge, Button, ConfirmDialog, Input, Modal, PageHeader, Panel, Select, Td, Th } from "./ui";

interface TeamRow {
  team_id: number;
  team_name: string;
  role: string;
  email: string;
  is_frozen: boolean;
  cash_balance: string;
  total_portfolio_value: string;
  created_at: string;
  api_key: string | null;
}

interface AuditTrade {
  order_id: number;
  action: string;
  symbol: string;
  quantity: number;
  price_executed: string | null;
  price_requested: string | null;
  status: string;
  reason: string | null;
  latency_ms: number | null;
  fee: string;
}

interface AuditRequest {
  method: string;
  path: string;
  status: number;
  latency_ms: number | null;
  created_at: string;
}

interface AuditData {
  trades: AuditTrade[];
  requests: AuditRequest[];
}

interface CreatedUser {
  team_id: string;
  team_name: string;
  role: string;
  email: string;
}

export function ManageTeams() {
  const [token, setToken] = useState<string | null>(null);
  const [login, setLogin] = useState({ email: "", password: "" });
  const [teams, setTeams] = useState<TeamRow[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<TeamRow | null>(null);
  const [audit, setAudit] = useState<{ team: TeamRow; data: AuditData } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<TeamRow | null>(null);
  const [confirmReset, setConfirmReset] = useState<TeamRow | null>(null);
  const [q, setQ] = useState("");
  const [roleFilter, setRoleFilter] = useState("all");
  const [form, setForm] = useState({
    role: "team",
    team_name: "",
    email: "",
    password: "",
    starting_capital: "100000",
  });
  const [editForm, setEditForm] = useState({
    team_name: "",
    email: "",
    password: "",
    role: "team",
    cash_balance: "",
    is_frozen: false,
  });

  useEffect(() => setToken(getToken("admin")), []);
  useEffect(() => {
    if (token) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  async function refresh() {
    if (!token) return;
    try {
      const r = await api<{ teams: TeamRow[] }>("/api/admin/teams", { token });
      setTeams(r.teams);
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
    setBusy(true);
    try {
      await api<{ user: CreatedUser }>("/api/admin/users", {
        method: "POST",
        token,
        body: {
          role: form.role,
          team_name: form.team_name,
          email: form.email,
          password: form.password,
          ...(form.role === "team" && form.starting_capital
            ? { starting_capital: Number(form.starting_capital) }
            : {}),
        },
      });
      setMsg(`Created ${form.team_name}`);
      setForm((f) => ({ ...f, team_name: "", email: "", password: "" }));
      setShowAdd(false);
      await refresh();
    } catch (e) {
      setMsg(`Create failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  function openEdit(t: TeamRow) {
    setEditForm({
      team_name: t.team_name,
      email: t.email,
      password: "",
      role: t.role,
      cash_balance: String(t.cash_balance),
      is_frozen: t.is_frozen,
    });
    setEditing(t);
  }

  async function saveEdit() {
    if (!token || !editing) return;
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        team_name: editForm.team_name,
        email: editForm.email,
        role: editForm.role,
        is_frozen: editForm.is_frozen,
        cash_balance: Number(editForm.cash_balance),
      };
      if (editForm.password) body.password = editForm.password;
      await api<{ ok: boolean }>(`/api/admin/teams/${editing.team_id}`, {
        method: "PATCH",
        token,
        body,
      });
      setMsg(`Updated ${editing.team_name}`);
      setEditing(null);
      await refresh();
    } catch (e) {
      setMsg(`Update failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function freeze(t: TeamRow, frozen: boolean) {
    if (!token) return;
    try {
      await api<{ ok: boolean }>(`/api/admin/teams/${t.team_id}/freeze`, {
        method: "POST",
        token,
        body: { frozen },
      });
      setMsg(`${frozen ? "Froze" : "Unfroze"} ${t.team_name}`);
      await refresh();
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  async function resetTeam(t: TeamRow) {
    if (!token) return;
    try {
      await api<{ ok: boolean }>(`/api/admin/teams/${t.team_id}/reset`, {
        method: "POST",
        token,
      });
      setMsg(`Reset ${t.team_name} to start capital`);
      await refresh();
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  async function doDelete() {
    if (!token || !confirmDelete) return;
    setBusy(true);
    try {
      await api<{ ok: boolean; deleted: boolean }>(
        `/api/admin/teams/${confirmDelete.team_id}`,
        { method: "DELETE", token },
      );
      setMsg(`Deleted ${confirmDelete.team_name}`);
      setConfirmDelete(null);
      await refresh();
    } catch (e) {
      setMsg(`Delete failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function openAudit(t: TeamRow) {
    if (!token) return;
    try {
      const data = await api<AuditData>(`/api/admin/teams/${t.team_id}/audit`, {
        token,
      });
      setAudit({ team: t, data });
    } catch (e) {
      setMsg((e as Error).message);
    }
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

  const roleColor = (role: string) =>
    role === "admin" ? "#f0514c" : role === "evaluator" ? "#f0b90b" : "#2dd4bf";

  const needle = q.trim().toLowerCase();
  const shown = teams.filter(
    (t) =>
      (roleFilter === "all" || t.role === roleFilter) &&
      (!needle ||
        t.team_name.toLowerCase().includes(needle) ||
        t.email.toLowerCase().includes(needle) ||
        String(t.team_id) === needle),
  );

  const actions = (t: TeamRow) => (
    <div className="flex flex-wrap items-center justify-end gap-1">
      <Button size="sm" variant="accent" onClick={() => openEdit(t)} disabled={t.role === "admin"}>
        Edit
      </Button>
      <div className="flex items-center gap-px border border-line bg-line">
        <button
          onClick={() => freeze(t, !t.is_frozen)}
          className="bg-panel2 px-2 py-1.5 text-[11px] text-muted transition-colors hover:text-ink"
        >
          {t.is_frozen ? "Unfreeze" : "Freeze"}
        </button>
        <button
          onClick={() => openAudit(t)}
          className="bg-panel2 px-2 py-1.5 text-[11px] text-muted transition-colors hover:text-ink"
        >
          Audit
        </button>
        <button
          onClick={() => setConfirmReset(t)}
          className="bg-panel2 px-2 py-1.5 text-[11px] text-muted transition-colors hover:text-gold"
        >
          Reset
        </button>
        <button
          onClick={() => setConfirmDelete(t)}
          disabled={t.role === "admin"}
          className="bg-panel2 px-2 py-1.5 text-[11px] text-sell transition-colors hover:bg-sell/15 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Delete
        </button>
      </div>
    </div>
  );

  return (
    <div className="space-y-4">
      <PageHeader title="Manage Teams" badge={<Badge color="#f0514c">admin</Badge>}>
        <Button variant="ghost" size="sm" onClick={refresh}>
          Refresh
        </Button>
        <Button size="sm" onClick={() => setShowAdd((s) => !s)}>
          {showAdd ? "Close" : "+ Add team"}
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

      {showAdd && (
        <Panel title="Add account">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Select label="Role" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              <option value="team">Student / Team</option>
              <option value="evaluator">Evaluator (judge)</option>
            </Select>
            {form.role === "team" && (
              <Input
                label="Starting capital (₹)"
                mono
                value={form.starting_capital}
                onChange={(e) => setForm({ ...form, starting_capital: e.target.value })}
              />
            )}
            <Input
              label="Team / display name"
              value={form.team_name}
              onChange={(e) => setForm({ ...form, team_name: e.target.value })}
            />
            <Input
              label="Email"
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
            <Input
              label="Password (min 8 chars)"
              type="password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
            />
            <div className="flex items-end">
              <Button
                onClick={createUser}
                disabled={busy || !form.team_name || !form.email || form.password.length < 8}
                className="w-full"
              >
                Create account
              </Button>
            </div>
          </div>
        </Panel>
      )}

      <Panel
        title="Teams"
        right={
          <Badge color="#2dd4bf">
            {shown.length === teams.length ? `${teams.length} accounts` : `${shown.length} / ${teams.length}`}
          </Badge>
        }
        pad={false}
      >
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2.5">
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name, email or #id…"
            className="min-w-0 flex-1 basis-56 border border-line bg-panel2 px-3 py-1.5 text-[13px] text-ink outline-none placeholder:text-dim focus:border-acc/60"
          />
          <div className="flex items-center gap-px border border-line bg-panel">
            {(["all", "team", "evaluator", "admin"] as const).map((r) => (
              <button
                key={r}
                onClick={() => setRoleFilter(r)}
                className={`px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-wider transition-colors ${
                  roleFilter === r ? "bg-acc/15 text-acc" : "text-muted hover:text-ink"
                }`}
              >
                {r}
              </button>
            ))}
          </div>
        </div>

        {/* Desktop table */}
        <div className="hidden max-h-[calc(100vh-320px)] min-h-[200px] overflow-auto md:block">
          <table className="w-full">
            <thead className="sticky top-0 z-10">
              <tr className="border-b border-line bg-panel2">
                <Th>Team</Th>
                <Th>Email</Th>
                <Th right>Cash</Th>
                <Th right>Portfolio</Th>
                <Th right>Created</Th>
                <Th right>Actions</Th>
              </tr>
            </thead>
            <tbody>
              {shown.map((t) => (
                <tr key={t.team_id} className="border-b border-line/50 transition-colors last:border-0 hover:bg-panel2/40">
                  <Td mono={false}>
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-ink">{t.team_name}</span>
                      <Badge color={roleColor(t.role)}>{t.role}</Badge>
                      {t.is_frozen && <Badge color="#ef5350">frozen</Badge>}
                    </div>
                    <div className="num mt-0.5 text-[11px] text-dim">#{t.team_id}</div>
                  </Td>
                  <Td mono={false}>
                    <span className="text-[12px] text-muted">{t.email}</span>
                  </Td>
                  <Td right>{fmtInr(t.cash_balance)}</Td>
                  <Td right>{fmtInr(t.total_portfolio_value)}</Td>
                  <Td right muted>
                    {new Date(t.created_at).toLocaleDateString("en-IN", { day: "2-digit", month: "short" })}
                  </Td>
                  <Td right>{actions(t)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Mobile cards */}
        <div className="divide-y divide-line/60 md:hidden">
          {shown.map((t) => (
            <div key={t.team_id} className="space-y-2 px-3 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-ink">{t.team_name}</span>
                <Badge color={roleColor(t.role)}>{t.role}</Badge>
                {t.is_frozen && <Badge color="#ef5350">frozen</Badge>}
                <span className="num ml-auto text-[11px] text-dim">#{t.team_id}</span>
              </div>
              <div className="truncate text-[12px] text-muted">{t.email}</div>
              <div className="num flex justify-between text-[12px]">
                <span className="text-dim">
                  Cash <span className="text-ink">{fmtInr(t.cash_balance)}</span>
                </span>
                <span className="text-dim">
                  Portfolio <span className="text-ink">{fmtInr(t.total_portfolio_value)}</span>
                </span>
              </div>
              <div className="pt-1">{actions(t)}</div>
            </div>
          ))}
        </div>

        {shown.length === 0 && (
          <div className="px-4 py-8 text-center text-sm text-dim">
            {teams.length === 0 ? "No accounts yet." : "No accounts match your filter."}
          </div>
        )}
      </Panel>

      {editing && (
        <Modal title={`Edit — ${editing.team_name}`} onClose={() => setEditing(null)}>
          <div className="space-y-3">
            <Input
              label="Team name"
              value={editForm.team_name}
              onChange={(e) =>
                setEditForm({ ...editForm, team_name: e.target.value })
              }
            />
            <Input
              label="Email"
              type="email"
              value={editForm.email}
              onChange={(e) => setEditForm({ ...editForm, email: e.target.value })}
            />
            <Input
              label="New password (blank = keep current)"
              type="password"
              value={editForm.password}
              onChange={(e) =>
                setEditForm({ ...editForm, password: e.target.value })
              }
            />
            <div className="grid grid-cols-2 gap-3">
              <Select
                label="Role"
                value={editForm.role}
                onChange={(e) =>
                  setEditForm({ ...editForm, role: e.target.value })
                }
                disabled={editing.role === "admin"}
              >
                <option value="team">Student / Team</option>
                <option value="evaluator">Evaluator (judge)</option>
              </Select>
              <Input
                label="Cash balance (₹)"
                mono
                value={editForm.cash_balance}
                onChange={(e) =>
                  setEditForm({ ...editForm, cash_balance: e.target.value })
                }
              />
            </div>
            <label className="flex items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={editForm.is_frozen}
                onChange={(e) =>
                  setEditForm({ ...editForm, is_frozen: e.target.checked })
                }
                className="accent-[#f0514c]"
              />
              Frozen (blocked from trading)
            </label>
            <Button
              onClick={saveEdit}
              disabled={busy}
              className="w-full"
            >
              Save changes
            </Button>
            <p className="text-[11px] text-dim">
              Changing the password or cash balance revokes the team&apos;s
              existing sessions (they must sign in again).
            </p>
          </div>
        </Modal>
      )}

      {audit && (
        <Modal
          wide
          title={`Audit — ${audit.team.team_name} (last 50)`}
          onClose={() => setAudit(null)}
        >
          <div className="space-y-4">
            <div>
              <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-dim">
                Orders
              </div>
              <div className="max-h-48 overflow-y-auto rounded-lg border border-line bg-panel2/40">
                <table className="w-full text-[11px]">
                  <thead>
                    <tr className="border-b border-line text-left text-dim">
                      <th className="px-2 py-1.5">#</th>
                      <th className="px-2 py-1.5">Action</th>
                      <th className="px-2 py-1.5">Symbol</th>
                      <th className="px-2 py-1.5 text-right">Qty</th>
                      <th className="px-2 py-1.5 text-right">Price</th>
                      <th className="px-2 py-1.5 text-right">Fee</th>
                      <th className="px-2 py-1.5">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {audit.data.trades.slice(0, 50).map((tr) => (
                      <tr key={tr.order_id} className="border-b border-line/40 last:border-0">
                        <td className="px-2 py-1 text-dim">#{tr.order_id}</td>
                        <td
                          className={`px-2 py-1 font-semibold ${
                            tr.action === "BUY" ? "text-buy" : "text-sell"
                          }`}
                        >
                          {tr.action}
                        </td>
                        <td className="px-2 py-1 num text-ink">{tr.symbol}</td>
                        <td className="px-2 py-1 text-right num">{tr.quantity}</td>
                        <td className="px-2 py-1 text-right num">
                          {tr.price_executed ?? tr.price_requested ?? "—"}
                        </td>
                        <td className="px-2 py-1 text-right num">{tr.fee}</td>
                        <td className="px-2 py-1">
                          {tr.status === "SUCCESS" ? (
                            <Badge color="#2dd4bf">{tr.status}</Badge>
                          ) : (
                            <Badge color="#f0514c">{tr.reason ?? tr.status}</Badge>
                          )}
                        </td>
                      </tr>
                    ))}
                    {audit.data.trades.length === 0 && (
                      <tr>
                        <td colSpan={7} className="px-2 py-3 text-center text-dim">
                          No orders yet
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
            <div>
              <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-dim">
                API requests
              </div>
              <div className="max-h-40 overflow-y-auto rounded-lg border border-line bg-panel2/40">
                <table className="w-full text-[11px]">
                  <thead>
                    <tr className="border-b border-line text-left text-dim">
                      <th className="px-2 py-1.5">Method</th>
                      <th className="px-2 py-1.5">Path</th>
                      <th className="px-2 py-1.5 text-right">Status</th>
                      <th className="px-2 py-1.5 text-right">Latency</th>
                    </tr>
                  </thead>
                  <tbody>
                    {audit.data.requests.slice(0, 50).map((rq, i) => (
                      <tr key={i} className="border-b border-line/40 last:border-0">
                        <td className="px-2 py-1 font-mono text-muted">{rq.method}</td>
                        <td className="px-2 py-1 font-mono text-muted">{rq.path}</td>
                        <td className="px-2 py-1 text-right num text-ink">
                          {rq.status}
                        </td>
                        <td className="px-2 py-1 text-right num text-dim">
                          {rq.latency_ms != null ? `${rq.latency_ms}ms` : "—"}
                        </td>
                      </tr>
                    ))}
                    {audit.data.requests.length === 0 && (
                      <tr>
                        <td colSpan={4} className="px-2 py-3 text-center text-dim">
                          No API requests
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </Modal>
      )}

      {confirmDelete && (
        <ConfirmDialog
          title="Delete team"
          message={
            <>
              Delete <span className="font-semibold">{confirmDelete.team_name}</span> ({confirmDelete.email})? This
              permanently removes the account, its holdings, order history, submissions and scores.
            </>
          }
          confirmLabel="Delete permanently"
          busy={busy}
          onCancel={() => setConfirmDelete(null)}
          onConfirm={doDelete}
        />
      )}

      {confirmReset && (
        <ConfirmDialog
          title="Reset team"
          message={
            <>
              Reset <span className="font-semibold">{confirmReset.team_name}</span> to its starting capital? This cannot be undone.
            </>
          }
          confirmLabel="Reset team"
          onCancel={() => setConfirmReset(null)}
          onConfirm={() => {
            const t = confirmReset;
            setConfirmReset(null);
            void resetTeam(t);
          }}
        />
      )}
    </div>
  );
}
