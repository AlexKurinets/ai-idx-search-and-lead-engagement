import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { config } from '../config';
import { isFictional, toE164 } from '../common/phone';
import { Db } from '../db/db.service';
import { emit } from '../events/relay.service';
import { MessagingService } from '../messaging/messaging.service';
import { SearchFilters } from '../search/filters';
import { OpenSearchService } from '../search/opensearch.service';
import { percolatorQuery } from '../search/query-builder';
import { Tenant } from '../search/tenants.service';
import { TemporalService } from '../temporal/temporal.service';
import { routeLead } from './routing';

export const CONSENT_TEXT =
  'By submitting, you agree to receive calls and texts, including automated texts, about real estate from this office at the number provided. Consent is not a condition of purchase. Msg & data rates may apply. Reply STOP to opt out.';

export const InquiryRequest = z.object({
  first_name: z.string().trim().min(1).max(40),
  last_name: z.string().trim().max(60).optional(),
  phone: z.string().min(7).max(20),
  email: z.string().email().max(120).optional(),
  listing_id: z.string().uuid().optional(),
  message: z.string().max(500).optional(),
  consent_sms: z.boolean(),
  saved_search: z.object({ name: z.string().min(1).max(80), query_text: z.string().max(200).optional(), filters: SearchFilters }).optional(),
});
export type InquiryRequest = z.infer<typeof InquiryRequest>;

@Injectable()
export class LeadsService {
  private readonly log = new Logger('leads');

  constructor(
    private readonly db: Db,
    private readonly temporal: TemporalService,
    private readonly os: OpenSearchService,
    private readonly messaging: MessagingService,
  ) {}

  /**
   * A web inquiry or saved-search signup. Contact, routing, consent, activity, the
   * conversation and the lead event commit together; the per-lead workflow is started
   * after commit, and a sweeper starts any that were missed.
   */
  async inquire(tenant: Tenant, req: InquiryRequest) {
    const phone = toE164(req.phone);
    if (!phone) throw new BadRequestException('phone must be a 10-digit North American number');
    if (config.smsAdapter === 'sandbox' && !isFictional(phone)) {
      throw new BadRequestException('the sandbox only texts fictional 555-01xx numbers');
    }
    const at = new Date();

    const result = await this.db.withTenant(tenant.id, async (tx) => {
      let point: [number, number] | null = null;
      if (req.listing_id) {
        const l = await tx.query('SELECT ST_X(geom) AS lon, ST_Y(geom) AS lat FROM listings WHERE id = $1 AND mls_code = ANY($2)', [
          req.listing_id,
          tenant.mls_codes,
        ]);
        if (!l.rows[0]) throw new BadRequestException('unknown listing');
        point = [l.rows[0].lon, l.rows[0].lat];
      }
      const existing = await tx.query('SELECT id, assigned_agent_id, opted_out_at FROM contacts WHERE phone = $1', [phone]);
      let contactId: string;
      let agentId: string;
      let routedBy = 'existing_contact';
      if (existing.rows[0]) {
        contactId = existing.rows[0].id;
        agentId = existing.rows[0].assigned_agent_id;
        await tx.query(
          `UPDATE contacts SET first_name = $2, last_name = COALESCE($3, last_name), email = COALESCE($4, email),
             consent_sms = consent_sms OR $5, consent_email = consent_email OR $4 IS NOT NULL,
             consent_at = CASE WHEN $5 THEN now() ELSE consent_at END,
             consent_text = CASE WHEN $5 THEN $6 ELSE consent_text END, updated_at = now()
           WHERE id = $1`,
          [contactId, req.first_name, req.last_name ?? null, req.email ?? null, req.consent_sms, CONSENT_TEXT],
        );
      } else {
        const route = await routeLead(tx, point);
        agentId = route.agentId;
        routedBy = route.reason;
        const ins = await tx.query(
          `INSERT INTO contacts (tenant_id, assigned_agent_id, first_name, last_name, phone, email, source, stage, timezone,
             consent_sms, consent_email, consent_at, consent_text)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'new', $8, $9, $10, CASE WHEN $9 THEN now() END, CASE WHEN $9 THEN $11 END)
           RETURNING id`,
          [
            tenant.id, agentId, req.first_name, req.last_name ?? null, phone, req.email ?? null,
            req.saved_search ? 'saved_search' : 'web_inquiry', tenant.timezone, req.consent_sms, !!req.email, CONSENT_TEXT,
          ],
        );
        contactId = ins.rows[0].id;
      }

      await tx.query(
        `INSERT INTO contact_activity (tenant_id, contact_id, kind, listing_id, meta) VALUES ($1, $2, $3, $4, $5)`,
        [tenant.id, contactId, req.saved_search ? 'saved_search' : 'inquiry', req.listing_id ?? null, JSON.stringify({ message: req.message ?? null })],
      );

      let savedSearchId: string | null = null;
      if (req.saved_search) {
        const ss = await tx.query(
          'INSERT INTO saved_searches (tenant_id, contact_id, name, query_text, filters) VALUES ($1, $2, $3, $4, $5) RETURNING id',
          [tenant.id, contactId, req.saved_search.name, req.saved_search.query_text ?? null, JSON.stringify(req.saved_search.filters)],
        );
        savedSearchId = ss.rows[0].id;
      }

      const conv = await this.messaging.ensureConversation(tx, tenant.id, contactId, agentId);
      await tx.query(
        `UPDATE conversations SET
           status = CASE WHEN status IN ('booked', 'closed') THEN 'ai_active' ELSE status END,
           first_inquiry_at = COALESCE(first_inquiry_at, $2),
           inquiry_listing_id = COALESCE($3, inquiry_listing_id), updated_at = now()
         WHERE id = $1`,
        [conv.id, at, req.listing_id ?? null],
      );
      const { rows } = await tx.query(
        `SELECT c.status, c.workflow_id, a.first_name AS agent_first_name FROM conversations c
         LEFT JOIN agents a ON a.id = c.agent_id WHERE c.id = $1`,
        [conv.id],
      );
      await emit(tx, 'engagement.events', contactId, {
        type: existing.rows[0] ? 'lead.inquiry' : 'lead.created',
        tenant_id: tenant.id,
        contact_id: contactId,
        listing_id: req.listing_id ?? null,
        routed_by: routedBy,
      });
      return { contactId, conversationId: conv.id, savedSearchId, status: rows[0].status, agentFirstName: rows[0].agent_first_name, routedBy };
    });

    if (result.savedSearchId && req.saved_search) {
      await this.os.putSavedSearch(result.savedSearchId, percolatorQuery(req.saved_search.filters, tenant.mls_codes), {
        tenant_id: tenant.id,
        contact_id: result.contactId,
      });
    }

    let texting = false;
    if (req.consent_sms && result.status === 'ai_active') {
      try {
        const workflowId = await this.temporal.signalWithStart(
          { tenant_id: tenant.id, contact_id: result.contactId, conversation_id: result.conversationId },
          'new_inquiry',
          [{ listing_id: req.listing_id ?? null, saved_search_id: result.savedSearchId, message: req.message ?? null, at: at.toISOString() }],
        );
        await this.db.withTenant(tenant.id, (tx) =>
          tx.query('UPDATE conversations SET workflow_id = $2 WHERE id = $1 AND workflow_id IS NULL', [result.conversationId, workflowId]),
        );
        texting = true;
      } catch (err) {
        this.log.warn(`workflow start deferred to sweeper: ${(err as Error).message}`);
      }
    }
    return {
      contact_id: result.contactId,
      conversation_id: result.conversationId,
      saved_search_id: result.savedSearchId,
      agent_first_name: result.agentFirstName,
      routed_by: result.routedBy,
      texting,
    };
  }
}
