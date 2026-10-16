import Link from 'next/link';
import { Empty, PageHeader } from '@/components/ui';
import { api } from '@/lib/server-api';

export const dynamic = 'force-dynamic';

interface Row {
  id: string;
  first_name: string;
  last_name: string;
  stage: string;
  source: string;
  score: number;
  band: string;
  components: Record<string, number>;
  next_action: string;
  next_action_reason: string;
  agent_first_name: string;
  agent_last_name: string;
}

const LABEL: Record<string, string> = {
  inquiry: 'inquiry', saved_search: 'saved search', sms_in: 'texted back', appointment_booked: 'showing booked',
  open_house_visit: 'open house', favorite: 'favorited', email_click: 'email click', email_open: 'email open',
  listing_view: 'listing views', alert_sent: 'alerts', unanswered_streak: 'unanswered texts', 'intent:wants_tour': 'wants a tour',
  'intent:accepts_slot': 'picked a time', 'intent:qualifying_answer': 'answered questions', 'intent:wants_human': 'asked for agent',
  'intent:not_interested': 'not interested', 'intent:question': 'asked a question', opted_out: 'opted out',
};
const BANDS = ['hot', 'warm', 'cooling', 'cold'];

export default async function Relationships({ searchParams }: { searchParams: Promise<{ band?: string }> }) {
  const { band = '' } = await searchParams;
  const data = await api<{ bands: Record<string, number>; contacts: Row[] }>(`/v1/console/relationships${band ? `?band=${band}` : ''}`, { auth: 'office' });
  return (
    <>
      <PageHeader
        title="Relationship health"
        sub="Every signal decays with a 14-day half-life. The parts of each score are shown, so a number is never a black box."
      />
      <div className="mb-4 flex flex-wrap gap-2">
        <Link href="/console/relationships" className={`rounded-full border px-3 py-1 text-sm ${!band ? 'border-accent bg-accent-soft' : 'border-line bg-raised text-ink2'}`}>All</Link>
        {BANDS.map((b, i) => (
          <Link key={b} href={`/console/relationships?band=${b}`}
            className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-sm ${band === b ? 'border-accent bg-accent-soft' : 'border-line bg-raised text-ink2'}`}>
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: `var(--ord-${4 - i})` }} aria-hidden />
            {b[0].toUpperCase() + b.slice(1)} <span className="tabular text-muted">{(data.bands[b] ?? 0).toLocaleString('en-US')}</span>
          </Link>
        ))}
      </div>
      {data.contacts.length === 0 ? (
        <Empty>No scored contacts in this band.</Empty>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="text-left text-xs text-muted">
              <tr>
                <th className="px-4 py-2 font-medium">Contact</th>
                <th className="px-4 py-2 font-medium">Score</th>
                <th className="px-4 py-2 font-medium">What drives it</th>
                <th className="px-4 py-2 font-medium">Next best action</th>
              </tr>
            </thead>
            <tbody>
              {data.contacts.map((c) => {
                const parts = Object.entries(c.components).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 3);
                const idx = BANDS.indexOf(c.band);
                return (
                  <tr key={c.id} className="border-t border-line align-top">
                    <td className="px-4 py-3">
                      <p className="font-medium">{c.first_name} {c.last_name}</p>
                      <p className="text-xs text-muted">{c.source.replace(/_/g, ' ')} · {c.agent_first_name} {c.agent_last_name}</p>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className="tabular w-7 font-semibold">{c.score}</span>
                        <div className="h-2 w-24 rounded-full bg-[var(--line)]" title={`${c.score} of 100, ${c.band}`}>
                          <div className="h-2 rounded-full" style={{ width: `${Math.max(2, c.score)}%`, background: `var(--ord-${4 - Math.max(0, idx)})` }} />
                        </div>
                        <span className="text-xs text-muted">{c.band}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <ul className="flex flex-wrap gap-1">
                        {parts.map(([k, v]) => (
                          <li key={k} className="rounded bg-page px-1.5 py-0.5 text-xs text-ink2 tabular">{LABEL[k] ?? k} {v > 0 ? '+' : ''}{v.toFixed(1)}</li>
                        ))}
                      </ul>
                    </td>
                    <td className="px-4 py-3">
                      <p className="font-medium">{c.next_action.replace(/_/g, ' ')}</p>
                      <p className="text-xs text-ink2">{c.next_action_reason}</p>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
