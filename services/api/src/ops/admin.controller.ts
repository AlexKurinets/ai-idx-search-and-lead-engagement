import { Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { Db } from '../db/db.service';
import { ReportsService } from '../geo/reports.service';
import { InternalGuard } from '../messaging/internal.controller';
import { ScoringService } from '../scoring/scoring.service';
import { SearchFilters } from '../search/filters';
import { OpenSearchService } from '../search/opensearch.service';
import { percolatorQuery } from '../search/query-builder';

/** Batch jobs the seed script and schedulers trigger. Internal token only. */
@Controller('internal/jobs')
@UseGuards(InternalGuard)
export class AdminController {
  constructor(
    private readonly db: Db,
    private readonly scoring: ScoringService,
    private readonly reports: ReportsService,
    private readonly os: OpenSearchService,
  ) {}

  @Post('score-all')
  @HttpCode(200)
  async scoreAll() {
    return { scored: await this.scoring.scoreAll() };
  }

  /** Registers every saved search as a percolator query, e.g. after a bulk import. */
  @Post('saved-searches/reindex')
  @HttpCode(200)
  async reindexSavedSearches() {
    const rows = await this.db.platformQuery<{ id: string; tenant_id: string; contact_id: string; filters: unknown; mls_codes: string[] }>(
      `SELECT s.id, s.tenant_id, s.contact_id, s.filters,
              (SELECT array_agg(mls_code) FROM tenant_mls tm WHERE tm.tenant_id = s.tenant_id) AS mls_codes
       FROM saved_searches s`,
    );
    for (const r of rows) {
      await this.os.putSavedSearch(r.id, percolatorQuery(SearchFilters.parse(r.filters), r.mls_codes), {
        tenant_id: r.tenant_id,
        contact_id: r.contact_id,
      });
    }
    return { indexed: rows.length };
  }

  @Post('farm-reports')
  @HttpCode(200)
  async farmReports() {
    const farms = await this.db.platformQuery<{ id: string; tenant_id: string }>('SELECT id, tenant_id FROM farm_areas ORDER BY tenant_id, name');
    const statuses: Record<string, number> = {};
    for (const f of farms) {
      const r = await this.reports.generateFarmReport(f.tenant_id, f.id);
      statuses[r.status] = (statuses[r.status] ?? 0) + 1;
    }
    return { generated: farms.length, statuses };
  }
}
