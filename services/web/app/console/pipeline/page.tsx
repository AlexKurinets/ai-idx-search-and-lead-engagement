import { Empty, PageHeader, Section, StatTile } from '@/components/ui';
import { ago, seconds } from '@/lib/format';
import { api } from '@/lib/server-api';

export const dynamic = 'force-dynamic';

interface Market {
  code: string; name: string; city: string; cursor_ts: string; cursor_key: string; backfill_complete: boolean;
  records_total: number; throttled_total: number; last_success_at: string | null; last_error: string | null;
  last_reconcile_at: string | null; removed_by_reconcile: number; on_market: number; closed: number; unmapped: number;
  idx_suppressed: number;
  lag: { samples: number; p50_s: number; p95_s: number; p95_index_s: number } | null;
  last_hour: { runs: number; records: number; throttled: number };
  issues: { field: string; value: string; occurrences: number; sample_listing_key: string }[];
}

interface Pipeline {
  markets: Market[];
  totals: { on_market: number; indexed: number | null };
  outbox: { backlog: number; oldest_s: number | null; published_60m: number };
  consumer_lag: { indexer: number | null; engagement: number | null };
  search: { searches: number; p50_ms: number | null; p95_ms: number | null; nl_searches: number; rules_only: number; model_assisted: number };
}

interface Eval {
  cases: number; passed: number; accuracy: number; rules_only_share: number; mean_parse_ms: number; model: string; ran_at: string;
  by_parser: Record<string, { cases: number; passed: number }>;
  failures: { q: string; parser: string; wrong: Record<string, { expected: unknown; got: unknown }> }[];
}

export default async function PipelinePage() {
  const [p, ev] = await Promise.all([
    api<Pipeline>('/v1/ops/pipeline', { auth: 'platform' }),
    api<Eval>('/v1/ops/search-quality', { auth: 'platform' }).catch(() => null),
  ]);
  const nl = p.search.nl_searches || 1;
  return (
    <>
      <PageHeader
        title="IDX pipeline"
        sub="RESO Web API replication from three MLS feeds into Postgres, through the outbox and Kafka into OpenSearch. Platform view across all offices."
      />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatTile testId="on-market" label="On-market listings" value={p.totals.on_market.toLocaleString('en-US')} sub={`${(p.totals.indexed ?? 0).toLocaleString('en-US')} in the search index`} />
        <StatTile label="Outbox backlog" value={p.outbox.backlog.toLocaleString('en-US')} sub={`${p.outbox.published_60m.toLocaleString('en-US')} events published, last hour`} />
        <StatTile label="Indexer consumer lag" value={p.consumer_lag.indexer ?? '–'} sub="Kafka messages behind" />
        <StatTile label="Search p95" value={p.search.p95_ms === null ? '–' : `${Math.round(p.search.p95_ms)} ms`} sub={`p50 ${p.search.p50_ms === null ? '–' : Math.round(p.search.p50_ms)} ms · ${p.search.searches} searches, 24h`} />
        <StatTile label="Parsed by rules alone" value={`${Math.round((p.search.rules_only / nl) * 100)}%`} sub={`${p.search.model_assisted} of ${p.search.nl_searches} needed the model adapter`} />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        {p.markets.map((m) => (
          <Section key={m.code} title={`${m.name}`} right={<span className="text-xs text-muted">{m.code} · {m.city}</span>}>
            <dl className="grid grid-cols-2 gap-y-1.5 text-sm tabular" data-testid={`market-${m.code}`}>
              <dt className="text-muted">On market</dt><dd className="text-right font-medium">{m.on_market.toLocaleString('en-US')}</dd>
              <dt className="text-muted">Change to searchable, p95</dt><dd className="text-right font-medium">{m.lag ? seconds(m.lag.p95_s) : '–'}</dd>
              <dt className="text-muted">p50</dt><dd className="text-right">{m.lag ? seconds(m.lag.p50_s) : '–'}</dd>
              <dt className="text-muted">Samples, last hour</dt><dd className="text-right">{m.lag?.samples ?? 0}</dd>
              <dt className="text-muted">Records, last hour</dt><dd className="text-right">{m.last_hour.records.toLocaleString('en-US')} in {m.last_hour.runs} runs</dd>
              <dt className="text-muted">429s honored</dt><dd className="text-right">{m.throttled_total}</dd>
              <dt className="text-muted">Removed by reconcile</dt><dd className="text-right">{m.removed_by_reconcile}</dd>
              <dt className="text-muted">IDX display off</dt><dd className="text-right">{m.idx_suppressed}</dd>
              <dt className="text-muted">Last success</dt><dd className="text-right">{ago(m.last_success_at)}</dd>
            </dl>
            <div className="mt-3 rounded-lg bg-page p-2 text-[11px] text-ink2">
              <p className="font-semibold text-muted">Cursor</p>
              <p className="break-all font-mono">{m.cursor_ts} · {m.cursor_key}</p>
            </div>
            <div className="mt-3">
              <p className="text-xs font-semibold text-muted">Unmapped values</p>
              {m.issues.length === 0 ? (
                <p className="text-sm text-ink2">None. Every lookup value maps.</p>
              ) : (
                <ul className="mt-1 space-y-1 text-sm">
                  {m.issues.map((i) => (
                    <li key={`${i.field}${i.value}`} className="flex justify-between gap-2">
                      <span>{i.field} = “{i.value}”</span>
                      <span className="tabular text-ink2">{i.occurrences.toLocaleString('en-US')}× · held from display</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {m.last_error && <p className="mt-2 text-sm text-bad">Last error: {m.last_error}</p>}
          </Section>
        ))}
      </div>

      <div className="mt-4">
        <Section title="Natural-language search evaluation" right={ev && <span className="text-xs text-muted">ran {ago(ev.ran_at)} · {ev.model}</span>}>
          {!ev ? (
            <Empty>The evaluation has not run yet.</Empty>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <StatTile testId="eval-accuracy" label="Exact filter matches" value={`${(ev.accuracy * 100).toFixed(1)}%`} sub={`${ev.passed} of ${ev.cases} synthetic cases`} />
                {Object.entries(ev.by_parser).map(([k, v]) => (
                  <StatTile key={k} label={k === 'rules' ? 'Rules only' : 'Rules + model adapter'} value={`${v.passed}/${v.cases}`} sub={k === 'rules' ? 'no model call' : 'leftover words sent on'} />
                ))}
                <StatTile label="Mean parse time" value={`${ev.mean_parse_ms} ms`} sub="in-process, per query" />
              </div>
              <p className="mt-3 text-xs text-muted">The synthetic set was written alongside the rules, so it catches regressions; it does not measure real-world accuracy.</p>
              {ev.failures.length > 0 && (
                <details className="mt-3">
                  <summary className="cursor-pointer text-sm font-medium">{ev.failures.length} failing cases</summary>
                  <ul className="mt-2 space-y-1 text-sm">
                    {ev.failures.map((f) => (
                      <li key={f.q} className="rounded bg-page p-2">
                        <span className="font-medium">“{f.q}”</span>
                        <span className="text-ink2"> · {Object.entries(f.wrong).map(([k, w]) => `${k}: expected ${JSON.stringify(w.expected)}, got ${JSON.stringify(w.got)}`).join('; ')}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </>
          )}
        </Section>
      </div>
    </>
  );
}
