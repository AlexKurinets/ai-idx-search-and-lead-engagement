import Link from 'next/link';
import FarmMap from '@/components/FarmMap';
import ReportEditor from '@/components/ReportEditor';
import { Section } from '@/components/ui';
import { money } from '@/lib/format';
import { api, currentOffice } from '@/lib/server-api';

export const dynamic = 'force-dynamic';

interface FarmDetail {
  id: string;
  name: string;
  agent_name: string;
  geometry: GeoJSON.Polygon;
  audience: number;
  report: {
    id: string; status: string; body: string; attempts: number; model: string; audience_count: number | null;
    stats: Record<string, number | null>;
    validation: { numbers: { text: string; value: number; matched: boolean }[]; unmatched: string[]; fair_housing: string[] };
  } | null;
}

const ROWS: [string, string, (v: number) => string][] = [
  ['active_listings', 'Homes for sale', String],
  ['median_list_price', 'Median list price', money],
  ['median_price_per_sqft', 'Median $ per sq ft', money],
  ['new_listings_30d', 'New in last 30 days', String],
  ['closed_sales', 'Sold in period', String],
  ['median_close_price', 'Median sale price', money],
  ['median_close_price_prior', 'Prior period median', money],
  ['median_close_price_change_pct', 'Change', (v) => `${v > 0 ? '+' : ''}${v}%`],
  ['median_days_on_market', 'Median days on market', String],
  ['sale_to_list_pct', 'Sale-to-list', (v) => `${v}%`],
];

export default async function FarmPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [farm, office] = await Promise.all([api<FarmDetail>(`/v1/console/farms/${encodeURIComponent(id)}`, { auth: 'office' }), currentOffice()]);
  const stats = farm.report?.stats;
  return (
    <>
      <Link href="/console/farms" className="text-sm text-accent">← Farm reports</Link>
      <div className="mt-2 mb-5">
        <h1 className="text-2xl font-bold tracking-tight">{farm.name}</h1>
        <p className="text-sm text-ink2">{farm.agent_name}&apos;s farm · {farm.audience} homeowners with email consent inside the polygon</p>
      </div>
      <div className="grid gap-4 lg:grid-cols-[1fr_380px]">
        <div className="space-y-4">
          <FarmMap office={office} geometry={farm.geometry} />
          <Section title="Monthly report">
            <ReportEditor farmId={farm.id} report={farm.report} audience={farm.audience} />
          </Section>
        </div>
        <Section title={`Computed stats${stats ? `, last ${stats.period_days} days` : ''}`}>
          {stats ? (
            <table className="w-full text-sm tabular" data-testid="farm-stats">
              <tbody>
                {ROWS.map(([key, label, fmt]) => (
                  <tr key={key} className="border-t border-line first:border-0">
                    <td className="py-1.5 text-ink2">{label}</td>
                    <td className="py-1.5 text-right font-medium">{stats[key] === null || stats[key] === undefined ? '–' : fmt(stats[key] as number)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-sm text-ink2">Stats are computed when a report is drafted.</p>
          )}
          <p className="mt-3 text-xs text-muted">From replicated MLS data: ST_Within over listing points, medians by percentile_cont, prices rounded to the nearest $1,000.</p>
        </Section>
      </div>
    </>
  );
}
