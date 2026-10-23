"use client";

/** Square-cornered terminal panel used by the participant pages. */
export function PPanel({
  title,
  right,
  children,
  className = "",
  bodyClassName = "",
  pad = true,
}: {
  title?: React.ReactNode;
  right?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
  pad?: boolean;
}) {
  return (
    <section className={`min-w-0 border border-line bg-panel ${className}`}>
      {(title || right) && (
        <header className="flex min-h-[40px] items-center justify-between gap-3 border-b border-line bg-panel2/60 px-4 py-2">
          <h2 className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted">{title}</h2>
          {right && <div className="flex shrink-0 items-center gap-2">{right}</div>}
        </header>
      )}
      <div className={`${pad ? "p-4" : ""} ${bodyClassName}`}>{children}</div>
    </section>
  );
}

export function PageHeader({ title, sub, right }: { title: string; sub?: string; right?: React.ReactNode }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="font-display text-2xl font-bold tracking-tight text-ink">{title}</h1>
        {sub && <p className="mt-1 text-[13px] text-muted">{sub}</p>}
      </div>
      {right}
    </header>
  );
}

export function Pill({ children, color = "#2dd4bf" }: { children: React.ReactNode; color?: string }) {
  return (
    <span
      className="inline-flex items-center whitespace-nowrap px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider"
      style={{ color, backgroundColor: `${color}1a`, border: `1px solid ${color}33` }}
    >
      {children}
    </span>
  );
}
