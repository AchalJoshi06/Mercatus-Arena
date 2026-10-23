"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, setToken } from "@/lib/api";
import { Button, Input } from "@/components/ui";
import { AuthShell } from "@/components/AuthShell";

export default function RegisterPage() {
  const router = useRouter();
  const [form, setForm] = useState({ team_name: "", email: "", password: "", registration_code: "" });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (form.password.length < 8) {
      setErr("Password must be at least 8 characters");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const body: Record<string, string> = { ...form };
      if (!body.registration_code.trim()) delete body.registration_code;
      const r = await api<{ token: string }>("/api/auth/register", {
        method: "POST",
        body,
      });
      setToken(r.token);
      router.push("/dashboard");
    } catch (ex) {
      setErr((ex as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell
      title="Register your team"
      subtitle="Create an account to join the competition."
      footer={
        <>
          Already registered?{" "}
        <Link href="/login" className="text-acc hover:underline">
          Sign in
        </Link>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4">
          <div className="border border-gold/25 bg-gold/10 px-3 py-2 text-[12px] leading-relaxed text-gold">
            Your API key is generated now but stays masked until the admin
            reveals it at launch.
          </div>
          <Input
            label="Team name"
            required
            value={form.team_name}
            onChange={(e) => setForm({ ...form, team_name: e.target.value })}
          />
          <Input
            label="Email"
            type="email"
            required
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
          <Input
            label="Password"
            type="password"
            required
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
          />
          <Input
            label="Registration code (if required)"
            type="password"
            value={form.registration_code}
            onChange={(e) => setForm({ ...form, registration_code: e.target.value })}
          />
          {err && <div className="border border-sell/30 bg-sell/10 px-3 py-2 text-sm text-sell">{err}</div>}
          <Button type="submit" disabled={busy} className="w-full">
            {busy ? "Creating team…" : "Create team"}
          </Button>
        </form>
    </AuthShell>
  );
}
