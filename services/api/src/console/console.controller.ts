import { Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { parseBody } from '../common/validate';
import { CurrentPrincipal, OfficeGuard, Principal } from '../auth/auth';
import { Db } from '../db/db.service';
import { ReportsService } from '../geo/reports.service';
import { MessagingService } from '../messaging/messaging.service';
import { TemporalService } from '../temporal/temporal.service';

const STATUS = z.enum(['ai_active', 'handed_off', 'agent_owned', 'booked', 'opted_out', 'closed']).optional();
const BAND = z.enum(['hot', 'warm', 'cooling', 'cold']).optional();

/** The agent console API. Every query runs inside the caller's tenant, under RLS. */
@Controller('v1/console')
@UseGuards(OfficeGuard)
export class ConsoleController {
  constructor(
    private readonly db: Db,
    private readonly messaging: MessagingService,
    private readonly temporal: TemporalService,
    private readonly reports: ReportsService,
  ) {}

  @Get('overview')
  overview(@CurrentPrincipal() p: Principal) {
    return this.db.withTenant(p.tenant_id!, async (tx) => {
      const leads = await tx.query(`
        SELECT count(*)::int AS leads,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM first_response_at - first_inquiry_at))
            FILTER (WHERE first_response_at IS NOT NULL) AS median_first_response_s,
          percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM first_response_at - first_inquiry_at))
            FILTER (WHERE first_response_at IS NOT NULL) AS p90_first_response_s,
          count(*) FILTER (WHERE status = 'ai_active')::int AS ai_active,
          count(*) FILTER (WHERE status = 'booked')::int AS booked,
          count(*) FILTER (WHERE status = 'handed_off')::int AS handed_off,
          count(*) FILTER (WHERE status = 'agent_owned')::int AS agent_owned,
          count(*) FILTER (WHERE status = 'opted_out')::int AS opted_out,
          count(*) FILTER (WHERE status = 'closed')::int AS closed
        FROM conversations WHERE first_inquiry_at IS NOT NULL`);
      const qualified = await tx.query(`
        SELECT count(*)::int AS n FROM conversations c JOIN contacts ct ON ct.id = c.contact_id
        WHERE c.first_inquiry_at IS NOT NULL AND ct.qualification ?& array['timeline', 'budget_max', 'preapproved']`);
      const handoffs = await tx.query(`
        SELECT handoff_reason AS reason, count(*)::int AS n FROM conversations
        WHERE status = 'handed_off' GROUP BY handoff_reason ORDER BY n DESC`);
      const bands = await tx.query(`SELECT band, count(*)::int AS n FROM relationship_scores GROUP BY band`);
      const actions = await tx.query(`
        SELECT ct.id, ct.first_name, ct.last_name, rs.score, rs.band, rs.next_action, rs.next_action_reason,
               a.first_name AS agent_first_name
        FROM relationship_scores rs JOIN contacts ct ON ct.id = rs.contact_id LEFT JOIN agents a ON a.id = ct.assigned_agent_id
        WHERE rs.next_action <> 'none' ORDER BY rs.score DESC LIMIT 8`);
      const alerts = await tx.query(`SELECT count(*)::int AS n FROM search_alerts WHERE created_at > now() - interval '24 hours'`);
      const reports = await tx.query(`SELECT status, count(*)::int AS n FROM farm_reports GROUP BY status`);
      const contacts = await tx.query(`SELECT count(*)::int AS n FROM contacts`);
      const l = leads.rows[0];
      return {
        leads: l.leads,
        median_first_response_s: l.median_first_response_s === null ? null : Math.round(l.median_first_response_s * 10) / 10,
        p90_first_response_s: l.p90_first_response_s === null ? null : Math.round(l.p90_first_response_s * 10) / 10,
        outcomes: {
          ai_active: l.ai_active,
          booked: l.booked,
          handed_off: l.handed_off,
          agent_owned: l.agent_owned,
          opted_out: l.opted_out,
          closed: l.closed,
        },
        qualified_by_ai: qualified.rows[0].n,
        handoff_reasons: handoffs.rows,
        score_bands: Object.fromEntries(bands.rows.map((r) => [r.band, r.n])),
        next_actions: actions.rows,
        alerts_24h: alerts.rows[0].n,
        farm_reports: Object.fromEntries(reports.rows.map((r) => [r.status, r.n])),
        contacts: contacts.rows[0].n,
      };
    });
  }

  @Get('conversations')
  conversations(@CurrentPrincipal() p: Principal, @Query('status') status?: string) {
    const s = STATUS.parse(status || undefined);
    return this.db.withTenant(p.tenant_id!, async (tx) => {
      const { rows } = await tx.query(
        `SELECT c.id, c.status, c.handoff_reason, c.last_message_at, c.first_inquiry_at, c.next_followup_at,
                extract(epoch FROM c.first_response_at - c.first_inquiry_at) AS first_response_s,
                ct.first_name, ct.last_name, ct.qualification, ct.stage, a.first_name AS agent_first_name,
                (SELECT count(*)::int FROM messages m WHERE m.conversation_id = c.id) AS message_count,
                (SELECT body FROM messages m WHERE m.conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_body
         FROM conversations c JOIN contacts ct ON ct.id = c.contact_id LEFT JOIN agents a ON a.id = c.agent_id
         WHERE ($1::text IS NULL OR c.status = $1) AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id)
         ORDER BY c.last_message_at DESC NULLS LAST LIMIT 100`,
        [s ?? null],
      );
      return rows;
    });
  }

  @Get('conversations/:id')
  async conversation(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    const data = await this.db.withTenant(p.tenant_id!, async (tx) => {
      const { rows } = await tx.query(
        `SELECT c.*, ct.first_name, ct.last_name, ct.phone, ct.qualification, ct.stage, ct.source, ct.consent_at, ct.consent_text,
                a.first_name AS agent_first_name, a.last_name AS agent_last_name,
                CASE WHEN l.idx_address THEN l.address_line END AS listing_address, l.list_price AS listing_price
         FROM conversations c JOIN contacts ct ON ct.id = c.contact_id LEFT JOIN agents a ON a.id = c.agent_id
         LEFT JOIN listings l ON l.id = c.inquiry_listing_id WHERE c.id = $1`,
        [id],
      );
      if (!rows[0]) throw new NotFoundException();
      const messages = await tx.query(
        'SELECT id, direction, kind, body, intent, status, meta, created_at FROM messages WHERE conversation_id = $1 ORDER BY created_at',
        [id],
      );
      const appts = await tx.query('SELECT id, starts_at, status, source FROM appointments WHERE conversation_id = $1 ORDER BY starts_at', [id]);
      return { conversation: rows[0], messages: messages.rows, appointments: appts.rows };
    });
    const workflow = data.conversation.workflow_id ? await this.temporal.describe(data.conversation.workflow_id) : null;
    return { ...data, workflow };
  }

  @Post('conversations/:id/takeover')
  @HttpCode(200)
  takeover(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    return this.messaging.takeover(p.tenant_id!, id, p.sub);
  }

  @Post('conversations/:id/messages')
  @HttpCode(200)
  async agentMessage(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    const b = parseBody(z.object({ body: z.string().min(1).max(306) }), body);
    return this.messaging.send(p.tenant_id!, id, b.body, 'agent', `agent:${id}:${Date.now()}`, p.sub);
  }

  @Get('relationships')
  relationships(@CurrentPrincipal() p: Principal, @Query('band') band?: string) {
    const b = BAND.parse(band || undefined);
    return this.db.withTenant(p.tenant_id!, async (tx) => {
      const rows = await tx.query(
        `SELECT ct.id, ct.first_name, ct.last_name, ct.stage, ct.source, rs.score, rs.band, rs.components,
                rs.next_action, rs.next_action_reason, rs.computed_at, a.first_name AS agent_first_name, a.last_name AS agent_last_name
         FROM relationship_scores rs JOIN contacts ct ON ct.id = rs.contact_id LEFT JOIN agents a ON a.id = ct.assigned_agent_id
         WHERE ($1::text IS NULL OR rs.band = $1) ORDER BY rs.score DESC, ct.first_name LIMIT 100`,
        [b ?? null],
      );
      const bands = await tx.query('SELECT band, count(*)::int AS n FROM relationship_scores GROUP BY band');
      return { bands: Object.fromEntries(bands.rows.map((r) => [r.band, r.n])), contacts: rows.rows };
    });
  }

  @Get('farms')
  farms(@CurrentPrincipal() p: Principal) {
    return this.db.withTenant(p.tenant_id!, async (tx) => {
      const { rows } = await tx.query(
        `SELECT f.id, f.name, a.first_name || ' ' || a.last_name AS agent_name, ST_AsGeoJSON(f.geom)::json AS geometry,
                (SELECT count(*)::int FROM contacts c WHERE ST_Within(c.home_location, f.geom) AND c.consent_email AND c.opted_out_at IS NULL) AS audience,
                r.id AS report_id, r.status AS report_status, r.created_at AS report_created_at, r.attempts AS report_attempts
         FROM farm_areas f JOIN agents a ON a.id = f.agent_id
         LEFT JOIN LATERAL (SELECT * FROM farm_reports fr WHERE fr.farm_area_id = f.id ORDER BY fr.created_at DESC LIMIT 1) r ON true
         ORDER BY f.name`,
      );
      return rows;
    });
  }

  @Get('farms/:id')
  farm(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    return this.db.withTenant(p.tenant_id!, async (tx) => {
      const { rows } = await tx.query(
        `SELECT f.id, f.name, a.first_name || ' ' || a.last_name AS agent_name, ST_AsGeoJSON(f.geom)::json AS geometry,
                (SELECT count(*)::int FROM contacts c WHERE ST_Within(c.home_location, f.geom) AND c.consent_email AND c.opted_out_at IS NULL) AS audience
         FROM farm_areas f JOIN agents a ON a.id = f.agent_id WHERE f.id = $1`,
        [id],
      );
      if (!rows[0]) throw new NotFoundException();
      const report = await tx.query(
        `SELECT id, status, stats, body, validation, attempts, model, created_at, sent_at, audience_count
         FROM farm_reports WHERE farm_area_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [id],
      );
      return { ...rows[0], report: report.rows[0] ?? null };
    });
  }

  @Post('farms/:id/reports')
  @HttpCode(200)
  generate(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    return this.reports.generateFarmReport(p.tenant_id!, id);
  }

  @Post('reports/:id/revise')
  @HttpCode(200)
  revise(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    const b = parseBody(z.object({ body: z.string().min(20).max(4000) }), body);
    return this.reports.reviseReport(p.tenant_id!, id, b.body);
  }

  @Post('reports/:id/send')
  @HttpCode(200)
  send(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    return this.reports.sendReport(p.tenant_id!, id);
  }
}
