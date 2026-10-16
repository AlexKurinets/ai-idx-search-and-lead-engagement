import { SearchFilters } from './filters';

export type BBox = [west: number, south: number, east: number, north: number];

export interface SearchContext {
  /** MLS feeds the tenant participates in. IDX display is limited to these. */
  mlsCodes: string[];
  bbox?: BBox;
  zoom?: number;
  size: number;
  from: number;
}

/** Below this zoom the map gets server-side clusters instead of individual pins. */
export const CLUSTER_ZOOM = 14;

/** Filters shared by search and saved-search percolation (no viewport, no tenant scope). */
export function filterClauses(f: SearchFilters): object[] {
  const clauses: object[] = [{ terms: { status: f.statuses } }];
  if (f.price_min !== null || f.price_max !== null) {
    clauses.push({ range: { price: { ...(f.price_min !== null && { gte: f.price_min }), ...(f.price_max !== null && { lte: f.price_max }) } } });
  }
  if (f.beds_min !== null) clauses.push({ range: { beds: { gte: f.beds_min } } });
  if (f.baths_min !== null) clauses.push({ range: { baths: { gte: f.baths_min } } });
  if (f.sqft_min !== null) clauses.push({ range: { sqft: { gte: f.sqft_min } } });
  if (f.property_types.length) clauses.push({ terms: { sub_type: f.property_types } });
  for (const feature of f.features) clauses.push({ term: { features: feature } });
  if (f.location) {
    const field = { neighborhood: 'neighborhood_id', place: 'place_ids', city: 'mls' }[f.location.kind];
    clauses.push({ term: { [field]: f.location.id } });
  }
  if (f.max_days_on_market !== null) clauses.push({ range: { list_date: { gte: `now-${f.max_days_on_market}d/d` } } });
  if (f.sort === 'price_drop') clauses.push({ term: { price_reduced: true } });
  return clauses;
}

function keywordQuery(f: SearchFilters): object | null {
  if (!f.keywords.length) return null;
  return {
    bool: {
      should: f.keywords.flatMap((k) => [
        { match_phrase: { remarks: { query: k, slop: 2, boost: 2 } } },
        { match: { remarks: { query: k } } },
      ]),
    },
  };
}

const SORT: Record<SearchFilters['sort'], object[]> = {
  relevance: [{ _score: 'desc' }, { list_date: 'desc' }],
  newest: [{ list_date: 'desc' }],
  price_asc: [{ price: 'asc' }],
  price_desc: [{ price: 'desc' }],
  price_drop: [{ price_change_at: { order: 'desc', missing: '_last' } }],
};

/**
 * Builds the OpenSearch request. Hard filters go in `filter` context (exact, cached,
 * no scoring); soft preferences only influence ranking. Tenant MLS scope and the IDX
 * display flag are always present, so no parse result can widen what a tenant may show.
 */
export function buildSearchBody(f: SearchFilters, ctx: SearchContext): Record<string, unknown> {
  const filter: object[] = [
    { terms: { mls: ctx.mlsCodes } },
    { term: { idx_entire: true } },
    ...filterClauses(f),
  ];
  if (ctx.bbox) {
    const [w, s, e, n] = ctx.bbox;
    filter.push({ geo_bounding_box: { location: { top_left: { lat: n, lon: w }, bottom_right: { lat: s, lon: e } } } });
  }
  const kw = keywordQuery(f);
  const body: Record<string, unknown> = {
    track_total_hits: true,
    from: ctx.from,
    size: ctx.size,
    query: { bool: { filter, ...(kw && { should: [kw] }) } },
    sort: SORT[f.sort === 'relevance' && !kw ? 'newest' : f.sort],
    _source: { excludes: ['remarks'] },
  };
  if (ctx.zoom !== undefined && ctx.zoom < CLUSTER_ZOOM) {
    body.aggs = {
      clusters: {
        geotile_grid: { field: 'location', precision: Math.max(1, Math.min(18, Math.round(ctx.zoom) + 2)), size: 400 },
        aggs: { centroid: { geo_centroid: { field: 'location' } }, min_price: { min: { field: 'price' } } },
      },
    };
  }
  return body;
}

/**
 * The percolator query stored for a saved search: the same filters and MLS scope. The
 * days-on-market window is dropped because alerts fire on new listings anyway, and a
 * stored query should not depend on when it was saved.
 */
export function percolatorQuery(f: SearchFilters, mlsCodes: string[]): object {
  const clauses = filterClauses({ ...f, max_days_on_market: null });
  return { bool: { filter: [{ terms: { mls: mlsCodes } }, { term: { idx_entire: true } }, ...clauses] } };
}
