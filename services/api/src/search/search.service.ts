import { createHash } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { AiClient, ParseResult } from '../common/ai-client';
import { RedisService } from '../common/redis.service';
import { Db } from '../db/db.service';
import { emptyFilters, normalizeFilters, SearchFilters } from './filters';
import { OpenSearchService } from './opensearch.service';
import { BBox, buildSearchBody } from './query-builder';
import { Tenant } from './tenants.service';

export const SearchRequest = z.object({
  q: z.string().trim().max(200).optional(),
  filters: SearchFilters.partial().optional(),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
  zoom: z.number().min(0).max(22).optional(),
  page: z.number().int().min(0).max(50).default(0),
  size: z.number().int().min(1).max(300).default(24),
});
export type SearchRequest = z.infer<typeof SearchRequest>;

const PARSE_CACHE_TTL = 24 * 3600;

export function parseCacheKey(q: string, previous: SearchFilters | null, markets: string[]): string {
  const normalized = q.toLowerCase().replace(/\s+/g, ' ').trim();
  const digest = createHash('sha1').update(JSON.stringify({ normalized, previous, markets })).digest('hex');
  return `nlq:v1:${digest}`;
}

@Injectable()
export class SearchService {
  private readonly log = new Logger('search');

  constructor(
    private readonly os: OpenSearchService,
    private readonly ai: AiClient,
    private readonly redis: RedisService,
    private readonly db: Db,
  ) {}

  /**
   * The parse result is cached by normalized query text plus the filter state it refines,
   * so a repeated "3 bed under 600k" costs one Redis read instead of a model call.
   */
  async interpret(q: string, previous: SearchFilters | null, markets: string[]): Promise<ParseResult & { cached: boolean; parse_ms: number }> {
    const started = performance.now();
    const key = parseCacheKey(q, previous, markets);
    const cached = await this.redis.getJson<ParseResult>(key);
    if (cached) return { ...cached, cached: true, parse_ms: Math.round(performance.now() - started) };
    const parsed = await this.ai.parseSearch(q, previous, markets);
    await this.redis.setJson(key, parsed, PARSE_CACHE_TTL);
    return { ...parsed, cached: false, parse_ms: Math.round(performance.now() - started) };
  }

  async search(tenant: Tenant, req: SearchRequest) {
    const started = performance.now();
    const current = req.filters ? SearchFilters.parse(req.filters) : emptyFilters();
    let interpretation: (ParseResult & { cached: boolean; parse_ms: number }) | null = null;
    let filters = current;
    if (req.q) {
      interpretation = await this.interpret(req.q, req.filters ? current : null, tenant.mls_codes);
      // The parse result must satisfy the same contract as anything else; it is not trusted.
      filters = SearchFilters.parse(interpretation.filters);
    }
    filters = normalizeFilters(filters);

    const body = buildSearchBody(filters, {
      mlsCodes: tenant.mls_codes,
      bbox: req.bbox as BBox | undefined,
      zoom: req.zoom,
      size: req.size,
      from: req.page * req.size,
    });
    const res = await this.os.search(body);
    const results = res.hits.hits.map((h) => toCard(h._source));
    const clusters =
      res.aggregations?.clusters?.buckets?.map((b: any) => ({
        key: b.key,
        count: b.doc_count,
        lat: b.centroid.location.lat,
        lon: b.centroid.location.lon,
        min_price: b.min_price.value,
      })) ?? null;
    const tookMs = Math.round(performance.now() - started);

    void this.db
      .withTenant(tenant.id, (tx) =>
        tx.query(
          'INSERT INTO search_log (tenant_id, query_text, parser, took_ms, parse_ms, total) VALUES ($1, $2, $3, $4, $5, $6)',
          [tenant.id, req.q ?? null, interpretation ? interpretation.parser : 'filters', tookMs, interpretation?.parse_ms ?? null, res.hits.total.value],
        ),
      )
      .catch((err) => this.log.warn(`search_log write failed: ${err.message}`));

    return {
      filters,
      interpretation: interpretation && {
        parser: interpretation.parser,
        coverage: interpretation.coverage,
        notices: interpretation.notices,
        unresolved: interpretation.unresolved,
        cached: interpretation.cached,
        parse_ms: interpretation.parse_ms,
        model: interpretation.model,
      },
      total: res.hits.total.value,
      took_ms: tookMs,
      engine_ms: res.took,
      results,
      clusters,
    };
  }
}

export function toCard(s: Record<string, any>) {
  return {
    id: s.id,
    mls: s.mls,
    status: s.status,
    sub_type: s.sub_type,
    price: s.price,
    original_price: s.original_price,
    price_reduced: s.price_reduced,
    beds: s.beds,
    baths: s.baths,
    sqft: s.sqft,
    address: s.display_address ? s.address : null,
    neighborhood: s.neighborhood,
    city: s.city,
    location: s.location,
    list_date: s.list_date,
    photos_count: s.photos_count,
    features: (s.features ?? []).slice(0, 4),
    office: s.office,
  };
}
