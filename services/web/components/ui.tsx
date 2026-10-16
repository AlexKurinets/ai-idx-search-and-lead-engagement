import type { ReactNode } from 'react';

export function StatTile({ label, value, sub, testId }: { label: string; value: ReactNode; sub?: ReactNode; testId?: string }) {
  return (
    <div className="card p-4" data-testid={testId}>
      <p className="text-xs font-medium text-muted">{label}</p>
      <p className="mt-1 text-2xl font-bold tracking-tight">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-ink2">{sub}</p>}
    </div>
  );
}

export interface Bar {
  label: string;
  value: number;
  color?: string;
  note?: string;
}

/**
 * Horizontal bars with direct value labels: a single measure, so no legend; text stays
 * in ink tokens, the bar carries the color. Each row has a native tooltip with the exact
 * value and share.
 */
export function BarList({ bars, total, unit = '' }: { bars: Bar[]; total?: number; unit?: string }) {
  const max = Math.max(1, ...bars.map((b) => b.value));
  const sum = total ?? bars.reduce((s, b) => s + b.value, 0);
  return (
    <ul className="space-y-2.5" role="list">
      {bars.map((b) => {
        const share = sum ? Math.round((b.value / sum) * 100) : 0;
        return (
          <li key={b.label} title={`${b.label}: ${b.value.toLocaleString('en-US')}${unit} (${share}%)`} className="group">
            <div className="flex items-baseline justify-between text-sm">
              <span className="text-ink">{b.label}</span>
              <span className="tabular text-ink2">
                {b.value.toLocaleString('en-US')}{unit} <span className="text-muted">· {share}%</span>
              </span>
            </div>
            <div className="mt-1 h-2 w-full rounded-full bg-[var(--line)]">
              <div
                className="h-2 rounded-full transition-opacity group-hover:opacity-80"
                style={{ width: `${Math.max(b.value ? 2 : 0, (b.value / max) * 100)}%`, background: b.color ?? 'var(--series-1)' }}
              />
            </div>
            {b.note && <p className="mt-0.5 text-xs text-muted">{b.note}</p>}
          </li>
        );
      })}
    </ul>
  );
}

const STATUS_STYLE: Record<string, string> = {
  ai_active: 'AI texting',
  booked: 'Showing booked',
  handed_off: 'Handed to agent',
  agent_owned: 'Agent owns',
  opted_out: 'Opted out',
  closed: 'Closed',
};

export function StatusBadge({ status }: { status: string }) {
  const icon = { booked: '✓', handed_off: '→', opted_out: '⊘', closed: '·', ai_active: '◌', agent_owned: '●' }[status] ?? '·';
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-line bg-raised px-2 py-0.5 text-xs font-medium text-ink">
      <span aria-hidden>{icon}</span>
      {STATUS_STYLE[status] ?? status}
    </span>
  );
}

export function PageHeader({ title, sub, right }: { title: string; sub?: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        {sub && <p className="mt-1 text-sm text-ink2">{sub}</p>}
      </div>
      {right}
    </div>
  );
}

export function Section({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="card p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="font-semibold">{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-lg bg-page p-4 text-sm text-ink2">{children}</p>;
}
