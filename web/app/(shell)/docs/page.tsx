import Link from "next/link";
import { PPanel, PageHeader } from "@/components/PPanel";

const SECTIONS = [
  {
    id: "overview",
    title: "Overview",
    body: "TechVerse 2026 — Mercatus Arena is a real-time algorithmic trading evaluation. Every team trades the identical shared market feed over REST + WebSocket, and the platform measures per-request millisecond latency. Final standings blend live trading PnL with judge scores.",
  },
  {
    id: "timeline",
    title: "Event timeline",
    rows: [
      ["T−0", "Market opens — live feed on REST + WebSocket. API keys revealed."],
      ["T−20m", "Leaderboard freezes — rankings stop changing, trading continues."],
      ["T−15m", "API rejects new orders — no further fills."],
      ["T−0 (end)", "Final rankings computed from PnL, code, and report."],
    ],
  },
  {
    id: "rules",
    title: "Trading rules",
    rows: [
      ["Market orders", "Fill instantly at the current mid price."],
      ["Limit orders", "Fill only when the market crosses your limit; otherwise REJECTED with LIMIT_NOT_REACHED."],
      ["Positions", "Long-only. No leverage. Shorting is rejected (INSUFFICIENT_POSITION when closing more than held)."],
      ["Brokerage", "Flat ₹10 charged per executed trade, after the first 100 free trades."],
      ["Starting capital", "Every team starts with identical cash — fairness is guaranteed."],
    ],
  },
  {
    id: "scoring",
    title: "Scoring",
    rows: [
      ["PnL score", "60% — blend of rank & return magnitude, max drawdown, risk, consistency."],
      ["Code quality", "20% — judged by the evaluator panel."],
      ["Strategy report", "15% — judged by the evaluator panel."],
      ["Efficiency", "5% — penalizes rejected orders and slow API calls."],
      ["Formula", "Final = (PnL × 0.60) + (Code × 0.20) + (Report × 0.15) + (Efficiency × 0.05)"],
    ],
  },
];

const STEPS: React.ReactNode[] = [
  "Register your team — your API key is generated immediately but stays masked until launch.",
  <>
    Grab the API reference on the{" "}
    <Link href="/api" className="text-acc hover:underline">
      API Reference
    </Link>{" "}
    page and build your bot.
  </>,
  "Watch fills and latency live on the Trading Desk.",
  "Submit your code and strategy report before the deadline.",
];

export default function DocsPage() {
  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <PageHeader title="Documentation" sub="Everything you need to compete in the Mercatus Arena." />

      <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
        {SECTIONS.map((s) => (
          <PPanel key={s.id} title={s.title} className={s.id === "overview" ? "lg:col-span-2" : ""}>
            {s.body ? (
              <p className="max-w-3xl text-[14px] leading-7 text-muted">{s.body}</p>
            ) : (
              <dl className="divide-y divide-line/60">
                {s.rows!.map(([k, v]) => (
                  <div key={k} className="grid gap-1 py-3 first:pt-0 last:pb-0 sm:grid-cols-[8.5rem_1fr] sm:gap-4">
                    <dt className="num text-[13px] font-bold text-acc">{k}</dt>
                    <dd className="text-[14px] leading-6 text-muted">{v}</dd>
                  </div>
                ))}
              </dl>
            )}
          </PPanel>
        ))}
      </div>

      <PPanel title="Next steps">
        <ol className="space-y-3">
          {STEPS.map((t, i) => (
            <li key={i} className="flex gap-3 text-[14px] leading-6 text-muted">
              <span className="num mt-px grid h-6 w-6 shrink-0 place-items-center border border-acc/40 bg-acc/10 text-[11px] font-bold text-acc">
                {i + 1}
              </span>
              <span className="min-w-0">{t}</span>
            </li>
          ))}
        </ol>
      </PPanel>
    </div>
  );
}
