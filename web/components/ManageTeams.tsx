"use client";

import { useEffect, useState } from "react";
import { api, getToken, fmt, fmtInr } from "@/lib/api";
import { Badge, Button, Input, Panel, Select, TableWrap, Td, Th } from "./ui";

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

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-black/60" onClick={onClose} />
      <div className="relative z-10 max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-xl border border-line bg-panel shadow-xl">
        <header className="flex items-center justify-between border-b border-line bg-panel2/70 px-4 py-2.5">
          <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">
            {title}
          </div>
          <button
            onClick={onClose}
            className="text-[12px] text-dim transition-colors hover:text-ink"
          >
            ✕
          </button>
        </header>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
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

  useEffect(() => setToken(getToken()), []);
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
      setToken(null);
      setMsg((e as Error).message);
    }
  }

  async function doLogin() {
    try {
      const r = await api<{ token: string }>("/api/auth/login", {
        method: "POST",
        body: login,
      });
      localStorage.setItem("mercatus_token", r.token);
      setToken(r.token);
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

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-display text-xl font-bold tracking-tight text-ink">
          Manage Teams
        </h1>
        <Badge color="#f0514c">admin</Badge>
        <Button variant="ghost" size="sm" onClick={refresh} className="ml-auto">
          Refresh
        </Button>
        <Button size="sm" onClick={() => setShowAdd((s) => !s)}>
          {showAdd ? "Close" : "+ Add team"}
        </Button>
      </div>

      {msg && (
        <div className="num rounded-lg border border-line bg-panel px-3 py-2 text-[12px] text-muted">
          {msg}
        </div>
      )}

      {showAdd && (
        <Panel title="Add account">
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Select
                label="Role"
                value={form.role}
                onChange={(e) => setForm({ ...form, role: e.target.value })}
              >
                <option value="team">Student / Team</option>
                <option value="evaluator">Evaluator (judge)</option>
              </Select>
              {form.role === "team" && (
                <Input
                  label="Starting capital"
                  mono
                  value={form.starting_capital}
                  onChange={(e) =>
                    setForm({ ...form, starting_capital: e.target.value })
                  }
                />
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
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
            </div>
            <Input
              label="Password"
              type="password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
            />
            <Button
              onClick={createUser}
              disabled={
                busy || !form.team_name || !form.email || form.password.length < 8
              }
              className="w-full"
            >
              Create account
            </Button>
          </div>
        </Panel>
      )}

      <Panel
        title="Teams"
        right={<Badge color="#2dd4bf">{teams.length} accounts</Badge>}
        pad={false}
      >
        <TableWrap>
          <table className="w-full">
            <thead>
              <tr className="border-b border-line bg-panel2/50">
                <Th>Team</Th>
                <Th>Email</Th>
                <Th right>Cash</Th>
                <Th right>Portfolio</Th>
                <Th right>Created</Th>
                <Th right>Actions</Th>
              </tr>
            </thead>
            <tbody>
              {teams.map((t) => (
                <tr key={t.team_id} className="border-b border-line/50 last:border-0">
                  <Td mono={false}>
                    <span className="font-medium text-ink">{t.team_name}</span>
                    <span className="ml-1.5">
                      <Badge color={roleColor(t.role)}>{t.role}</Badge>
                    </span>
                    {t.is_frozen && <Badge color="#f0514c">frozen</Badge>}
                    <div className="mt-0.5 text-[11px] text-dim">#{t.team_id}</div>
                  </Td>
                  <Td mono={false}>
                    <span className="text-[12px] text-muted">{t.email}</span>
                  </Td>
                  <Td right>{fmtInr(t.cash_balance)}</Td>
                  <Td right>{fmtInr(t.total_portfolio_value)}</Td>
                  <Td right muted>
                    {new Date(t.created_at).toLocaleDateString("en-IN", {
                      day: "2-digit",
                      month: "short",
                    })}
                  </Td>
                  <Td right>
                    <div className="flex flex-wrap justify-end gap-1.5">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => freeze(t, !t.is_frozen)}
                      >
                        {t.is_frozen ? "Unfreeze" : "Freeze"}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => resetTeam(t)}>
                        Reset
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => openAudit(t)}>
                        Audit
                      </Button>
                      <Button
                        size="sm"
                        variant="accent"
                        onClick={() => openEdit(t)}
                        disabled={t.role === "admin"}
                      >
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={() => setConfirmDelete(t)}
                        disabled={t.role === "admin"}
                      >
                        Delete
                      </Button>
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
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
        <Modal
          title="Delete team"
          onClose={() => setConfirmDelete(null)}
        >
          <div className="space-y-4">
            <p className="text-sm text-ink">
              Delete{" "}
              <span className="font-semibold">{confirmDelete.team_name}</span> (
              {confirmDelete.email})? This permanently removes the account, its
              holdings, order history, submissions and scores.
            </p>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => setConfirmDelete(null)} className="flex-1">
                Cancel
              </Button>
              <Button
                variant="danger"
                onClick={doDelete}
                disabled={busy}
                className="flex-1"
              >
                Delete permanently
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}