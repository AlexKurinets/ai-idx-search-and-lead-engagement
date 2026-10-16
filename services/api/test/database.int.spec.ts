/**
 * Integration tests against a real PostGIS database (the Compose service locally, a
 * service container in CI). They create their own uniquely named rows and leave the
 * rest of the database alone.
 */
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import { Client } from 'pg';
import { config } from '../src/config';
import { Db } from '../src/db/db.service';
import { migrate } from '../src/db/migrate';
import { areaStats } from '../src/geo/stats';
import { CanonicalListing } from '../src/replication/mapping';
import { markRemoved, upsertListings } from '../src/replication/upsert';

jest.setTimeout(60_000);

const geo = JSON.parse(fs.readFileSync(config.geoPath, 'utf8'));
const ecm = geo.markets.find((m: any) => m.mls === 'ECM');
const oldQuay = ecm.neighborhoods.find((n: any) => n.id === 'ecm-old-quay');
const river = ecm.river.line[24];

let owner: Client;
let db: Db;
const run = randomUUID().slice(0, 8);

function listing(key: string, over: Partial<CanonicalListing> = {}): CanonicalListing {
  return {
    mls_code: 'ECM', listing_key: key, listing_id: key, status: 'Active', property_sub_type: 'single_family',
    list_price: 500000, original_list_price: 500000, close_price: null, close_date: null, beds: 3, baths: 2,
    living_area_sqft: 2000, lot_acres: 0.2, year_built: 2000, address_line: `${key} Test Way`, city: 'Port Ellery',
    subdivision: 'Old Quay', lat: oldQuay.centroid[1], lon: oldQuay.centroid[0], remarks: 'test', features: [],
    idx_entire: true, idx_address: true, list_office_name: 'o', list_agent_name: 'a', photos_count: 5,
    association_fee: 0, original_entry_ts: '2026-09-01T00:00:00.000Z', modification_ts: '2026-10-01T00:00:00.000Z',
    price_change_ts: null, status_change_ts: null, raw: { ListingKey: key }, ...over,
  };
}

beforeAll(async () => {
  await migrate(() => undefined);
  owner = new Client({ connectionString: config.ownerDsn });
  await owner.connect();
  db = new Db();
});

afterAll(async () => {
  try {
    // Test listings are marked removed rather than deleted: against a running stack the
    // indexer may already have indexed them, and the removal event takes them back out.
    const keys = (await owner.query('SELECT listing_key FROM listings WHERE listing_key LIKE $1 AND removed_at IS NULL', [`T${run}%`])).rows;
    await db.platformTx((tx) => markRemoved(tx, 'ECM', keys.map((r) => r.listing_key)));
    await owner.query('DELETE FROM contacts WHERE first_name = $1', [`rls-${run}`]);
    await owner.query('DELETE FROM tenant_mls WHERE tenant_id IN (SELECT id FROM tenants WHERE slug LIKE $1)', [`t-${run}%`]);
    await owner.query('DELETE FROM tenants WHERE slug LIKE $1', [`t-${run}%`]);
  } finally {
    await owner.end();
    await db.onModuleDestroy();
  }
});

describe('row-level security', () => {
  let a: string;
  let b: string;

  beforeAll(async () => {
    const ins = async (slug: string, phone: string) =>
      (await owner.query(
        "INSERT INTO tenants (slug, name, timezone, sms_number) VALUES ($1, $1, 'America/New_York', $2) RETURNING id",
        [slug, phone],
      )).rows[0].id as string;
    a = await ins(`t-${run}-a`, `+1999${run.replace(/\D/g, '').padEnd(7, '1').slice(0, 7)}`);
    b = await ins(`t-${run}-b`, `+1998${run.replace(/\D/g, '').padEnd(7, '2').slice(0, 7)}`);
    for (const [tenant, n] of [[a, 3], [b, 2]] as const) {
      for (let i = 0; i < n; i++) {
        await owner.query(
          "INSERT INTO contacts (tenant_id, first_name, phone, source, timezone) VALUES ($1, $2, $3, 'test', 'America/New_York')",
          [tenant, `rls-${run}`, `+1202555${String(100 + i)}${tenant === a ? 'a' : 'b'}${run}`],
        );
      }
    }
  });

  it('shows each office only its own rows, even without a WHERE clause', async () => {
    const countA = await db.withTenant(a, async (tx) => (await tx.query('SELECT count(*)::int AS n FROM contacts WHERE first_name = $1', [`rls-${run}`])).rows[0].n);
    const countB = await db.withTenant(b, async (tx) => (await tx.query('SELECT count(*)::int AS n FROM contacts WHERE first_name = $1', [`rls-${run}`])).rows[0].n);
    expect([countA, countB]).toEqual([3, 2]);
  });

  it('refuses to write a row into another office', async () => {
    await expect(
      db.withTenant(a, (tx) =>
        tx.query("INSERT INTO contacts (tenant_id, first_name, phone, source, timezone) VALUES ($1, 'x', '+12025550199', 'test', 'UTC')", [b]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('fails closed on a pooled connection with no tenant set', async () => {
    await db.withTenant(a, (tx) => tx.query('SELECT 1'));
    const rows = await db.query('SELECT count(*)::int AS n FROM contacts WHERE first_name = $1', [`rls-${run}`]);
    expect(rows[0].n).toBe(0);
  });
});

describe('replication upsert', () => {
  const events = async (key: string) =>
    (await owner.query(
      `SELECT o.payload->>'change' AS change FROM outbox o JOIN listings l ON l.id::text = o.key
       WHERE l.listing_key = $1 ORDER BY o.id`,
      [key],
    )).rows.map((r) => r.change);

  it('assigns the neighborhood and nearby places with PostGIS and classifies each change', async () => {
    const k1 = `T${run}1`;
    const k2 = `T${run}2`;
    // backfill: true keeps a running stack from raising alerts or lag samples for test rows.
    await db.platformTx((tx) =>
      upsertListings(tx, [listing(k1), listing(k2, { lat: river[1], lon: river[0] })], { backfill: true }),
    );
    const rows = (await owner.query('SELECT listing_key, neighborhood_id, place_ids FROM listings WHERE listing_key = ANY($1) ORDER BY listing_key', [[k1, k2]])).rows;
    expect(rows[0].neighborhood_id).toBe('ecm-old-quay');
    expect(rows[1].place_ids).toContain('ecm-ellery-river');

    await db.platformTx((tx) =>
      upsertListings(tx, [listing(k1, { list_price: 480000, modification_ts: '2026-10-02T00:00:00.000Z' })], { backfill: true }),
    );
    await db.platformTx((tx) =>
      upsertListings(tx, [listing(k1, { status: 'Pending', list_price: 480000, modification_ts: '2026-10-03T00:00:00.000Z' })], { backfill: true }),
    );
    expect(await events(k1)).toEqual(['created', 'price_reduced', 'status_changed']);
  });

  it('ignores a stale record older than what is stored', async () => {
    const k = `T${run}3`;
    await db.platformTx((tx) => upsertListings(tx, [listing(k, { modification_ts: '2026-10-05T00:00:00.000Z' })], { backfill: true }));
    const res = await db.platformTx((tx) =>
      upsertListings(tx, [listing(k, { list_price: 1, modification_ts: '2026-10-04T00:00:00.000Z' })], { backfill: true }),
    );
    expect(res).toEqual({ written: 0, events: 0 });
    const price = (await owner.query('SELECT list_price FROM listings WHERE listing_key = $1', [k])).rows[0].list_price;
    expect(price).toBe(500000);
  });

  it('marks listings removed from the feed and emits a removal event', async () => {
    const k = `T${run}4`;
    await db.platformTx((tx) => upsertListings(tx, [listing(k)], { backfill: true }));
    const n = await db.platformTx((tx) => markRemoved(tx, 'ECM', [k]));
    expect(n).toBe(1);
    expect((await events(k)).slice(-1)).toEqual(['removed']);
  });
});

describe('area stats', () => {
  it('computes medians and counts inside a polygon', async () => {
    const poly = `POLYGON((${oldQuay.polygon.map((p: number[]) => `${p[0]} ${p[1]}`).join(',')}))`;
    const stats = await areaStats(db.platform, 'SELECT ST_GeomFromText($1, 4326) AS geom', [poly]);
    expect(stats.period_days).toBe(90);
    expect(stats.active_listings).toBeGreaterThan(0);
    expect(stats.median_list_price).not.toBeNull();
    expect(stats.median_list_price! % 1000).toBe(0);
  });
});
