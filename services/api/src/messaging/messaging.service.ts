import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { localParts, zonedTime } from '../common/time';
import { toE164 } from '../common/phone';
import { Db, Tx } from '../db/db.service';
import { emit } from '../events/relay.service';
import { Tenant, TenantsService } from '../search/tenants.service';
import { TemporalService, workflowIdFor } from '../temporal/temporal.service';
import { evaluate, keyword, MAX_SMS_CHARS, MessageKind } from './policy';
import { SmsSenderFactory } from './sms-sender';

export type SendResult =
  | { status: 'sent'; message_id: string; responsive: boolean }
  | { status: 'duplicate'; message_id: string }
  | { status: 'deferred'; until: string; reason: string }
  | { status: 'blocked'; reason: string };

@Injectable()
export class MessagingService {
  private readonly log = new Logger('messaging');

  constructor(
    private readonly db: Db,
    private readonly tenants: TenantsService,
    private readonly temporal: TemporalService,
    private readonly senders: SmsSenderFactory,
  ) {}

  /**
   * The only path an outbound SMS takes. The idempotency key is unique per tenant, so a
   * retried workflow activity finds its earlier row instead of texting the lead twice.
   */
  async send(tenantId: string, conversationId: string, body: string, kind: MessageKind, idempotencyKey: string, sentBy?: string): Promise<SendResult> {
    const text = body.trim();
    if (!text) throw new BadRequestException('empty message');
    if (text.length > MAX_SMS_CHARS) throw new BadRequestException(`message exceeds ${MAX_SMS_CHARS} characters`);
    const tenant = await this.tenants.byId(tenantId);
    if (!tenant) throw new NotFoundException('unknown tenant');

    const prepared = await this.db.withTenant(tenantId, async (tx) => {
      const existing = await tx.query('SELECT id, status FROM messages WHERE idempotency_key = $1', [idempotencyKey]);
      if (existing.rows[0] && existing.rows[0].status !== 'failed') {
        return { done: { status: 'duplicate', message_id: existing.rows[0].id } as SendResult };
      }
      const { rows } = await tx.query(
        `SELECT c.id AS conversation_id, c.first_inquiry_at, ct.id AS contact_id, ct.phone, ct.timezone, ct.consent_sms, ct.opted_out_at,
                (SELECT max(created_at) FROM messages m WHERE m.conversation_id = c.id AND m.direction = 'in') AS last_inbound_at
         FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE c.id = $1 FOR UPDATE OF c`,
        [conversationId],
      );
      const conv = rows[0];
      if (!conv) throw new NotFoundException('unknown conversation');
      const now = new Date();
      const local = localParts(now, conv.timezone);
      const midnight = zonedTime(local.year, local.month, local.day, 0, 0, conv.timezone);
      const sentToday = await tx.query(
        `SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1 AND direction = 'out'
           AND created_at >= $2 AND (meta->>'responsive') = 'false'`,
        [conversationId, midnight],
      );
      const decision = evaluate({
        kind,
        now,
        timezone: conv.timezone,
        consentSms: conv.consent_sms,
        optedOutAt: conv.opted_out_at,
        inquiryAt: conv.first_inquiry_at,
        lastInboundAt: conv.last_inbound_at,
        proactiveSentToday: sentToday.rows[0].n,
      });
      if (decision.action === 'block') return { done: { status: 'blocked', reason: decision.reason } as SendResult };
      if (decision.action === 'defer') {
        await tx.query('UPDATE conversations SET next_followup_at = $2 WHERE id = $1', [conversationId, decision.until]);
        return { done: { status: 'deferred', until: decision.until.toISOString(), reason: decision.reason } as SendResult };
      }
      const meta = JSON.stringify({ responsive: decision.responsive, ...(sentBy && { sent_by: sentBy }) });
      const ins = existing.rows[0]
        ? await tx.query("UPDATE messages SET status = 'queued', body = $2 WHERE id = $1 RETURNING id", [existing.rows[0].id, text])
        : await tx.query(
            `INSERT INTO messages (tenant_id, conversation_id, direction, kind, body, idempotency_key, status, meta)
             VALUES ($1, $2, 'out', $3, $4, $5, 'queued', $6) RETURNING id`,
            [tenantId, conversationId, kind, text, idempotencyKey, meta],
          );
      return { messageId: ins.rows[0].id as string, phone: conv.phone as string, contactId: conv.contact_id as string, responsive: decision.responsive };
    });
    if ('done' in prepared) return prepared.done as SendResult;

    let sid: string;
    try {
      ({ sid } = await this.senders.sender.send({ tenantId, from: tenant.sms_number, to: prepared.phone, body: text, idempotencyKey }));
    } catch (err) {
      await this.db.withTenant(tenantId, (tx) => tx.query("UPDATE messages SET status = 'failed' WHERE id = $1", [prepared.messageId]));
      throw err;
    }
    await this.db.withTenant(tenantId, async (tx) => {
      await tx.query("UPDATE messages SET status = 'sent', provider_sid = $2 WHERE id = $1", [prepared.messageId, sid]);
      await tx.query(
        `UPDATE conversations SET last_message_at = now(), updated_at = now(),
           first_response_at = COALESCE(first_response_at, CASE WHEN $2 IN ('first_touch', 'reply', 'agent') THEN now() END)
         WHERE id = $1`,
        [conversationId, kind],
      );
      await tx.query(`INSERT INTO contact_activity (tenant_id, contact_id, kind, meta) VALUES ($1, $2, 'sms_out', $3)`, [
        tenantId,
        prepared.contactId,
        JSON.stringify({ kind }),
      ]);
      await emit(tx, 'engagement.events', prepared.contactId, { type: 'message.sent', tenant_id: tenantId, contact_id: prepared.contactId, kind });
    });
    return { status: 'sent', message_id: prepared.messageId, responsive: prepared.responsive };
  }

  /**
   * Inbound SMS after signature verification. Persisted idempotently on the provider's
   * message id; carrier keywords are handled here deterministically and never reach the
   * model; anything else is signalled to the lead's workflow.
   */
  async inbound(params: { From: string; To: string; Body: string; MessageSid: string }): Promise<{ handled: string }> {
    const tenant = await this.tenants.bySmsNumber(params.To);
    if (!tenant) {
      this.log.warn(`inbound SMS to unknown number ${params.To}`);
      return { handled: 'unknown_number' };
    }
    const from = toE164(params.From);
    if (!from) return { handled: 'bad_sender' };
    const kw = keyword(params.Body);

    const result = await this.db.withTenant(tenant.id, async (tx) => {
      const contact = await this.findOrCreateContact(tx, tenant, from);
      const conv = await this.ensureConversation(tx, tenant.id, contact.id, contact.assigned_agent_id);
      const ins = await tx.query(
        `INSERT INTO messages (tenant_id, conversation_id, direction, kind, body, provider_sid, status)
         VALUES ($1, $2, 'in', $3, $4, $5, 'received') ON CONFLICT (tenant_id, provider_sid) DO NOTHING RETURNING id`,
        [tenant.id, conv.id, kw ? 'keyword' : 'message', params.Body, params.MessageSid],
      );
      if (!ins.rowCount) return { duplicate: true as const };
      await tx.query('UPDATE conversations SET last_message_at = now(), updated_at = now() WHERE id = $1', [conv.id]);
      await tx.query(`INSERT INTO contact_activity (tenant_id, contact_id, kind, meta) VALUES ($1, $2, 'sms_in', '{}')`, [tenant.id, contact.id]);
      if (kw === 'stop') {
        await tx.query('UPDATE contacts SET opted_out_at = now(), consent_sms = false, updated_at = now() WHERE id = $1', [contact.id]);
        await tx.query("UPDATE conversations SET status = 'opted_out', next_followup_at = NULL WHERE id = $1", [conv.id]);
      } else if (kw === 'start') {
        await tx.query('UPDATE contacts SET opted_out_at = NULL, consent_sms = true, consent_at = now(), updated_at = now() WHERE id = $1', [contact.id]);
        await tx.query("UPDATE conversations SET status = 'agent_owned' WHERE id = $1 AND status = 'opted_out'", [conv.id]);
      }
      await emit(tx, 'engagement.events', contact.id, { type: kw ? `keyword.${kw}` : 'message.received', tenant_id: tenant.id, contact_id: contact.id });
      return { duplicate: false as const, messageId: ins.rows[0].id as string, conv, contact };
    });
    if (result.duplicate) return { handled: 'duplicate' };
    const { conv, contact, messageId } = result;

    if (kw) {
      const replies = {
        stop: `${tenant.name}: you're unsubscribed and won't get more texts. Reply START to resubscribe.`,
        start: `${tenant.name}: you're resubscribed. Reply STOP to opt out, HELP for help.`,
        help: `${tenant.name}: real estate updates from your agent. Msg & data rates may apply. Reply STOP to opt out.`,
      };
      await this.send(tenant.id, conv.id, replies[kw], 'confirmation', `kw:${messageId}`);
      if (kw === 'stop' && conv.workflow_id) await this.temporal.signal(conv.workflow_id, 'opted_out');
      return { handled: `keyword_${kw}` };
    }
    if (conv.status !== 'ai_active') {
      await this.notifyAgent(tenant.id, contact.assigned_agent_id, 'inbound_message', `New text from ${contact.first_name}: ${params.Body.slice(0, 120)}`, conv.id);
      return { handled: 'routed_to_agent' };
    }
    const workflowId = await this.temporal.signalWithStart(
      { tenant_id: tenant.id, contact_id: contact.id, conversation_id: conv.id },
      'inbound_message',
      [{ message_id: messageId, body: params.Body, at: new Date().toISOString() }],
    );
    if (!conv.workflow_id) {
      await this.db.withTenant(tenant.id, (tx) => tx.query('UPDATE conversations SET workflow_id = $2 WHERE id = $1', [conv.id, workflowId]));
    }
    return { handled: 'signalled_workflow' };
  }

  private async findOrCreateContact(tx: Tx, tenant: Tenant, phone: string) {
    const found = await tx.query('SELECT id, first_name, assigned_agent_id FROM contacts WHERE phone = $1', [phone]);
    if (found.rows[0]) return found.rows[0];
    const agent = await tx.query('SELECT id FROM agents WHERE active ORDER BY last_assigned_at NULLS FIRST LIMIT 1');
    const ins = await tx.query(
      `INSERT INTO contacts (tenant_id, assigned_agent_id, first_name, phone, source, timezone, consent_sms, consent_at, consent_text)
       VALUES ($1, $2, 'there', $3, 'inbound_sms', $4, true, now(), 'Texted the office number first') RETURNING id, first_name, assigned_agent_id`,
      [tenant.id, agent.rows[0]?.id ?? null, phone, tenant.timezone],
    );
    return ins.rows[0];
  }

  async ensureConversation(tx: Tx, tenantId: string, contactId: string, agentId: string | null) {
    const { rows } = await tx.query(
      `INSERT INTO conversations (tenant_id, contact_id, agent_id, channel) VALUES ($1, $2, $3, 'sms')
       ON CONFLICT (tenant_id, contact_id, channel) DO UPDATE SET updated_at = now()
       RETURNING id, status, workflow_id`,
      [tenantId, contactId, agentId],
    );
    return rows[0] as { id: string; status: string; workflow_id: string | null };
  }

  async notifyAgent(tenantId: string, agentId: string | null, kind: string, body: string, refId: string) {
    await this.db.withTenant(tenantId, (tx) =>
      tx.query('INSERT INTO notifications (tenant_id, agent_id, kind, body, ref_id) VALUES ($1, $2, $3, $4, $5)', [tenantId, agentId, kind, body, refId]),
    );
  }

  /** An agent takes a thread over from the console: the workflow stops replying. */
  async takeover(tenantId: string, conversationId: string, by: string) {
    const conv = await this.db.withTenant(tenantId, async (tx) => {
      const { rows } = await tx.query(
        "UPDATE conversations SET status = 'agent_owned', updated_at = now() WHERE id = $1 RETURNING id, workflow_id",
        [conversationId],
      );
      return rows[0];
    });
    if (!conv) throw new NotFoundException('unknown conversation');
    const signalled = conv.workflow_id ? await this.temporal.signal(conv.workflow_id, 'agent_takeover', [by]) : false;
    return { status: 'agent_owned', workflow_signalled: signalled };
  }

  workflowIdFor(conversationId: string) {
    return workflowIdFor(conversationId);
  }
}
