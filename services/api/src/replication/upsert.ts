import { Tx } from '../db/db.service';
import { CanonicalListing, MappingIssue } from './mapping';

export const LISTING_TOPIC = 'listing.events';

const COLUMNS: [string, string][] = [
  ['mls_code', 'text'], ['listing_key', 'text'], ['listing_id', 'text'], ['status', 'text'],
  ['property_sub_type', 'text'], ['list_price', 'integer'], ['original_list_price', 'integer'],
  ['close_price', 'integer'], ['close_date', 'date'], ['beds', 'smallint'], ['baths', 'numeric'],
  ['living_area_sqft', 'integer'], ['lot_acres', 'numeric'], ['year_built', 'smallint'],
  ['address_line', 'text'], ['city', 'text'], ['subdivision', 'text'], ['lat', 'float8'], ['lon', 'float8'],
  ['remarks', 'text'], ['features', 'text[]'], ['idx_entire', 'boolean'], ['idx_address', 'boolean'],
  ['list_office_name', 'text'], ['list_agent_name', 'text'], ['photos_count', 'integer'],
  ['association_fee', 'integer'], ['original_entry_ts', 'timestamptz'], ['modification_ts', 'timestamptz'],
  ['price_change_ts', 'timestamptz'], ['status_change_ts', 'timestamptz'], ['raw', 'jsonb'],
];

const STORED = COLUMNS.map(([c]) => c).filter((c) => c !== 'lat' && c !== 'lon');
const recordDef = COLUMNS.map(([c, t]) => `${c} ${t}`).join(', ');

/**
 * Upserts one page of mapped listings and writes one outbox event per changed listing,
 * in the caller's transaction. The CTEs all see the same snapshot, so `prev` holds the
 * values from before this statement, which is how the change type is classified.
 * PostGIS assigns the neighborhood and the nearby named places at write time, so search
 * filters on them are plain term filters.
 */
export async function upsertListings(
  tx: Tx,
  listings: CanonicalListing[],
  opts: { backfill: boolean },
): Promise<{ written: number; events: number }> {
  if (listings.length === 0) return { written: 0, events: 0 };
  const rows = listings.map((l) => ({ ...l }));
  const sql = `
    WITH incoming AS (
      SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(${recordDef})
    ),
    located AS (
      SELECT i.*, ST_SetSRID(ST_MakePoint(i.lon, i.lat), 4326) AS geom
      FROM incoming i
    ),
    prev AS (
      SELECT l.mls_code, l.listing_key, l.list_price, l.status, l.removed_at
      FROM listings l JOIN incoming i USING (mls_code, listing_key)
    ),
    up AS (
      INSERT INTO listings (${STORED.join(', ')}, geom, neighborhood_id, place_ids, replicated_at, removed_at)
      SELECT ${STORED.map((c) => `x.${c}`).join(', ')}, x.geom,
        (SELECT n.id FROM neighborhoods n WHERE n.mls_code = x.mls_code AND ST_Contains(n.geom, x.geom) LIMIT 1),
        ARRAY(SELECT p.id FROM places p
              WHERE p.mls_code = x.mls_code AND ST_DWithin(p.geom::geography, x.geom::geography, p.near_m)
              ORDER BY p.id),
        clock_timestamp(), NULL
      FROM located x
      ON CONFLICT (mls_code, listing_key) DO UPDATE SET
        ${STORED.filter((c) => c !== 'mls_code' && c !== 'listing_key').map((c) => `${c} = EXCLUDED.${c}`).join(', ')},
        geom = EXCLUDED.geom, neighborhood_id = EXCLUDED.neighborhood_id, place_ids = EXCLUDED.place_ids,
        replicated_at = EXCLUDED.replicated_at, removed_at = NULL
      WHERE listings.modification_ts <= EXCLUDED.modification_ts
      RETURNING id, mls_code, listing_key, list_price, status, modification_ts, replicated_at
    ),
    classified AS (
      SELECT up.*, CASE
        WHEN prev.listing_key IS NULL OR prev.removed_at IS NOT NULL THEN 'created'
        WHEN up.list_price < prev.list_price THEN 'price_reduced'
        WHEN up.status = 'Active' AND prev.status <> 'Active' THEN 'back_on_market'
        WHEN up.status <> prev.status THEN 'status_changed'
        ELSE 'updated' END AS change
      FROM up LEFT JOIN prev USING (mls_code, listing_key)
    ),
    events AS (
      INSERT INTO outbox (topic, key, payload)
      SELECT $2, c.id::text, jsonb_build_object(
        'type', 'upserted', 'listing_id', c.id, 'mls', c.mls_code, 'change', c.change,
        'modification_ts', c.modification_ts, 'replicated_at', c.replicated_at, 'backfill', $3::boolean)
      FROM classified c
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM up) AS written, (SELECT count(*) FROM events) AS events`;
  const res = await tx.query(sql, [JSON.stringify(rows), LISTING_TOPIC, opts.backfill]);
  return { written: Number(res.rows[0].written), events: Number(res.rows[0].events) };
}

export async function recordIssues(tx: Tx, mls: string, issues: MappingIssue[]): Promise<void> {
  if (issues.length === 0) return;
  const grouped = new Map<string, { field: string; value: string; count: number; sample: string }>();
  for (const i of issues) {
    const k = `${i.field}\u0000${i.value}`;
    const g = grouped.get(k) ?? { field: i.field, value: i.value, count: 0, sample: i.listing_key };
    g.count++;
    grouped.set(k, g);
  }
  for (const g of grouped.values()) {
    await tx.query(
      `INSERT INTO mapping_issues (mls_code, field, value, occurrences, sample_listing_key)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (mls_code, field, value) DO UPDATE
         SET occurrences = mapping_issues.occurrences + EXCLUDED.occurrences, last_seen = now()`,
      [mls, g.field, g.value, g.count, g.sample],
    );
  }
}

export async function markRemoved(tx: Tx, mls: string, keys: string[]): Promise<number> {
  if (keys.length === 0) return 0;
  const res = await tx.query(
    `WITH gone AS (
       UPDATE listings SET removed_at = clock_timestamp()
       WHERE mls_code = $1 AND listing_key = ANY($2::text[]) AND removed_at IS NULL
       RETURNING id, mls_code, removed_at
     )
     INSERT INTO outbox (topic, key, payload)
     SELECT $3, g.id::text, jsonb_build_object('type', 'removed', 'listing_id', g.id, 'mls', g.mls_code,
       'change', 'removed', 'modification_ts', g.removed_at, 'backfill', false)
     FROM gone g RETURNING 1`,
    [mls, keys, LISTING_TOPIC],
  );
  return res.rowCount ?? 0;
}
