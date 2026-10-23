"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, setToken } from "@/lib/api";
import { Button, Input } from "@/components/ui";
import { AuthShell } from "@/components/AuthShell";

export default function LoginPage() {
  const router = useRouter();
  const [form, setForm] = useState({ email: "", password: "" });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ token: string }>("/api/auth/login", {
        method: "POST",
        body: form,
      });
      setToken(r.token);
      const me = await api<{ role: string }>("/api/auth/me", { token: r.token });
      router.push(
        me.role === "admin" ? "/admin" : me.role === "evaluator" ? "/evaluator" : "/dashboard",
      );
    } catch (ex) {
      setErr((ex as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell
      title="Sign in"
      subtitle="Welcome back. Enter your team credentials."
      footer={
        <>
          No account?{" "}
        <Link href="/register" className="text-acc hover:underline">
          Register your team
        </Link>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4">
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
          {err && <div className="border border-sell/30 bg-sell/10 px-3 py-2 text-sm text-sell">{err}</div>}
          <Button type="submit" disabled={busy} className="w-full">
            {busy ? "Signing in…" : "Sign in"}
          </Button>
        </form>
    </AuthShell>
  );
}
