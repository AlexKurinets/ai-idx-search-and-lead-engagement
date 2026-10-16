import Link from 'next/link';
import { BarList, Empty, PageHeader, Section, StatTile } from '@/components/ui';
import { seconds } from '@/lib/format';
import { api } from '@/lib/server-api';

export const dynamic = 'force-dynamic';

interface Overview {
  leads: number;
  median_first_response_s: number | null;
  p90_first_response_s: number | null;
  outcomes: Record<'ai_active' | 'booked' | 'handed_off' | 'agent_owned' | 'opted_out' | 'closed', number>;
  qualified_by_ai: number;
  handoff_reasons: { reason: string; n: number }[];
  score_bands: Record<string, number>;
  next_actions: { id: string; first_name: string; last_name: string; score: number; band: string; next_action: string; next_action_reason: string; agent_first_name: string }[];
  alerts_24h: number;
  farm_reports: Record<string, number>;
  contacts: number;
}

const REASONS: Record<string, string> = {
  fair_housing: 'Fair Housing sensitive question',
  requested_agent: 'Asked for a person',
  offer_or_contract: 'Offer or contract question',
  no_availability: 'No open showing slots',
};
const ACTIONS: Record<string, string> = {
  call_today: 'Call today', send_matches: 'Send matches', check_in: 'Check in', refresh_search: 'Refresh search',
  send_market_report: 'Send market report', monthly_update: 'Monthly update', prepare_showing: 'Prepare showing',
  agent_follow_up: 'Follow up personally', pause_outreach: 'Pause outreach',
};

export default async function Overview() {
  const o = await api<Overview>('/v1/console/overview', { auth: 'office' });
  const pct = (n: number) => (o.leads ? `${Math.round((n / o.leads) * 100)}% of leads` : '');
  const bands = ['hot', 'warm', 'cooling', 'cold'];
  return (
    <>
      <PageHeader title="Overview" sub={`${o.leads} web leads in conversation · ${o.contacts.toLocaleString('en-US')} contacts in this office`} />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatTile testId="median-first-response" label="Median first response" value={seconds(o.median_first_response_s)} sub={`p90 ${seconds(o.p90_first_response_s)}`} />
        <StatTile label="Qualified by the texting engine" value={o.qualified_by_ai} sub={pct(o.qualified_by_ai)} />
        <StatTile label="Showings booked by text" value={o.outcomes.booked} sub={pct(o.outcomes.booked)} />
        <StatTile label="Handed to an agent" value={o.outcomes.handed_off} sub={pct(o.outcomes.handed_off)} />
        <StatTile label="Saved-search alerts, 24h" value={o.alerts_24h} sub="from percolated new listings" />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Section title="Where conversations stand" right={<Link className="text-sm text-accent" href="/console/conversations">All</Link>}>
          {o.leads === 0 ? (
            <Empty>No web leads yet.</Empty>
          ) : (
            <BarList
              total={o.leads}
              bars={[
                { label: 'Showing booked', value: o.outcomes.booked },
                { label: 'Still with the texting engine', value: o.outcomes.ai_active },
                { label: 'Handed to an agent', value: o.outcomes.handed_off },
                { label: 'Agent took over', value: o.outcomes.agent_owned },
                { label: 'Not interested', value: o.outcomes.closed },
                { label: 'Opted out (STOP)', value: o.outcomes.opted_out },
              ]}
            />
          )}
        </Section>
        <Section title="Relationship health" right={<Link className="text-sm text-accent" href="/console/relationships">Contacts</Link>}>
          <BarList
            bars={bands.map((b, i) => ({ label: b[0].toUpperCase() + b.slice(1), value: o.score_bands[b] ?? 0, color: `var(--ord-${4 - i})` }))}
          />
          <p className="mt-3 text-xs text-muted">Score from engagement with a 14-day half-life. Hot 70+, warm 45+, cooling 20+.</p>
        </Section>
        <Section title="Why leads were handed off">
          {o.handoff_reasons.length === 0 ? (
            <Empty>No hand-offs yet.</Empty>
          ) : (
            <BarList bars={o.handoff_reasons.map((r) => ({ label: REASONS[r.reason] ?? r.reason, value: r.n }))} />
          )}
          <p className="mt-3 text-xs text-muted">Decided by deterministic rules before the model sees the message.</p>
        </Section>
      </div>

      <div className="mt-4">
        <Section title="Next best actions" right={<span className="text-xs text-muted">highest scores first</span>}>
          {o.next_actions.length === 0 ? (
            <Empty>Scores have not been computed yet.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted">
                  <tr>
                    <th className="py-2 pr-3 font-medium">Contact</th>
                    <th className="py-2 pr-3 font-medium">Score</th>
                    <th className="py-2 pr-3 font-medium">Action</th>
                    <th className="hidden py-2 pr-3 font-medium sm:table-cell">Why</th>
                    <th className="py-2 font-medium">Agent</th>
                  </tr>
                </thead>
                <tbody className="tabular">
                  {o.next_actions.map((a) => (
                    <tr key={a.id} className="border-t border-line">
                      <td className="py-2 pr-3 font-medium">{a.first_name} {a.last_name}</td>
                      <td className="py-2 pr-3">{a.score} <span className="text-xs text-muted">{a.band}</span></td>
                      <td className="py-2 pr-3">
                        {ACTIONS[a.next_action] ?? a.next_action}
                        <span className="block text-xs text-ink2 sm:hidden">{a.next_action_reason}</span>
                      </td>
                      <td className="hidden py-2 pr-3 text-ink2 sm:table-cell">{a.next_action_reason}</td>
                      <td className="py-2">{a.agent_first_name}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      </div>
    </>
  );
}
