import Link from 'next/link';
import { notFound } from 'next/navigation';
import HomeArt from '@/components/HomeArt';
import LeadForm from '@/components/LeadForm';
import { baths, FEATURE_LABELS, money, STATUS_LABELS } from '@/lib/format';
import { api } from '@/lib/server-api';
import type { Feature, Office } from '@/lib/types';

export const dynamic = 'force-dynamic';

interface Listing {
  id: string;
  mls_name: string;
  listing_id: string;
  status: string;
  property_sub_type: string | null;
  list_price: number;
  original_list_price: number | null;
  beds: number | null;
  baths: number | null;
  living_area_sqft: number | null;
  lot_acres: number | null;
  year_built: number | null;
  address: string | null;
  city: string;
  neighborhood: string | null;
  remarks: string | null;
  features: string[];
  association_fee: number | null;
  days_on_market: number | null;
  attribution: { text: string; feed_updated_at: string | null };
  insight: {
    body: string;
    model: string;
    stats: Record<string, number | null>;
    validation: { ok: boolean; numbers: { text: string; matched: boolean }[] };
  } | null;
}

const TYPE = { single_family: 'Single-family home', condo: 'Condominium', townhouse: 'Townhouse' } as Record<string, string>;

export default async function ListingPage({ params }: { params: Promise<{ office: string; id: string }> }) {
  const { office: slug, id } = await params;
  const [office, listing] = await Promise.all([
    api<Office>(`/v1/t/${encodeURIComponent(slug)}`).catch(() => null),
    api<Listing>(`/v1/t/${encodeURIComponent(slug)}/listings/${encodeURIComponent(id)}`).catch(() => null),
  ]);
  if (!office || !listing) notFound();
  const reduced = listing.original_list_price && listing.original_list_price > listing.list_price;
  const insight = listing.insight;
  const checked = insight?.validation.numbers.filter((n) => n.matched).length ?? 0;

  return (
    <main className="mx-auto max-w-5xl pb-16">
      <div className="h-1" style={{ background: office.brand_color }} />
      <div className="flex items-center justify-between px-4 py-3">
        <Link href={`/s/${office.slug}`} className="text-sm font-semibold text-accent">← Back to search</Link>
        <span className="text-sm text-muted">{office.name}</span>
      </div>
      <HomeArt id={listing.id} subType={listing.property_sub_type} className="h-56 w-full md:h-80 md:rounded-2xl" />
      <div className="grid gap-6 px-4 pt-4 md:grid-cols-[1fr_340px]">
        <div>
          <div className="flex flex-wrap items-baseline gap-3">
            <h1 className="text-3xl font-bold tracking-tight">{money(listing.list_price)}</h1>
            {reduced && <span className="text-sm text-ink2 line-through">{money(listing.original_list_price)}</span>}
            <span className="rounded bg-page px-2 py-0.5 text-xs font-medium text-ink2">{STATUS_LABELS[listing.status] ?? listing.status}</span>
          </div>
          <p className="mt-1 text-lg">{listing.address ?? 'Address withheld by seller'}</p>
          <p className="text-ink2">{listing.neighborhood}, {listing.city}</p>
          <dl className="mt-4 grid grid-cols-3 gap-2 text-center sm:grid-cols-6">
            {[
              ['Beds', listing.beds],
              ['Baths', baths(listing.baths)],
              ['Sq ft', listing.living_area_sqft?.toLocaleString('en-US')],
              ['Lot (ac)', listing.lot_acres || '–'],
              ['Built', listing.year_built],
              ['Days listed', listing.days_on_market],
            ].map(([k, v]) => (
              <div key={String(k)} className="card px-2 py-2">
                <dt className="text-[11px] text-muted">{k}</dt>
                <dd className="font-semibold">{v ?? '–'}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-4 text-sm text-ink2">{TYPE[listing.property_sub_type ?? ''] ?? 'Home'}{listing.association_fee ? ` · HOA ${money(listing.association_fee)}/mo` : ''}</p>
          {listing.features.length > 0 && (
            <ul className="mt-3 flex flex-wrap gap-2">
              {listing.features.map((f) => <li key={f} className="chip">{FEATURE_LABELS[f as Feature] ?? f}</li>)}
            </ul>
          )}
          <p className="mt-4 leading-relaxed">{listing.remarks}</p>

          {insight && (
            <section className="card mt-6 p-4" aria-labelledby="insight">
              <div className="flex items-center justify-between gap-2">
                <h2 id="insight" className="font-semibold">{listing.neighborhood} market</h2>
                <span className="text-xs text-muted">{insight.validation.ok ? `${checked} figures checked against the data` : 'Held for review'}</span>
              </div>
              <p className="mt-2 text-sm leading-relaxed text-ink2">{insight.body}</p>
              <p className="mt-2 text-[11px] text-muted">Figures computed from listing data for the last {insight.stats.period_days} days; wording by {insight.model}.</p>
            </section>
          )}

          <footer className="mt-6 border-t border-line pt-3 text-xs text-muted">
            <p>{listing.attribution.text} MLS #{listing.listing_id}.</p>
            <p>Data last updated {listing.attribution.feed_updated_at ? new Date(listing.attribution.feed_updated_at).toLocaleString('en-US') : 'recently'}. Information deemed reliable but not guaranteed.</p>
          </footer>
        </div>
        <aside className="md:sticky md:top-4 md:self-start">
          <div className="card p-4">
            <h2 className="font-semibold">Ask about this home</h2>
            <p className="mb-3 text-sm text-ink2">An agent from {office.name} will text you back.</p>
            <LeadForm office={office.slug} listingId={listing.id} cta="Text me about this home" />
          </div>
        </aside>
      </div>
    </main>
  );
}
