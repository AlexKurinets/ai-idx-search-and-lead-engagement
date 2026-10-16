import * as fs from 'fs';
import * as path from 'path';
import { Client } from 'pg';
import { config } from '../config';

type Coord = [number, number];

interface Market {
  mls: string;
  mls_name: string;
  city: string;
  timezone: string;
  neighborhoods: { id: string; name: string; polygon: Coord[] }[];
  river: { id: string; name: string; corridor: Coord[]; near_m: number };
  parks: { id: string; name: string; polygon: Coord[]; near_m: number }[];
}

const polygonWkt = (ring: Coord[]) => `POLYGON((${ring.map(([x, y]) => `${x} ${y}`).join(',')}))`;

/**
 * Applies db/migrations/*.sql in order under an advisory lock, then syncs the platform
 * reference data (MLS sources, neighborhoods, searchable places) from the shared
 * geography file. Safe to run on every start.
 */
export async function migrate(log: (msg: string) => void = console.log): Promise<void> {
  const client = new Client({ connectionString: config.ownerDsn });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock(727001)');
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const applied = new Set(
      (await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name as string),
    );
    const files = fs.readdirSync(config.migrationsDir).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = fs.readFileSync(path.join(config.migrationsDir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        log(`applied ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file} failed: ${(err as Error).message}`);
      }
    }

    for (const [role, password] of [
      ['idx_app', config.appDbPassword],
      ['idx_platform', config.platformDbPassword],
    ]) {
      const { rows } = await client.query('SELECT format($1, $2::text, $3::text) AS sql', [
        'ALTER ROLE %I PASSWORD %L',
        role,
        password,
      ]);
      await client.query(rows[0].sql);
    }

    await syncReferenceData(client);
    log('reference data synced');
  } finally {
    await client.query('SELECT pg_advisory_unlock(727001)').catch(() => undefined);
    await client.end();
  }
}

async function syncReferenceData(client: Client): Promise<void> {
  const geo = JSON.parse(fs.readFileSync(config.geoPath, 'utf8')) as { markets: Market[] };
  await client.query('BEGIN');
  try {
    for (const m of geo.markets) {
      await client.query(
        `INSERT INTO mls_sources (code, name, city, timezone, base_url) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, city = EXCLUDED.city,
           timezone = EXCLUDED.timezone, base_url = EXCLUDED.base_url`,
        [m.mls, m.mls_name, m.city, m.timezone, config.mlsBaseUrl],
      );
      await client.query('INSERT INTO replication_state (mls_code) VALUES ($1) ON CONFLICT DO NOTHING', [m.mls]);
      for (const h of m.neighborhoods) {
        await client.query(
          `INSERT INTO neighborhoods (id, mls_code, name, geom) VALUES ($1, $2, $3, ST_GeomFromText($4, 4326))
           ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, geom = EXCLUDED.geom`,
          [h.id, m.mls, h.name, polygonWkt(h.polygon)],
        );
      }
      const places = [
        { id: m.river.id, kind: 'river', name: m.river.name, ring: m.river.corridor, near: 0 },
        ...m.parks.map((p) => ({ id: p.id, kind: 'park', name: p.name, ring: p.polygon, near: p.near_m })),
      ];
      for (const p of places) {
        await client.query(
          `INSERT INTO places (id, mls_code, kind, name, geom, near_m)
           VALUES ($1, $2, $3, $4, ST_MakeValid(ST_GeomFromText($5, 4326)), $6)
           ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, geom = EXCLUDED.geom, near_m = EXCLUDED.near_m`,
          [p.id, m.mls, p.kind, p.name, polygonWkt(p.ring), p.near],
        );
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

if (require.main === module) {
  migrate()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
