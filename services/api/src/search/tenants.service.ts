import { Injectable, NotFoundException } from '@nestjs/common';
import { Db } from '../db/db.service';

export interface Tenant {
  id: string;
  slug: string;
  name: string;
  timezone: string;
  sms_number: string;
  brand_color: string;
  mls_codes: string[];
  city: string;
  center: [number, number] | null;
}

/** Tenant lookups by slug or by SMS number, cached briefly in memory. */
@Injectable()
export class TenantsService {
  private cache = new Map<string, { at: number; tenant: Tenant }>();

  constructor(private readonly db: Db) {}

  private async load(where: string, value: string): Promise<Tenant | null> {
    const key = `${where}:${value}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < 60_000) return hit.tenant;
    const rows = await this.db.query<Tenant & { lon: number | null; lat: number | null }>(
      `SELECT t.id, t.slug, t.name, t.timezone, t.sms_number, t.brand_color,
              array_agg(tm.mls_code ORDER BY tm.mls_code) AS mls_codes,
              coalesce((SELECT ms.city FROM neighborhoods n JOIN mls_sources ms ON ms.code = n.mls_code
                        WHERE ST_Contains(n.geom, t.office_location) LIMIT 1), min(m.city)) AS city,
              ST_X(t.office_location) AS lon, ST_Y(t.office_location) AS lat
       FROM tenants t
       JOIN tenant_mls tm ON tm.tenant_id = t.id
       JOIN mls_sources m ON m.code = tm.mls_code
       WHERE t.${where} = $1
       GROUP BY t.id`,
      [value],
    );
    if (!rows[0]) return null;
    const { lon, lat, ...rest } = rows[0];
    const tenant: Tenant = { ...rest, center: lon !== null && lat !== null ? [lon, lat] : null };
    this.cache.set(key, { at: Date.now(), tenant });
    return tenant;
  }

  async bySlug(slug: string): Promise<Tenant> {
    const t = await this.load('slug', slug);
    if (!t) throw new NotFoundException(`unknown office ${slug}`);
    return t;
  }

  byId(id: string): Promise<Tenant | null> {
    return this.load('id', id);
  }

  bySmsNumber(number: string): Promise<Tenant | null> {
    return this.load('sms_number', number);
  }

  async all(): Promise<Tenant[]> {
    // Only offices with at least one MLS feed can serve a search site.
    const rows = await this.db.query<{ slug: string }>(
      'SELECT t.slug FROM tenants t WHERE EXISTS (SELECT 1 FROM tenant_mls m WHERE m.tenant_id = t.id) ORDER BY t.name',
    );
    return Promise.all(rows.map((r) => this.bySlug(r.slug)));
  }
}
