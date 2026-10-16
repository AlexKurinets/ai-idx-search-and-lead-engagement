import { Controller, Get, Post, HttpCode, UseGuards } from '@nestjs/common';
import { PlatformGuard } from '../auth/auth';
import { AiClient } from '../common/ai-client';
import { RedisService } from '../common/redis.service';
import { Db } from '../db/db.service';
import { KafkaService } from '../events/kafka.service';
import { OpenSearchService } from '../search/opensearch.service';

/** Platform operations: replication health, pipeline lag, search latency and quality. */
@Controller('v1/ops')
@UseGuards(PlatformGuard)
export class OpsController {
  constructor(
    private readonly db: Db,
    private readonly os: OpenSearchService,
    private readonly kafka: KafkaService,
    private readonly ai: AiClient,
    private readonly redis: RedisService,
  ) {}

  @Get('pipeline')
  async pipeline() {
    const markets = await this.db.platformQuery(`
      SELECT m.code, m.name, m.city, rs.cursor_ts, rs.cursor_key, rs.backfill_complete, rs.records_total, rs.throttled_total,
             rs.last_run_at, rs.last_success_at, rs.last_error, rs.last_reconcile_at, rs.removed_by_reconcile,
             (SELECT count(*)::int FROM listings l WHERE l.mls_code = m.code AND l.removed_at IS NULL
                AND l.status IN ('Active', 'ComingSoon', 'ActiveUnderContract', 'Pending')) AS on_market,
             (SELECT count(*)::int FROM listings l WHERE l.mls_code = m.code AND l.removed_at IS NULL AND l.status = 'Closed') AS closed,
             (SELECT count(*)::int FROM listings l WHERE l.mls_code = m.code AND l.removed_at IS NULL AND l.status = 'Unmapped') AS unmapped,
             (SELECT count(*)::int FROM listings l WHERE l.mls_code = m.code AND l.removed_at IS NULL AND NOT l.idx_entire) AS idx_suppressed
      FROM mls_sources m JOIN replication_state rs ON rs.mls_code = m.code ORDER BY m.code`);
    const lag = await this.db.platformQuery(`
      SELECT mls_code, count(*)::int AS samples,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM indexed_at - mls_modified_at)) AS p50_s,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM indexed_at - mls_modified_at)) AS p95_s,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM indexed_at - replicated_at)) AS p95_index_s
      FROM pipeline_lag_samples WHERE indexed_at > now() - interval '60 minutes' GROUP BY mls_code`);
    const runs = await this.db.platformQuery(`
      SELECT DISTINCT ON (mls_code, kind) mls_code, kind, started_at, finished_at, pages, records, throttled, removed, error
      FROM replication_runs WHERE kind <> 'incremental' OR records > 0
      ORDER BY mls_code, kind, started_at DESC`);
    const recent = await this.db.platformQuery(`
      SELECT mls_code, count(*)::int AS runs, coalesce(sum(records), 0)::int AS records, coalesce(sum(throttled), 0)::int AS throttled
      FROM replication_runs WHERE started_at > now() - interval '60 minutes' AND kind = 'incremental' GROUP BY mls_code`);
    const issues = await this.db.platformQuery(
      'SELECT mls_code, field, value, occurrences, sample_listing_key, first_seen, last_seen FROM mapping_issues ORDER BY occurrences DESC',
    );
    const [outbox] = await this.db.platformQuery(`
      SELECT count(*)::int AS backlog, extract(epoch FROM now() - min(created_at)) AS oldest_s,
        (SELECT count(*)::int FROM outbox WHERE published_at > now() - interval '60 minutes') AS published_60m
      FROM outbox WHERE published_at IS NULL`);
    const [search] = await this.db.platformQuery(`
      SELECT count(*)::int AS searches,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY took_ms) AS p50_ms,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY took_ms) AS p95_ms,
        count(*) FILTER (WHERE query_text IS NOT NULL)::int AS nl_searches,
        count(*) FILTER (WHERE parser = 'rules')::int AS rules_only,
        count(*) FILTER (WHERE parser = 'rules+model')::int AS model_assisted
      FROM search_log WHERE created_at > now() - interval '24 hours'`);
    const [indexed, indexerLag, engagementLag] = await Promise.all([
      this.os.count(),
      this.kafka.groupLag('indexer', 'listing.events'),
      this.kafka.groupLag('engagement', 'engagement.events'),
    ]);
    const lagBy = new Map(lag.map((r) => [r.mls_code, r]));
    const recentBy = new Map(recent.map((r) => [r.mls_code, r]));
    return {
      markets: markets.map((m) => ({
        ...m,
        lag: lagBy.get(m.code) ?? null,
        last_hour: recentBy.get(m.code) ?? { runs: 0, records: 0, throttled: 0 },
        runs: runs.filter((r) => r.mls_code === m.code),
        issues: issues.filter((i) => i.mls_code === m.code),
      })),
      totals: {
        on_market: markets.reduce((s, m) => s + m.on_market, 0),
        indexed,
      },
      outbox,
      consumer_lag: { indexer: indexerLag, engagement: engagementLag },
      search,
    };
  }

  @Get('search-quality')
  async searchQuality() {
    const cached = await this.redis.getJson<Record<string, unknown>>('ops:nl-eval');
    if (cached) return cached;
    return this.runEval();
  }

  @Post('search-quality/run')
  @HttpCode(200)
  async runEval() {
    const result = { ...(await this.ai.nlSearchEval()), ran_at: new Date().toISOString() };
    await this.redis.setJson('ops:nl-eval', result, 3600);
    return result;
  }
}
