import * as fs from 'fs';
import { Body, Controller, Get, HttpCode, NotFoundException, Param, Post } from '@nestjs/common';
import { config } from '../config';
import { parseBody } from '../common/validate';
import { Db } from '../db/db.service';
import { ReportsService } from '../geo/reports.service';
import { InquiryRequest, LeadsService } from '../leads/leads.service';
import { SearchRequest, SearchService } from './search.service';
import { TenantsService } from './tenants.service';

interface GeoFile {
  markets: { mls: string; river: { id: string; name: string; line: [number, number][] } }[];
}

@Controller('v1/offices')
export class OfficesController {
  constructor(private readonly tenants: TenantsService) {}

  @Get()
  async list() {
    const all = await this.tenants.all();
    return all.map((t) => ({ slug: t.slug, name: t.name, city: t.city, mls_codes: t.mls_codes, brand_color: t.brand_color, timezone: t.timezone }));
  }
}

/** The public, unauthenticated surface of an office's search site. */
@Controller('v1/t/:tenant')
export class PublicController {
  private rivers: GeoFile['markets'] | null = null;

  constructor(
    private readonly tenants: TenantsService,
    private readonly search: SearchService,
    private readonly leads: LeadsService,
    private readonly reports: ReportsService,
    private readonly db: Db,
  ) {}

  @Get()
  async office(@Param('tenant') slug: string) {
    const t = await this.tenants.bySlug(slug);
    return {
      slug: t.slug, name: t.name, brand_color: t.brand_color, mls_codes: t.mls_codes, city: t.city, center: t.center,
      sms_number: t.sms_number, timezone: t.timezone,
    };
  }

  @Post('search')
  @HttpCode(200)
  async searchListings(@Param('tenant') slug: string, @Body() body: unknown) {
    const tenant = await this.tenants.bySlug(slug);
    return this.search.search(tenant, parseBody(SearchRequest, body));
  }

  @Get('listings/:id')
  async listing(@Param('tenant') slug: string, @Param('id') id: string) {
    const tenant = await this.tenants.bySlug(slug);
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new NotFoundException();
    const [row] = await this.db.query(
      `SELECT l.id, l.mls_code, m.name AS mls_name, l.listing_id, l.status, l.property_sub_type, l.list_price, l.original_list_price,
              l.price_change_ts, l.beds, l.baths, l.living_area_sqft, l.lot_acres, l.year_built,
              CASE WHEN l.idx_address THEN l.address_line END AS address, l.idx_address, l.city, l.neighborhood_id,
              n.name AS neighborhood, l.remarks, l.features, l.list_office_name, l.list_agent_name, l.photos_count,
              l.association_fee, l.original_entry_ts, l.modification_ts, ST_Y(l.geom) AS lat, ST_X(l.geom) AS lon,
              rs.last_success_at AS feed_updated_at
       FROM listings l JOIN mls_sources m ON m.code = l.mls_code
       LEFT JOIN neighborhoods n ON n.id = l.neighborhood_id
       LEFT JOIN replication_state rs ON rs.mls_code = l.mls_code
       WHERE l.id = $1 AND l.mls_code = ANY($2) AND l.idx_entire AND l.removed_at IS NULL
         AND l.status IN ('Active', 'ComingSoon', 'ActiveUnderContract', 'Pending')`,
      [id, tenant.mls_codes],
    );
    if (!row) throw new NotFoundException('listing not available');
    const days = row.original_entry_ts ? Math.max(0, Math.floor((Date.now() - new Date(row.original_entry_ts).getTime()) / 86_400_000)) : null;
    const insight = row.neighborhood_id ? await this.reports.neighborhoodInsight(row.neighborhood_id).catch(() => null) : null;
    return {
      ...row,
      days_on_market: days,
      attribution: {
        text: `Listing courtesy of ${row.list_office_name} via ${row.mls_name}.`,
        feed_updated_at: row.feed_updated_at,
      },
      insight,
    };
  }

  @Get('geo')
  async geo(@Param('tenant') slug: string) {
    const tenant = await this.tenants.bySlug(slug);
    const hoods = await this.db.query(
      `SELECT n.id, n.name, n.mls_code, ST_AsGeoJSON(n.geom)::json AS geometry,
              count(l.*) FILTER (WHERE l.status = 'Active') AS active,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY l.list_price) FILTER (WHERE l.status = 'Active') AS median_price
       FROM neighborhoods n LEFT JOIN listings l ON l.neighborhood_id = n.id AND l.removed_at IS NULL AND l.idx_entire
       WHERE n.mls_code = ANY($1) GROUP BY n.id`,
      [tenant.mls_codes],
    );
    const places = await this.db.query(
      `SELECT id, name, kind, mls_code, ST_AsGeoJSON(geom)::json AS geometry FROM places WHERE mls_code = ANY($1) AND kind = 'park'`,
      [tenant.mls_codes],
    );
    if (!this.rivers) this.rivers = (JSON.parse(fs.readFileSync(config.geoPath, 'utf8')) as GeoFile).markets;
    const rivers = this.rivers
      .filter((m) => tenant.mls_codes.includes(m.mls))
      .map((m) => ({
        type: 'Feature',
        properties: { id: m.river.id, name: m.river.name, kind: 'river' },
        geometry: { type: 'LineString', coordinates: m.river.line },
      }));
    return {
      neighborhoods: {
        type: 'FeatureCollection',
        features: hoods.map((h) => ({
          type: 'Feature',
          properties: { id: h.id, name: h.name, mls: h.mls_code, active: Number(h.active), median_price: h.median_price && Math.round(h.median_price) },
          geometry: h.geometry,
        })),
      },
      parks: {
        type: 'FeatureCollection',
        features: places.map((p) => ({ type: 'Feature', properties: { id: p.id, name: p.name, kind: p.kind }, geometry: p.geometry })),
      },
      rivers: { type: 'FeatureCollection', features: rivers },
    };
  }

  @Post('leads')
  async lead(@Param('tenant') slug: string, @Body() body: unknown) {
    const tenant = await this.tenants.bySlug(slug);
    return this.leads.inquire(tenant, parseBody(InquiryRequest, body));
  }
}
