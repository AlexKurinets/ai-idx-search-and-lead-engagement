import { Injectable, Logger } from '@nestjs/common';
import { Client } from '@opensearch-project/opensearch';
import { config } from '../config';

const LISTING_PROPERTIES = {
  id: { type: 'keyword' },
  mls: { type: 'keyword' },
  listing_key: { type: 'keyword' },
  status: { type: 'keyword' },
  sub_type: { type: 'keyword' },
  price: { type: 'long' },
  original_price: { type: 'long' },
  price_reduced: { type: 'boolean' },
  price_change_at: { type: 'date' },
  beds: { type: 'short' },
  baths: { type: 'float' },
  sqft: { type: 'integer' },
  lot_acres: { type: 'float' },
  year_built: { type: 'short' },
  address: { type: 'text', fields: { raw: { type: 'keyword' } } },
  display_address: { type: 'boolean' },
  city: { type: 'keyword' },
  neighborhood_id: { type: 'keyword' },
  neighborhood: { type: 'keyword' },
  place_ids: { type: 'keyword' },
  location: { type: 'geo_point' },
  remarks: { type: 'text', analyzer: 'english' },
  features: { type: 'keyword' },
  idx_entire: { type: 'boolean' },
  list_date: { type: 'date' },
  modified_at: { type: 'date' },
  office: { type: 'keyword' },
  agent: { type: 'keyword' },
  photos_count: { type: 'short' },
  hoa: { type: 'integer' },
};

export interface ListingRow {
  id: string;
  mls_code: string;
  listing_key: string;
  status: string;
  property_sub_type: string | null;
  list_price: number | null;
  original_list_price: number | null;
  price_change_ts: Date | null;
  beds: number | null;
  baths: number | null;
  living_area_sqft: number | null;
  lot_acres: number | null;
  year_built: number | null;
  address_line: string | null;
  idx_address: boolean;
  idx_entire: boolean;
  city: string | null;
  neighborhood_id: string | null;
  neighborhood_name: string | null;
  place_ids: string[];
  lat: number;
  lon: number;
  remarks: string | null;
  features: string[];
  original_entry_ts: Date | null;
  modification_ts: Date;
  list_office_name: string | null;
  list_agent_name: string | null;
  photos_count: number | null;
  association_fee: number | null;
}

/** The SQL the indexer uses to read current listing state for documents. */
export const LISTING_DOC_SQL = `
  SELECT l.id, l.mls_code, l.listing_key, l.status, l.property_sub_type, l.list_price, l.original_list_price,
         l.price_change_ts, l.beds, l.baths, l.living_area_sqft, l.lot_acres, l.year_built, l.address_line,
         l.idx_address, l.idx_entire, l.city, l.neighborhood_id, n.name AS neighborhood_name, l.place_ids,
         ST_Y(l.geom) AS lat, ST_X(l.geom) AS lon, l.remarks, l.features, l.original_entry_ts,
         l.modification_ts, l.list_office_name, l.list_agent_name, l.photos_count, l.association_fee
  FROM listings l LEFT JOIN neighborhoods n ON n.id = l.neighborhood_id`;

/** Listings in these states are never put in the public index. */
const DISPLAYABLE = new Set(['Active', 'ComingSoon', 'ActiveUnderContract', 'Pending']);

export function isIndexable(row: Pick<ListingRow, 'status'>): boolean {
  return DISPLAYABLE.has(row.status);
}

export function toDocument(row: ListingRow): Record<string, unknown> {
  return {
    id: row.id,
    mls: row.mls_code,
    listing_key: row.listing_key,
    status: row.status,
    sub_type: row.property_sub_type,
    price: row.list_price,
    original_price: row.original_list_price,
    price_reduced: row.original_list_price !== null && row.list_price !== null && row.list_price < row.original_list_price,
    price_change_at: row.price_change_ts,
    beds: row.beds,
    baths: row.baths,
    sqft: row.living_area_sqft,
    lot_acres: row.lot_acres,
    year_built: row.year_built,
    // IDX rule: when the seller withheld the address, it never reaches the public index.
    address: row.idx_address ? row.address_line : null,
    display_address: row.idx_address,
    city: row.city,
    neighborhood_id: row.neighborhood_id,
    neighborhood: row.neighborhood_name,
    place_ids: row.place_ids,
    location: { lat: row.lat, lon: row.lon },
    remarks: row.remarks,
    features: row.features,
    idx_entire: row.idx_entire,
    list_date: row.original_entry_ts,
    modified_at: row.modification_ts,
    office: row.list_office_name,
    agent: row.list_agent_name,
    photos_count: row.photos_count,
    hoa: row.association_fee,
  };
}

@Injectable()
export class OpenSearchService {
  private readonly log = new Logger('opensearch');
  readonly client = new Client({ node: config.opensearchUrl });

  async ensureIndices(): Promise<void> {
    const exists = await this.client.indices.exists({ index: config.listingsIndex });
    if (!exists.body) {
      await this.client.indices.create({
        index: config.listingsIndex,
        body: {
          settings: { number_of_shards: 1, number_of_replicas: 0, refresh_interval: '1s' },
          mappings: { dynamic: 'strict', properties: LISTING_PROPERTIES },
          aliases: { [config.listingsAlias]: {} },
        },
      });
      this.log.log(`created ${config.listingsIndex} behind alias ${config.listingsAlias}`);
    }
    const ssExists = await this.client.indices.exists({ index: config.savedSearchIndex });
    if (!ssExists.body) {
      await this.client.indices.create({
        index: config.savedSearchIndex,
        body: {
          settings: { number_of_shards: 1, number_of_replicas: 0 },
          mappings: {
            properties: {
              ...LISTING_PROPERTIES,
              query: { type: 'percolator' },
              saved_search_id: { type: 'keyword' },
              tenant_id: { type: 'keyword' },
              contact_id: { type: 'keyword' },
            },
          },
        },
      });
      this.log.log(`created ${config.savedSearchIndex}`);
    }
  }

  async count(): Promise<number | null> {
    try {
      const res = await this.client.count({ index: config.listingsAlias });
      return res.body.count as number;
    } catch {
      return null;
    }
  }

  /**
   * Bulk index with external versioning: the version is the MLS modification time in
   * milliseconds, so an older event that arrives late is rejected instead of overwriting
   * newer data. A 409 on that path is expected and ignored.
   */
  async bulk(
    upserts: { doc: Record<string, unknown>; version: number }[],
    deletes: { id: string; version: number }[],
  ): Promise<{ indexed: number; deleted: number; stale: number; errors: number }> {
    if (!upserts.length && !deletes.length) return { indexed: 0, deleted: 0, stale: 0, errors: 0 };
    const body: object[] = [];
    for (const u of upserts) {
      body.push({ index: { _index: config.listingsIndex, _id: u.doc.id, version: u.version, version_type: 'external_gte' } });
      body.push(u.doc);
    }
    for (const d of deletes) {
      body.push({ delete: { _index: config.listingsIndex, _id: d.id, version: d.version, version_type: 'external_gte' } });
    }
    const res = await this.client.bulk({ body, refresh: false });
    let indexed = 0;
    let deleted = 0;
    let stale = 0;
    let errors = 0;
    for (const item of res.body.items as Record<string, { status: number; error?: { type: string; reason: string } }>[]) {
      const [op, r] = Object.entries(item)[0];
      if (r.status === 409) stale++;
      else if (r.status === 404 && op === 'delete') deleted++;
      else if (r.error) {
        errors++;
        if (errors <= 3) this.log.warn(`${op} failed: ${r.error.type} ${r.error.reason}`);
      } else if (op === 'delete') deleted++;
      else indexed++;
    }
    return { indexed, deleted, stale, errors };
  }

  async search(body: Record<string, unknown>) {
    const res = await this.client.search({ index: config.listingsAlias, body });
    return res.body as {
      took: number;
      hits: { total: { value: number }; hits: { _id: string; _score: number | null; _source: Record<string, unknown> }[] };
      aggregations?: Record<string, any>;
    };
  }

  async get(id: string): Promise<Record<string, unknown> | null> {
    try {
      const res = await this.client.get({ index: config.listingsAlias, id });
      return res.body._source as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  async putSavedSearch(id: string, query: object, meta: { tenant_id: string; contact_id: string }) {
    await this.client.index({
      index: config.savedSearchIndex,
      id,
      body: { query, saved_search_id: id, ...meta },
      refresh: true,
    });
  }

  /** Returns, for each document slot, the saved searches whose stored query matches it. */
  async percolate(docs: Record<string, unknown>[]): Promise<Map<number, { savedSearchId: string; tenantId: string; contactId: string }[]>> {
    const out = new Map<number, { savedSearchId: string; tenantId: string; contactId: string }[]>();
    if (!docs.length) return out;
    const res = await this.client.search({
      index: config.savedSearchIndex,
      body: {
        size: 1000,
        _source: ['saved_search_id', 'tenant_id', 'contact_id'],
        query: { percolate: { field: 'query', documents: docs } },
      },
    });
    for (const hit of res.body.hits.hits as any[]) {
      const slots: number[] = hit.fields?._percolator_document_slot ?? [0];
      for (const slot of slots) {
        const list = out.get(slot) ?? [];
        list.push({ savedSearchId: hit._source.saved_search_id, tenantId: hit._source.tenant_id, contactId: hit._source.contact_id });
        out.set(slot, list);
      }
    }
    return out;
  }
}
