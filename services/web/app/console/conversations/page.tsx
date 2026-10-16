import Link from 'next/link';
import { Empty, PageHeader, StatusBadge } from '@/components/ui';
import { ago, seconds } from '@/lib/format';
import { api } from '@/lib/server-api';

export const dynamic = 'force-dynamic';

interface Row {
  id: string;
  status: string;
  handoff_reason: string | null;
  last_message_at: string;
  first_response_s: number | null;
  first_name: string;
  last_name: string | null;
  qualification: Record<string, unknown>;
  agent_first_name: string | null;
  message_count: number;
  last_body: string;
  next_followup_at: string | null;
}

const TABS = [
  ['', 'All'], ['ai_active', 'AI texting'], ['booked', 'Booked'], ['handed_off', 'Handed off'],
  ['agent_owned', 'Agent owns'], ['opted_out', 'Opted out'], ['closed', 'Closed'],
];

export default async function Conversations({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const { status = '' } = await searchParams;
  const rows = await api<Row[]>(`/v1/console/conversations${status ? `?status=${status}` : ''}`, { auth: 'office' });
  return (
    <>
      <PageHeader title="Conversations" sub="Every SMS thread, with what the texting engine learned and where the workflow stands." />
      <div className="mb-4 flex gap-1 overflow-x-auto">
        {TABS.map(([v, label]) => (
          <Link key={v} href={v ? `/console/conversations?status=${v}` : '/console/conversations'}
            className={`whitespace-nowrap rounded-full border px-3 py-1 text-sm ${status === v ? 'border-accent bg-accent-soft' : 'border-line bg-raised text-ink2'}`}>
            {label}
          </Link>
        ))}
      </div>
      {rows.length === 0 ? (
        <Empty>No conversations in this view.</Empty>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => {
            const q = r.qualification;
            const known = ['timeline', 'budget_max', 'preapproved'].filter((k) => q[k] !== undefined && q[k] !== null).length;
            return (
              <li key={r.id}>
                <Link href={`/console/conversations/${r.id}`} className="card flex flex-col gap-2 p-3 hover:border-accent sm:flex-row sm:items-center">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold">{r.first_name} {r.last_name}</span>
                      <StatusBadge status={r.status} />
                      <span className="text-xs text-muted">{r.message_count} messages · {ago(r.last_message_at)}</span>
                    </div>
                    <p className="mt-1 truncate text-sm text-ink2">{r.last_body}</p>
                  </div>
                  <div className="flex flex-none gap-4 text-xs text-ink2 tabular">
                    <span title="Time from inquiry to the first text">first reply {seconds(r.first_response_s)}</span>
                    <span title="Timeline, budget and pre-approval">qualified {known}/3</span>
                    <span>{r.agent_first_name}</span>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
