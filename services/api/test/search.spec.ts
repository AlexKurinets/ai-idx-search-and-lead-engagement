import { emptyFilters, normalizeFilters, SearchFilters } from '../src/search/filters';
import { buildSearchBody, CLUSTER_ZOOM, percolatorQuery } from '../src/search/query-builder';
import { parseCacheKey } from '../src/search/search.service';
import { isIndexable, toDocument } from '../src/search/opensearch.service';

const ctx = { mlsCodes: ['ECM'], size: 24, from: 0 };
const filterOf = (body: any) => body.query.bool.filter as any[];

describe('query builder', () => {
  it('always scopes to the tenant MLS feeds and the IDX display flag', () => {
    const body = buildSearchBody(emptyFilters(), ctx);
    expect(filterOf(body)).toEqual(
      expect.arrayContaining([{ terms: { mls: ['ECM'] } }, { term: { idx_entire: true } }, { terms: { status: ['Active', 'ComingSoon'] } }]),
    );
  });

  it('turns every filter into an exact clause and soft keywords into scoring only', () => {
    const f = SearchFilters.parse({
      price_min: 300000,
      price_max: 600000,
      beds_min: 3,
      baths_min: 2,
      sqft_min: 1500,
      property_types: ['single_family'],
      features: ['pool', 'large_yard'],
      location: { kind: 'place', id: 'ecm-ellery-river', name: 'Ellery River' },
      keywords: ['natural light'],
      max_days_on_market: 7,
    });
    const body = buildSearchBody(f, ctx) as any;
    const filter = filterOf(body);
    expect(filter).toEqual(
      expect.arrayContaining([
        { range: { price: { gte: 300000, lte: 600000 } } },
        { range: { beds: { gte: 3 } } },
        { range: { baths: { gte: 2 } } },
        { range: { sqft: { gte: 1500 } } },
        { terms: { sub_type: ['single_family'] } },
        { term: { features: 'pool' } },
        { term: { features: 'large_yard' } },
        { term: { place_ids: 'ecm-ellery-river' } },
        { range: { list_date: { gte: 'now-7d/d' } } },
      ]),
    );
    expect(JSON.stringify(filter)).not.toContain('natural light');
    expect(JSON.stringify(body.query.bool.should)).toContain('natural light');
    expect(body.sort[0]).toEqual({ _score: 'desc' });
  });

  it('maps each location kind to its indexed field', () => {
    const hood = buildSearchBody(SearchFilters.parse({ location: { kind: 'neighborhood', id: 'ecm-old-quay', name: 'Old Quay' } }), ctx);
    const city = buildSearchBody(SearchFilters.parse({ location: { kind: 'city', id: 'ECM', name: 'Port Ellery' } }), ctx);
    expect(filterOf(hood)).toContainEqual({ term: { neighborhood_id: 'ecm-old-quay' } });
    expect(filterOf(city)).toContainEqual({ term: { mls: 'ECM' } });
  });

  it('clusters below the cluster zoom and returns pins above it', () => {
    const low = buildSearchBody(emptyFilters(), { ...ctx, zoom: 11, bbox: [-78, 35, -77, 36] }) as any;
    expect(low.aggs.clusters.geotile_grid).toEqual({ field: 'location', precision: 13, size: 400 });
    expect(filterOf(low)).toContainEqual({
      geo_bounding_box: { location: { top_left: { lat: 36, lon: -78 }, bottom_right: { lat: 35, lon: -77 } } },
    });
    const high = buildSearchBody(emptyFilters(), { ...ctx, zoom: CLUSTER_ZOOM }) as any;
    expect(high.aggs).toBeUndefined();
  });

  it('sorts price drops by the price change time and only returns reduced listings', () => {
    const body = buildSearchBody(SearchFilters.parse({ sort: 'price_drop' }), ctx) as any;
    expect(filterOf(body)).toContainEqual({ term: { price_reduced: true } });
    expect(body.sort[0]).toEqual({ price_change_at: { order: 'desc', missing: '_last' } });
  });

  it('stores saved searches as percolator queries without relative dates', () => {
    const q = percolatorQuery(SearchFilters.parse({ beds_min: 3, max_days_on_market: 7 }), ['ECM']) as any;
    expect(JSON.stringify(q)).not.toContain('now-');
    expect(q.bool.filter).toContainEqual({ range: { beds: { gte: 3 } } });
  });
});

describe('filter contract', () => {
  it('rejects values outside the schema', () => {
    expect(SearchFilters.safeParse({ beds_min: 40 }).success).toBe(false);
    expect(SearchFilters.safeParse({ features: ['helipad'] }).success).toBe(false);
    expect(SearchFilters.safeParse({ location: { kind: 'zip', id: '1', name: 'x' } }).success).toBe(false);
  });

  it('normalizes an inverted price range and duplicate terms', () => {
    const f = normalizeFilters(SearchFilters.parse({ price_min: 600000, price_max: 400000, features: ['pool', 'pool'], keywords: ['Quiet', 'quiet'] }));
    expect([f.price_min, f.price_max]).toEqual([400000, 600000]);
    expect(f.features).toEqual(['pool']);
    expect(f.keywords).toEqual(['quiet']);
  });

  it('caches parses by normalized text and the state they refine', () => {
    const a = parseCacheKey('3 Bed  under 600k', null, ['ECM']);
    expect(parseCacheKey('3 bed under 600k', null, ['ECM'])).toBe(a);
    expect(parseCacheKey('3 bed under 600k', emptyFilters(), ['ECM'])).not.toBe(a);
    expect(parseCacheKey('3 bed under 600k', null, ['BVM'])).not.toBe(a);
  });
});

describe('listing documents', () => {
  const row = {
    id: 'l1', mls_code: 'ECM', listing_key: 'K', status: 'Active', property_sub_type: 'condo', list_price: 400000,
    original_list_price: 420000, price_change_ts: new Date(), beds: 2, baths: 2, living_area_sqft: 1100, lot_acres: 0,
    year_built: 2001, address_line: '1 Pier Row', idx_address: false, idx_entire: true, city: 'Port Ellery',
    neighborhood_id: 'ecm-old-quay', neighborhood_name: 'Old Quay', place_ids: [], lat: 35.4, lon: -77.9, remarks: 'r',
    features: [], original_entry_ts: new Date(), modification_ts: new Date(), list_office_name: 'o', list_agent_name: 'a',
    photos_count: 10, association_fee: 120,
  };

  it('withholds the address when the seller opted out and flags price reductions', () => {
    const doc = toDocument(row);
    expect(doc.address).toBeNull();
    expect(doc.price_reduced).toBe(true);
  });

  it('keeps closed and unmapped listings out of the public index', () => {
    expect(isIndexable({ status: 'Active' })).toBe(true);
    expect(isIndexable({ status: 'Closed' })).toBe(false);
    expect(isIndexable({ status: 'Unmapped' })).toBe(false);
  });
});
