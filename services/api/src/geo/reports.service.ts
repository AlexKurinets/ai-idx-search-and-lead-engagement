import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AiClient } from '../common/ai-client';
import { Db } from '../db/db.service';
import { emit } from '../events/relay.service';
import { areaStats } from './stats';

/**
 * Neighborhood insights and farm-area reports share one rule: numbers come from SQL,
 * words come from the model, and the validator rejects any draft quoting a figure that
 * is not in the stats payload. A draft that still fails after one regeneration is held
 * for the agent rather than sent.
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly db: Db,
    private readonly ai: AiClient,
  ) {}

  async neighborhoodInsight(neighborhoodId: string) {
    const today = new Date().toISOString().slice(0, 10);
    const [cached] = await this.db.query(
      'SELECT stats, body, validation, model, as_of FROM neighborhood_insights WHERE neighborhood_id = $1 AND as_of = $2',
      [neighborhoodId, today],
    );
    if (cached) return cached;
    const [hood] = await this.db.query<{ name: string; city: string }>(
      'SELECT n.name, m.city FROM neighborhoods n JOIN mls_sources m ON m.code = n.mls_code WHERE n.id = $1',
      [neighborhoodId],
    );
    if (!hood) throw new NotFoundException('unknown neighborhood');
    const stats = await areaStats(this.db.platform, 'SELECT geom FROM neighborhoods WHERE id = $1', [neighborhoodId]);
    const draft = await this.ai.draftReport({ kind: 'neighborhood', area_name: hood.name, city: hood.city, stats });
    const row = { stats, body: draft.body, validation: { ...draft.validation, ok: draft.ok, attempts: draft.attempts }, model: draft.model, as_of: today };
    await this.db.platformQuery(
      `INSERT INTO neighborhood_insights (neighborhood_id, as_of, stats, body, validation, model)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (neighborhood_id, as_of) DO NOTHING`,
      [neighborhoodId, today, JSON.stringify(stats), draft.body, JSON.stringify(row.validation), draft.model],
    );
    return row;
  }

  async generateFarmReport(tenantId: string, farmAreaId: string) {
    return this.db.withTenant(tenantId, async (tx) => {
      const { rows } = await tx.query(
        `SELECT f.id, f.name, a.first_name || ' ' || a.last_name AS agent_name, t.name AS office_name
         FROM farm_areas f JOIN agents a ON a.id = f.agent_id JOIN tenants t ON t.id = f.tenant_id
         WHERE f.id = $1`,
        [farmAreaId],
      );
      const farm = rows[0];
      if (!farm) throw new NotFoundException('unknown farm area');
      const stats = await areaStats(tx, 'SELECT geom FROM farm_areas WHERE id = $1', [farmAreaId]);
      const draft = await this.ai.draftReport({
        kind: 'farm',
        area_name: farm.name,
        agent_name: farm.agent_name,
        office_name: farm.office_name,
        stats,
      });
      const today = new Date();
      const start = new Date(today.getTime() - stats.period_days * 86_400_000);
      const ins = await tx.query(
        `INSERT INTO farm_reports (tenant_id, farm_area_id, period_start, period_end, stats, body, status, validation, attempts, model)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id, status, created_at`,
        [
          tenantId,
          farmAreaId,
          start.toISOString().slice(0, 10),
          today.toISOString().slice(0, 10),
          JSON.stringify(stats),
          draft.body,
          draft.ok ? 'draft' : 'needs_review',
          JSON.stringify({ ...draft.validation, ok: draft.ok }),
          draft.attempts,
          draft.model,
        ],
      );
      return { id: ins.rows[0].id, status: ins.rows[0].status, stats, body: draft.body, validation: draft.validation, ok: draft.ok };
    });
  }

  /** Re-validates an agent's edit against the same stats before it can be sent. */
  async reviseReport(tenantId: string, reportId: string, body: string) {
    const report = await this.db.withTenant(tenantId, async (tx) => {
      const { rows } = await tx.query(
        `SELECT r.id, r.stats, r.status, f.name AS farm_name, a.first_name || ' ' || a.last_name AS agent_name, t.name AS office_name
         FROM farm_reports r JOIN farm_areas f ON f.id = r.farm_area_id JOIN agents a ON a.id = f.agent_id
         JOIN tenants t ON t.id = r.tenant_id WHERE r.id = $1`,
        [reportId],
      );
      return rows[0];
    });
    if (!report) throw new NotFoundException('unknown report');
    if (report.status === 'sent') throw new BadRequestException('report already sent');
    const v = await this.ai.validateReport(body, report.stats, [report.farm_name, report.agent_name, report.office_name]);
    await this.db.withTenant(tenantId, (tx) =>
      tx.query('UPDATE farm_reports SET body = $2, validation = $3, status = $4 WHERE id = $1', [
        reportId,
        body,
        JSON.stringify(v),
        v.ok ? 'draft' : 'needs_review',
      ]),
    );
    return { ...v, status: v.ok ? 'draft' : 'needs_review' };
  }

  /**
   * Sends to the farm audience: contacts whose home sits inside the polygon and who
   * consented to email. Sending goes through the sandbox email table here.
   */
  async sendReport(tenantId: string, reportId: string) {
    return this.db.withTenant(tenantId, async (tx) => {
      const { rows } = await tx.query(
        `SELECT r.id, r.status, r.body, r.farm_area_id, f.name AS farm_name FROM farm_reports r
         JOIN farm_areas f ON f.id = r.farm_area_id WHERE r.id = $1 FOR UPDATE OF r`,
        [reportId],
      );
      const report = rows[0];
      if (!report) throw new NotFoundException('unknown report');
      if (report.status !== 'draft') throw new BadRequestException(`report is ${report.status}; only a validated draft can be sent`);
      const audience = await tx.query(
        `SELECT c.id FROM contacts c, farm_areas f
         WHERE f.id = $1 AND c.consent_email AND c.opted_out_at IS NULL AND ST_Within(c.home_location, f.geom)`,
        [report.farm_area_id],
      );
      const subject = `${report.farm_name}: your neighborhood market update`;
      for (const c of audience.rows) {
        await tx.query('INSERT INTO outbound_email (tenant_id, contact_id, kind, subject, body) VALUES ($1, $2, $3, $4, $5)', [
          tenantId,
          c.id,
          'farm_report',
          subject,
          report.body,
        ]);
        await tx.query(
          `INSERT INTO contact_activity (tenant_id, contact_id, kind, meta) VALUES ($1, $2, 'email_sent', $3)`,
          [tenantId, c.id, JSON.stringify({ report_id: reportId })],
        );
      }
      await tx.query("UPDATE farm_reports SET status = 'sent', sent_at = now(), audience_count = $2 WHERE id = $1", [
        reportId,
        audience.rowCount,
      ]);
      await emit(tx, 'engagement.events', reportId, { type: 'farm_report.sent', tenant_id: tenantId, report_id: reportId, audience: audience.rowCount });
      return { sent: audience.rowCount };
    });
  }
}
