'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';

interface Validation {
  numbers: { text: string; value: number; matched: boolean }[];
  unmatched: string[];
  fair_housing: string[];
  ok?: boolean;
}

interface Props {
  farmId: string;
  report: { id: string; status: string; body: string; validation: Validation; attempts: number; model: string; audience_count: number | null } | null;
  audience: number;
}

/** Highlights each figure in the report: checked against the stats, or not found in them. */
function Highlighted({ body, validation }: { body: string; validation: Validation }) {
  const parts = useMemo(() => {
    const out: { text: string; matched?: boolean }[] = [];
    let rest = body;
    for (const n of validation.numbers) {
      const i = rest.indexOf(n.text);
      if (i < 0) continue;
      out.push({ text: rest.slice(0, i) });
      out.push({ text: n.text, matched: n.matched });
      rest = rest.slice(i + n.text.length);
    }
    out.push({ text: rest });
    return out;
  }, [body, validation]);
  return (
    <p className="leading-relaxed" data-testid="report-body">
      {parts.map((p, i) =>
        p.matched === undefined ? (
          <span key={i}>{p.text}</span>
        ) : (
          <mark
            key={i}
            title={p.matched ? 'Matches the computed stats' : 'Not in the computed stats'}
            className={`rounded px-0.5 ${p.matched ? 'bg-accent-soft text-ink' : 'bg-[color-mix(in_srgb,var(--bad)_18%,transparent)] text-ink underline decoration-[var(--bad)] decoration-2'}`}
          >
            {p.text}
            <span className="sr-only">{p.matched ? ' (checked)' : ' (not in data)'}</span>
          </mark>
        ),
      )}
    </p>
  );
}

export default function ReportEditor({ farmId, report, audience }: Props) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(report?.body ?? '');
  const [busy, setBusy] = useState('');
  const [current, setCurrent] = useState(report);

  async function call(path: string, body?: unknown) {
    const res = await fetch(`/api/v1/console/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return res.json();
  }

  async function generate() {
    setBusy('generate');
    await call(`farms/${farmId}/reports`);
    setBusy('');
    router.refresh();
  }

  async function recheck() {
    if (!current) return;
    setBusy('check');
    const v = await call(`reports/${current.id}/revise`, { body: text });
    setCurrent({ ...current, body: text, validation: v, status: v.status });
    setEditing(false);
    setBusy('');
  }

  async function send() {
    if (!current) return;
    setBusy('send');
    const r = await call(`reports/${current.id}/send`);
    setCurrent({ ...current, status: 'sent', audience_count: r.sent ?? audience });
    setBusy('');
    router.refresh();
  }

  if (!current) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-ink2">No report yet for this farm.</p>
        <button className="btn" onClick={generate} disabled={!!busy}>Draft this month&apos;s report</button>
      </div>
    );
  }

  const checked = current.validation.numbers.filter((n) => n.matched).length;
  const bad = current.validation.unmatched.length + current.validation.fair_housing.length;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${bad ? 'border-[var(--bad)] text-bad' : 'border-line text-ink'}`} data-testid="validation-status">
          <span aria-hidden>{bad ? '✕' : '✓'}</span>
          {bad ? `${current.validation.unmatched.length} figure(s) not in the data${current.validation.fair_housing.length ? ', steering language' : ''}` : `${checked} figures checked`}
        </span>
        <span className="text-xs text-muted">{current.status.replace('_', ' ')} · {current.attempts} draft attempt(s) · {current.model}</span>
      </div>
      {editing ? (
        <textarea className="input min-h-[180px] leading-relaxed" value={text} onChange={(e) => setText(e.target.value)} aria-label="Report text" />
      ) : (
        <Highlighted body={current.body} validation={current.validation} />
      )}
      {current.validation.unmatched.length > 0 && (
        <p className="text-sm text-bad">Not in the stats for this farm: {current.validation.unmatched.join(', ')}</p>
      )}
      <div className="flex flex-wrap gap-2">
        {current.status !== 'sent' && (
          editing ? (
            <button className="btn" onClick={recheck} disabled={!!busy}>{busy === 'check' ? 'Checking…' : 'Check figures again'}</button>
          ) : (
            <button className="btn-ghost" onClick={() => { setText(current.body); setEditing(true); }}>Edit</button>
          )
        )}
        {current.status === 'draft' && !editing && (
          <button className="btn" onClick={send} disabled={!!busy}>Send to {audience} homeowners</button>
        )}
        {current.status === 'sent' && <span className="text-sm text-ink2">Sent to {current.audience_count} homeowners.</span>}
        <button className="btn-ghost" onClick={generate} disabled={!!busy}>{busy === 'generate' ? 'Drafting…' : 'New draft'}</button>
      </div>
    </div>
  );
}
