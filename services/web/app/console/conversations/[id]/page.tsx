import Link from 'next/link';
import TakeOver from '@/components/TakeOver';
import { Section, StatusBadge } from '@/components/ui';
import { localTime, money, seconds } from '@/lib/format';
import { api, officeInfo } from '@/lib/server-api';

export const dynamic = 'force-dynamic';

interface Detail {
  conversation: {
    id: string; status: string; handoff_reason: string | null; first_inquiry_at: string | null; first_response_at: string | null;
    next_followup_at: string | null; workflow_id: string | null; first_name: string; last_name: string | null; phone: string;
    qualification: Record<string, unknown>; stage: string; source: string; consent_at: string | null; consent_text: string | null;
    agent_first_name: string | null; agent_last_name: string | null; listing_address: string | null; listing_price: number | null;
  };
  messages: { id: string; direction: 'in' | 'out'; kind: string; body: string; intent: string | null; status: string; meta: Record<string, unknown>; created_at: string }[];
  appointments: { id: string; starts_at: string; status: string; source: string }[];
  workflow: { status: string; state: Record<string, any> | null } | null;
}

const KIND: Record<string, string> = { first_touch: 'first touch', reply: 'reply', followup: 'follow-up', confirmation: 'keyword confirmation', agent: 'agent', keyword: 'carrier keyword', message: '' };

export default async function ConversationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [d, office] = await Promise.all([
    api<Detail>(`/v1/console/conversations/${encodeURIComponent(id)}`, { auth: 'office' }),
    officeInfo(),
  ]);
  const tz = office.timezone;
  const c = d.conversation;
  const q = c.qualification;
  const firstResponse = c.first_inquiry_at && c.first_response_at ? (new Date(c.first_response_at).getTime() - new Date(c.first_inquiry_at).getTime()) / 1000 : null;
  const temporalUi = process.env.TEMPORAL_UI_URL;

  return (
    <>
      <Link href="/console/conversations" className="text-sm text-accent">← Conversations</Link>
      <div className="mt-2 mb-5 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold tracking-tight">{c.first_name} {c.last_name}</h1>
        <StatusBadge status={c.status} />
        {c.handoff_reason && <span className="text-sm text-ink2">reason: {c.handoff_reason.replace(/_/g, ' ')}</span>}
      </div>
      <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
        <Section title="Transcript" right={<span className="text-xs text-muted">{c.phone}</span>}>
          <ol className="space-y-3" data-testid="transcript">
            {d.messages.map((m) => (
              <li key={m.id} className={`flex ${m.direction === 'out' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${m.direction === 'out' ? 'bg-accent-soft' : 'border border-line bg-raised'}`}>
                  <p className="whitespace-pre-wrap">{m.body}</p>
                  <p className="mt-1 text-[11px] text-muted">
                    {localTime(m.created_at, tz, { hour: 'numeric', minute: '2-digit', second: '2-digit' })}
                    {KIND[m.kind] ? ` · ${KIND[m.kind]}` : ''}
                    {m.intent ? ` · intent: ${m.intent.replace(/_/g, ' ')}` : ''}
                    {m.meta?.responsive === false ? ' · proactive' : ''}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </Section>
        <div className="space-y-4">
          <Section title="What the engine learned">
            <dl className="grid grid-cols-2 gap-y-2 text-sm">
              <dt className="text-muted">Timeline</dt><dd>{String(q.timeline ?? '–')}</dd>
              <dt className="text-muted">Pre-approved</dt><dd>{q.preapproved === undefined ? '–' : q.preapproved ? 'Yes' : 'Not yet'}</dd>
              <dt className="text-muted">Budget</dt><dd>{q.budget_max ? money(Number(q.budget_max)) : '–'}</dd>
              <dt className="text-muted">Stage</dt><dd>{c.stage}</dd>
              <dt className="text-muted">First response</dt><dd className="tabular">{seconds(firstResponse)}</dd>
              <dt className="text-muted">Asked about</dt><dd>{c.listing_address ?? '–'}{c.listing_price ? ` · ${money(c.listing_price)}` : ''}</dd>
            </dl>
          </Section>
          {d.appointments.length > 0 && (
            <Section title="Showing">
              {d.appointments.map((a) => (
                <p key={a.id} className="text-sm">
                  {localTime(a.starts_at, tz, { weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} with {c.agent_first_name} {c.agent_last_name}
                  <span className="text-muted"> · booked by {a.source === 'ai' ? 'the texting engine' : 'agent'}</span>
                </p>
              ))}
            </Section>
          )}
          <Section title="Workflow" right={c.workflow_id && temporalUi ? <a className="text-xs text-accent underline" href={`${temporalUi}/namespaces/default/workflows/${c.workflow_id}`} target="_blank" rel="noreferrer">Temporal history</a> : null}>
            {d.workflow ? (
              <dl className="grid grid-cols-2 gap-y-2 text-sm">
                <dt className="text-muted">Status</dt><dd>{d.workflow.status.toLowerCase()}</dd>
                {d.workflow.state && (
                  <>
                    <dt className="text-muted">Next follow-up</dt>
                    <dd>{localTime(d.workflow.state.next_followup_at, tz, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</dd>
                    <dt className="text-muted">Cadence step</dt><dd>{d.workflow.state.step} of {d.workflow.state.cadence_days?.length}</dd>
                    <dt className="text-muted">Deferred send</dt><dd>{d.workflow.state.deferred ? `until ${localTime(d.workflow.state.deferred.until, tz, { hour: 'numeric', minute: '2-digit' })}` : 'none'}</dd>
                  </>
                )}
              </dl>
            ) : (
              <p className="text-sm text-ink2">No workflow for this thread.</p>
            )}
            <p className="mt-2 break-all text-[11px] text-muted">{c.workflow_id}</p>
          </Section>
          <Section title="Consent">
            <p className="text-xs text-ink2">{c.consent_text ?? 'No SMS consent on file.'}</p>
            {c.consent_at && <p className="mt-1 text-[11px] text-muted">Recorded {localTime(c.consent_at, tz, { dateStyle: 'medium', timeStyle: 'short' })} · source: {c.source.replace(/_/g, ' ')}</p>}
          </Section>
          <TakeOver id={c.id} status={c.status} />
        </div>
      </div>
    </>
  );
}
