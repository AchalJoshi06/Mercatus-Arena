import Link from "next/link";

const POINTS = [
  ["Live market", "Trade a replayed NSE dataset against real-time prices."],
  ["Fair evaluation", "P&L, drawdown, risk and consistency scored automatically."],
  ["API + manual", "Use the terminal or the REST API with your team key."],
];

export function AuthShell({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
  footer: React.ReactNode;
}) {
  return (
    <div className="grid min-h-screen lg:grid-cols-[1.1fr_1fr]">
      <aside className="relative hidden flex-col justify-between overflow-hidden border-r border-line bg-panel p-10 lg:flex">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-[0.07]"
          style={{
            backgroundImage:
              "linear-gradient(#2dd4bf 1px, transparent 1px), linear-gradient(90deg, #2dd4bf 1px, transparent 1px)",
            backgroundSize: "40px 40px",
          }}
        />
        <Link href="/login" className="relative flex items-center gap-3">
          <span className="grid h-9 w-9 place-items-center bg-acc font-mono text-base font-black text-bg">M</span>
          <span className="font-display text-lg font-bold tracking-tight text-ink">
            MERCATUS<span className="text-acc">.ARENA</span>
          </span>
        </Link>
        <div className="relative max-w-md space-y-6">
          <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-acc">TechVerse 2026</div>
          <h2 className="font-display text-4xl font-bold leading-tight tracking-tight text-ink">
            The live paper-trading competition.
          </h2>
          <ul className="space-y-4">
            {POINTS.map(([h, d]) => (
              <li key={h} className="flex gap-3">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 bg-acc" />
                <div>
                  <div className="text-[13px] font-semibold text-ink">{h}</div>
                  <div className="text-[13px] text-muted">{d}</div>
                </div>
              </li>
            ))}
          </ul>
        </div>
        <div className="relative text-[10px] uppercase tracking-widest text-dim">
          Real-time algorithmic trading evaluation terminal
        </div>
      </aside>

      <main className="flex flex-col items-center justify-center px-4 py-10 sm:px-8">
        <Link href="/login" className="mb-6 flex items-center gap-2.5 lg:hidden">
          <span className="grid h-9 w-9 place-items-center bg-acc font-mono text-base font-black text-bg">M</span>
          <span className="font-display text-lg font-bold tracking-tight text-ink">
            MERCATUS<span className="text-acc">.ARENA</span>
          </span>
        </Link>
        <div className="w-full max-w-sm">
          <h1 className="font-display text-2xl font-bold tracking-tight text-ink">{title}</h1>
          <p className="mb-5 mt-1 text-[13px] text-muted">{subtitle}</p>
          <div className="border border-line bg-panel p-5">{children}</div>
          <p className="mt-4 text-center text-[13px] text-muted">{footer}</p>
        </div>
      </main>
    </div>
  );
}
