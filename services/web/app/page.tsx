import Link from 'next/link';
import { api } from '@/lib/server-api';
import type { Office } from '@/lib/types';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const offices = await api<Office[]>('/v1/offices').catch(() => [] as Office[]);
  const byCity = new Map<string, Office[]>();
  for (const o of offices) byCity.set(o.city, [...(byCity.get(o.city) ?? []), o]);

  return (
    <main className="mx-auto max-w-5xl px-4 py-10">
      <p className="label">Tallowmere Realty Group · synthetic data</p>
      <h1 className="mt-2 text-3xl font-bold tracking-tight">IDX search and lead engagement</h1>
      <p className="mt-3 max-w-2xl text-ink2">
        Each office runs its own branded, mobile-first search site over the MLS feeds it participates in. New leads
        get a text within seconds, and the agent console shows conversations, relationship health, farm-area reports
        and the replication pipeline.
      </p>
      <div className="mt-6 flex flex-wrap gap-3">
        <Link href="/console" className="btn">Open the agent console</Link>
        <Link href="/console/pipeline" className="btn-ghost">IDX pipeline</Link>
        <Link href="/console/phone" className="btn-ghost">Sandbox phone</Link>
      </div>

      {offices.length === 0 && (
        <p className="card mt-10 p-6 text-ink2">No offices yet. The seed service creates them once replication has finished its first pass.</p>
      )}
      <div className="mt-10 grid gap-6 md:grid-cols-3">
        {[...byCity.entries()].map(([city, list]) => (
          <section key={city} className="card p-5">
            <h2 className="font-semibold">{city}</h2>
            <ul className="mt-3 space-y-2">
              {list.map((o) => (
                <li key={o.slug}>
                  <Link href={`/s/${o.slug}`} className="flex items-center justify-between rounded-lg px-2 py-2 hover:bg-page">
                    <span className="flex items-center gap-2">
                      <span className="h-3 w-3 rounded-full" style={{ background: o.brand_color }} aria-hidden />
                      {o.name}
                    </span>
                    <span className="text-xs text-muted">{o.mls_codes.join(' + ')}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </main>
  );
}
