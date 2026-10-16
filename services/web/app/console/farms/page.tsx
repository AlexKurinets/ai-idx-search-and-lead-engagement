import Link from 'next/link';
import { Empty, PageHeader } from '@/components/ui';
import { api } from '@/lib/server-api';

export const dynamic = 'force-dynamic';

interface Farm {
  id: string;
  name: string;
  agent_name: string;
  audience: number;
  report_id: string | null;
  report_status: string | null;
  report_created_at: string | null;
  report_attempts: number | null;
}

const STATUS: Record<string, string> = { draft: 'Validated draft', needs_review: 'Needs review', sent: 'Sent' };

export default async function Farms() {
  const farms = await api<Farm[]>('/v1/console/farms', { auth: 'office' });
  return (
    <>
      <PageHeader
        title="Farm reports"
        sub="Market stats are computed in PostGIS inside each farm polygon; the model writes the words; a validator checks every figure before a report can be sent."
      />
      {farms.length === 0 ? (
        <Empty>No farm areas for this office.</Empty>
      ) : (
        <div className="grid gap-3 md:grid-cols-3">
          {farms.map((f) => (
            <Link key={f.id} href={`/console/farms/${f.id}`} className="card p-4 hover:border-accent">
              <p className="font-semibold">{f.name}</p>
              <p className="text-sm text-ink2">{f.agent_name}</p>
              <dl className="mt-3 grid grid-cols-2 gap-y-1 text-sm">
                <dt className="text-muted">Homeowners</dt><dd className="tabular">{f.audience}</dd>
                <dt className="text-muted">Latest report</dt><dd>{f.report_status ? STATUS[f.report_status] : 'None yet'}</dd>
                <dt className="text-muted">Drafts tried</dt><dd className="tabular">{f.report_attempts ?? '–'}</dd>
              </dl>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
