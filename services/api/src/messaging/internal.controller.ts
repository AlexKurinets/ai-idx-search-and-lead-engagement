import {
  Body,
  CanActivate,
  ConflictException,
  Controller,
  ExecutionContext,
  Get,
  Headers,
  HttpCode,
  Injectable,
  NotFoundException,
  Param,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import { z } from 'zod';
import { config } from '../config';
import { parseBody } from '../common/validate';
import { Db } from '../db/db.service';
import { emit } from '../events/relay.service';
import { TenantsService } from '../search/tenants.service';
import { MessagingService } from './messaging.service';
import { availableSlots } from './slots';

@Injectable()
export class InternalGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const token = ctx.switchToHttp().getRequest().headers['x-internal-token'];
    const a = Buffer.from(String(token ?? ''));
    const b = Buffer.from(config.internalToken);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new UnauthorizedException();
    return true;
  }
}

const SendBody = z.object({
  tenant_id: z.string().uuid(),
  conversation_id: z.string().uuid(),
  body: z.string().min(1).max(306),
  kind: z.enum(['first_touch', 'reply', 'followup']),
  idempotency_key: z.string().min(8).max(200),
});

const TurnBody = z.object({
  tenant_id: z.string().uuid(),
  inbound_message_ids: z.array(z.string().uuid()).default([]),
  intent: z.string().max(40),
  extracted: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
  proposed_slots: z.array(z.string()).optional(),
  stage: z.string().max(30).optional(),
});

const TenantBody = z.object({ tenant_id: z.string().uuid() });

export function slotLabel(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long', hour: 'numeric', minute: '2-digit' })
    .format(new Date(iso))
    .replace(':00', '');
}

/** Endpoints the Temporal activities call. The AI layer never writes to Postgres directly. */
@Controller('internal')
@UseGuards(InternalGuard)
export class InternalController {
  constructor(
    private readonly db: Db,
    private readonly messaging: MessagingService,
    private readonly tenants: TenantsService,
  ) {}

  @Get('conversations/:id/context')
  async context(@Param('id') id: string, @Headers('x-tenant-id') tenantId: string) {
    const tenant = await this.tenants.byId(tenantId);
    if (!tenant) throw new NotFoundException('unknown tenant');
    return this.db.withTenant(tenantId, async (tx) => {
      const { rows } = await tx.query(
        `SELECT c.id, c.status, c.proposed_slots, c.first_inquiry_at, c.inquiry_listing_id, c.agent_id,
                ct.id AS contact_id, ct.first_name, ct.qualification, ct.stage, ct.source, ct.timezone,
                a.first_name AS agent_first_name, a.last_name AS agent_last_name, a.showing_hours, a.work_days
         FROM conversations c JOIN contacts ct ON ct.id = c.contact_id LEFT JOIN agents a ON a.id = c.agent_id
         WHERE c.id = $1`,
        [id],
      );
      const c = rows[0];
      if (!c) throw new NotFoundException('unknown conversation');
      const messages = await tx.query(
        `SELECT id, direction, kind, body, intent, created_at FROM (
           SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 20) m ORDER BY created_at`,
        [id],
      );
      let listing = null;
      let matches: unknown[] = [];
      if (c.inquiry_listing_id) {
        const l = await tx.query(
          `SELECT l.id, CASE WHEN l.idx_address THEN l.address_line END AS address, l.list_price AS price, l.beds, l.baths,
                  l.living_area_sqft AS sqft, l.status, l.features, n.name AS neighborhood, l.neighborhood_id, l.property_sub_type
           FROM listings l LEFT JOIN neighborhoods n ON n.id = l.neighborhood_id WHERE l.id = $1`,
          [c.inquiry_listing_id],
        );
        listing = l.rows[0] ?? null;
        if (listing) {
          const m = await tx.query(
            `SELECT l.id, CASE WHEN l.idx_address THEN l.address_line END AS address, l.list_price AS price, l.beds, l.baths
             FROM listings l WHERE l.neighborhood_id = $1 AND l.id <> $2 AND l.status = 'Active' AND l.removed_at IS NULL
               AND l.idx_entire AND l.list_price BETWEEN $3 * 0.85 AND $3 * 1.15 AND l.beds >= $4
             ORDER BY l.original_entry_ts DESC LIMIT 3`,
            [listing.neighborhood_id, listing.id, listing.price, Math.max(0, (listing.beds ?? 1) - 1)],
          );
          matches = m.rows;
        }
      }
      const booked = await tx.query("SELECT starts_at FROM appointments WHERE agent_id = $1 AND status = 'booked' AND starts_at > now()", [c.agent_id]);
      const slots = c.agent_id
        ? availableSlots({ showingHours: c.showing_hours, workDays: c.work_days }, c.timezone, new Date(), booked.rows.map((r) => r.starts_at))
        : [];
      const proposed: string[] = c.proposed_slots ?? [];
      return {
        now: new Date().toISOString(),
        tenant: { id: tenant.id, name: tenant.name, timezone: tenant.timezone },
        conversation: { id: c.id, status: c.status, first_inquiry_at: c.first_inquiry_at, proposed_slots: proposed },
        contact: { id: c.contact_id, first_name: c.first_name, qualification: c.qualification, stage: c.stage, source: c.source },
        agent: c.agent_id ? { id: c.agent_id, first_name: c.agent_first_name, last_name: c.agent_last_name } : null,
        listing,
        matches,
        messages: messages.rows,
        available_slots: slots,
        slot_labels: Object.fromEntries([...new Set([...slots, ...proposed])].map((s) => [s, slotLabel(s, c.timezone)])),
      };
    });
  }

  @Post('messages/send')
  @HttpCode(200)
  async send(@Body() body: unknown) {
    const b = parseBody(SendBody, body);
    return this.messaging.send(b.tenant_id, b.conversation_id, b.body, b.kind, b.idempotency_key);
  }

  @Post('conversations/:id/turn')
  @HttpCode(200)
  async turn(@Param('id') id: string, @Body() body: unknown) {
    const b = parseBody(TurnBody, body);
    return this.db.withTenant(b.tenant_id, async (tx) => {
      const { rows } = await tx.query('SELECT contact_id FROM conversations WHERE id = $1', [id]);
      if (!rows[0]) throw new NotFoundException('unknown conversation');
      if (b.inbound_message_ids.length) {
        await tx.query('UPDATE messages SET intent = $2 WHERE id = ANY($1::uuid[])', [b.inbound_message_ids, b.intent]);
      }
      const extracted = Object.fromEntries(Object.entries(b.extracted).filter(([, v]) => v !== null));
      await tx.query(
        `UPDATE contacts SET qualification = qualification || $2::jsonb, stage = COALESCE($3, stage), updated_at = now() WHERE id = $1`,
        [rows[0].contact_id, JSON.stringify(extracted), b.stage ?? null],
      );
      if (b.proposed_slots) {
        await tx.query('UPDATE conversations SET proposed_slots = $2 WHERE id = $1', [id, JSON.stringify(b.proposed_slots)]);
      }
      await tx.query(`INSERT INTO contact_activity (tenant_id, contact_id, kind, meta) VALUES ($1, $2, 'ai_turn', $3)`, [
        b.tenant_id,
        rows[0].contact_id,
        JSON.stringify({ intent: b.intent }),
      ]);
      return { ok: true };
    });
  }

  @Post('conversations/:id/appointment')
  @HttpCode(200)
  async book(@Param('id') id: string, @Body() body: unknown) {
    const b = parseBody(TenantBody.extend({ starts_at: z.string().datetime() }), body);
    try {
      return await this.db.withTenant(b.tenant_id, async (tx) => {
        const { rows } = await tx.query(
          `SELECT c.contact_id, c.agent_id, c.inquiry_listing_id, ct.first_name FROM conversations c
           JOIN contacts ct ON ct.id = c.contact_id WHERE c.id = $1`,
          [id],
        );
        const c = rows[0];
        if (!c) throw new NotFoundException('unknown conversation');
        const appt = await tx.query(
          `INSERT INTO appointments (tenant_id, contact_id, agent_id, listing_id, conversation_id, starts_at, source)
           VALUES ($1, $2, $3, $4, $5, $6, 'ai') RETURNING id`,
          [b.tenant_id, c.contact_id, c.agent_id, c.inquiry_listing_id, id, b.starts_at],
        );
        await tx.query("UPDATE conversations SET status = 'booked', next_followup_at = NULL, updated_at = now() WHERE id = $1", [id]);
        await tx.query("UPDATE contacts SET stage = 'appointment', updated_at = now() WHERE id = $1", [c.contact_id]);
        await tx.query(`INSERT INTO contact_activity (tenant_id, contact_id, kind, listing_id, meta) VALUES ($1, $2, 'appointment_booked', $3, $4)`, [
          b.tenant_id,
          c.contact_id,
          c.inquiry_listing_id,
          JSON.stringify({ starts_at: b.starts_at, appointment_id: appt.rows[0].id }),
        ]);
        await tx.query('INSERT INTO notifications (tenant_id, agent_id, kind, body, ref_id) VALUES ($1, $2, $3, $4, $5)', [
          b.tenant_id,
          c.agent_id,
          'appointment_booked',
          `${c.first_name} booked a showing for ${b.starts_at}`,
          appt.rows[0].id,
        ]);
        await emit(tx, 'engagement.events', c.contact_id, {
          type: 'appointment.booked',
          tenant_id: b.tenant_id,
          contact_id: c.contact_id,
          appointment_id: appt.rows[0].id,
          starts_at: b.starts_at,
        });
        return { appointment_id: appt.rows[0].id };
      });
    } catch (err: any) {
      if (err?.code === '23505') throw new ConflictException('slot no longer available');
      throw err;
    }
  }

  @Post('conversations/:id/handoff')
  @HttpCode(200)
  async handoff(@Param('id') id: string, @Body() body: unknown) {
    const b = parseBody(TenantBody.extend({ reason: z.string().max(60), summary: z.string().max(600) }), body);
    return this.db.withTenant(b.tenant_id, async (tx) => {
      const { rows } = await tx.query(
        `UPDATE conversations SET status = 'handed_off', handoff_reason = $2, next_followup_at = NULL, updated_at = now()
         WHERE id = $1 RETURNING contact_id, agent_id`,
        [id, b.reason],
      );
      if (!rows[0]) throw new NotFoundException('unknown conversation');
      await tx.query('INSERT INTO notifications (tenant_id, agent_id, kind, body, ref_id) VALUES ($1, $2, $3, $4, $5)', [
        b.tenant_id,
        rows[0].agent_id,
        'handoff',
        b.summary,
        id,
      ]);
      await emit(tx, 'engagement.events', rows[0].contact_id, { type: 'conversation.handoff', tenant_id: b.tenant_id, contact_id: rows[0].contact_id, reason: b.reason });
      return { ok: true };
    });
  }

  @Post('conversations/:id/state')
  @HttpCode(200)
  async state(@Param('id') id: string, @Body() body: unknown) {
    const b = parseBody(
      TenantBody.extend({ status: z.enum(['ai_active', 'closed']).optional(), next_followup_at: z.string().datetime().nullable().optional() }),
      body,
    );
    return this.db.withTenant(b.tenant_id, async (tx) => {
      await tx.query(
        `UPDATE conversations SET status = COALESCE($2, status),
           next_followup_at = CASE WHEN $3::boolean THEN $4::timestamptz ELSE next_followup_at END, updated_at = now()
         WHERE id = $1 AND status IN ('ai_active', 'closed')`,
        [id, b.status ?? null, b.next_followup_at !== undefined, b.next_followup_at ?? null],
      );
      return { ok: true };
    });
  }
}
