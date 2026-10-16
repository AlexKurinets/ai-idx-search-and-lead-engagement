'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useRef, useState } from 'react';
import { chipsFor, isRefinement } from '@/lib/format';
import type { Office, SearchFilters, SearchResponse } from '@/lib/types';
import LeadForm from './LeadForm';
import ListingCard from './ListingCard';
import type { GeoPayload } from './SearchMap';

const SearchMap = dynamic(() => import('./SearchMap'), { ssr: false, loading: () => <div className="h-full w-full animate-pulse bg-[var(--map-bg)]" /> });

const EXAMPLES = ['3 bed under 600k near the river with a yard', 'condo with river views under 450k', 'new listings with a pool'];

export default function SearchApp({ office }: { office: Office }) {
  const [q, setQ] = useState('');
  const [data, setData] = useState<SearchResponse | null>(null);
  const [filters, setFilters] = useState<SearchFilters | null>(null);
  const [geo, setGeo] = useState<GeoPayload | null>(null);
  const [view, setView] = useState<'list' | 'map'>('list');
  const [loading, setLoading] = useState(false);
  const [lastQuery, setLastQuery] = useState<{ text: string; refined: boolean } | null>(null);
  const [fitKey, setFitKey] = useState<string>();
  const [selected, setSelected] = useState<string | null>(null);
  const [interpretation, setInterpretation] = useState<SearchResponse['interpretation']>(null);
  const [saving, setSaving] = useState(false);
  const viewport = useRef<{ bbox?: [number, number, number, number]; zoom: number }>({ zoom: 11.3 });
  const seq = useRef(0);

  const run = useCallback(
    async (opts: { q?: string; filters?: SearchFilters | null; useViewport: boolean; fit?: boolean }) => {
      const id = ++seq.current;
      setLoading(true);
      const body: Record<string, unknown> = { size: 60, zoom: viewport.current.zoom };
      if (opts.q) body.q = opts.q;
      if (opts.filters) body.filters = opts.filters;
      if (opts.useViewport && viewport.current.bbox) body.bbox = viewport.current.bbox;
      const res = await fetch(`/api/v1/t/${office.slug}/search`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (id !== seq.current) return;
      setLoading(false);
      if (!res.ok) return;
      const json = (await res.json()) as SearchResponse;
      setData(json);
      setFilters(json.filters);
      // A pan or zoom re-runs the same filters; keep showing how the sentence was read.
      if (opts.q) setInterpretation(json.interpretation);
      else if (!opts.useViewport) setInterpretation(null);
      if (opts.fit) setFitKey(`${id}`);
    },
    [office.slug],
  );

  useEffect(() => {
    void run({ useViewport: false, fit: false });
    fetch(`/api/v1/t/${office.slug}/geo`).then((r) => r.json()).then(setGeo).catch(() => undefined);
  }, [office.slug, run]);

  function submit(e?: React.FormEvent) {
    e?.preventDefault();
    const text = q.trim();
    if (!text) return;
    const refined = isRefinement(text, !!filters && chipsFor(filters).length > 0);
    setLastQuery({ text, refined });
    void run({ q: text, filters: refined ? filters : null, useViewport: false, fit: true });
    setQ('');
  }

  function editFilters(next: SearchFilters) {
    setFilters(next);
    void run({ filters: next, useViewport: false, fit: true });
  }

  const chips = filters ? chipsFor(filters) : [];
  const it = interpretation;
  const fairHousing = it?.notices.includes('fair_housing');

  return (
    <div className="flex h-[100dvh] flex-col">
      <header className="flex-none border-b border-line bg-surface">
        <div className="h-1" style={{ background: office.brand_color }} />
        <div className="mx-auto flex max-w-screen-2xl items-center justify-between px-4 py-2">
          <div>
            <p className="text-sm font-semibold">{office.name}</p>
            <p className="text-xs text-muted">Homes for sale in {office.city}</p>
          </div>
          <a href="/" className="text-xs text-muted underline">All offices</a>
        </div>
        <form onSubmit={submit} className="mx-auto max-w-screen-2xl px-4 pb-2">
          <label htmlFor="q" className="sr-only">Describe the home you want</label>
          <div className="flex gap-2">
            <input
              id="q"
              className="input text-base"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={filters && chips.length ? 'Refine: "cheaper", "with a pool"…' : `Try "${EXAMPLES[0]}"`}
              autoComplete="off"
              enterKeyHint="search"
            />
            <button className="btn flex-none" aria-label="Search">Search</button>
          </div>
        </form>
        <div className="mx-auto max-w-screen-2xl px-4 pb-2">
          {chips.length > 0 ? (
            <div className="flex items-center gap-2 overflow-x-auto pb-1" aria-label="Search filters">
              {chips.map((c) => (
                <button key={c.key} type="button" className="chip hover:border-accent" onClick={() => filters && editFilters(c.remove(filters))} aria-label={`Remove ${c.label}`}>
                  {c.label} <span aria-hidden className="text-muted">×</span>
                </button>
              ))}
              <button type="button" className="whitespace-nowrap px-2 text-sm text-muted underline" onClick={() => { setLastQuery(null); void run({ useViewport: false, fit: true }); }}>
                Clear
              </button>
            </div>
          ) : (
            <div className="flex gap-2 overflow-x-auto pb-1">
              {EXAMPLES.map((ex) => (
                <button key={ex} type="button" className="chip text-ink2 hover:border-accent" onClick={() => { setLastQuery({ text: ex, refined: false }); void run({ q: ex, useViewport: false, fit: true }); }}>
                  {ex}
                </button>
              ))}
            </div>
          )}
          {it && lastQuery && (
            <p className="mt-1 text-xs text-muted" data-testid="interpretation">
              {lastQuery.refined ? 'Refined' : 'Read'} “{lastQuery.text}” with {it.parser === 'rules' ? 'rules only, no model call' : `rules plus the model adapter (${it.model})`}
              {' · '}{Math.round(it.coverage * 100)}% of words explained{it.cached ? ' · cached' : ''} · {data?.took_ms} ms
              {it.unresolved.length > 0 && ` · not understood: ${it.unresolved.join(', ')}`}
            </p>
          )}
          {fairHousing && (
            <p className="mt-2 rounded-lg border border-line bg-raised p-2 text-xs text-ink2" role="note">
              Searches can&apos;t filter by safety, schools, or who lives in an area. Try a place, a distance, or the features you want, and your agent can point you to public data.
            </p>
          )}
        </div>
      </header>

      <div className="relative mx-auto flex min-h-0 w-full max-w-screen-2xl flex-1">
        <section className={`${view === 'list' ? 'flex' : 'hidden'} min-h-0 w-full flex-col md:flex md:w-[440px] md:flex-none md:border-r md:border-line`}>
          <div className="flex items-center justify-between px-4 py-2 text-sm">
            <span className="text-ink2" aria-live="polite">
              {loading ? 'Searching…' : `${(data?.total ?? 0).toLocaleString('en-US')} homes`}
            </span>
            {chips.length > 0 && (
              <button type="button" className="text-sm font-semibold text-accent" onClick={() => setSaving(true)}>
                Save search
              </button>
            )}
          </div>
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 pb-24">
            {data?.results.map((card) => <ListingCard key={card.id} office={office.slug} card={card} selected={card.id === selected} />)}
            {data && data.results.length === 0 && <p className="card p-4 text-sm text-ink2">No homes match. Remove a filter above to widen the search.</p>}
          </div>
        </section>
        <section className={`${view === 'map' ? 'block' : 'hidden'} min-h-0 flex-1 md:block`}>
          <SearchMap
            geo={geo}
            center={office.center ?? [-77.9, 35.4]}
            results={data?.results ?? []}
            clusters={data?.clusters ?? null}
            fitKey={fitKey}
            onViewport={(bbox, zoom) => {
              viewport.current = { bbox, zoom };
              void run({ filters, useViewport: true });
            }}
            onSelect={(id) => {
              setSelected(id);
              setView('list');
              requestAnimationFrame(() => document.getElementById(`card-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
            }}
          />
        </section>
        <div className="fixed bottom-5 left-1/2 z-20 flex -translate-x-1/2 overflow-hidden rounded-full border border-line bg-raised shadow-lg md:hidden">
          {(['list', 'map'] as const).map((v) => (
            <button key={v} type="button" onClick={() => setView(v)} className={`px-5 py-2 text-sm font-semibold ${view === v ? 'bg-accent text-accent-ink' : 'text-ink'}`}>
              {v === 'list' ? 'List' : 'Map'}
            </button>
          ))}
        </div>
      </div>

      {saving && filters && (
        <div className="fixed inset-0 z-30 flex items-end justify-center bg-black/40 p-0 md:items-center md:p-6" role="dialog" aria-modal="true" aria-label="Save this search">
          <div className="w-full max-w-md rounded-t-2xl bg-surface p-5 md:rounded-2xl">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-semibold">Get texts when new homes match</h2>
              <button type="button" className="text-muted" onClick={() => setSaving(false)} aria-label="Close">✕</button>
            </div>
            <p className="mb-3 text-sm text-ink2">{chips.map((c) => c.label).join(' · ')}</p>
            <LeadForm office={office.slug} cta="Save search" savedSearch={{ name: chips.slice(0, 3).map((c) => c.label).join(', '), query_text: lastQuery?.text, filters }} />
          </div>
        </div>
      )}
    </div>
  );
}
