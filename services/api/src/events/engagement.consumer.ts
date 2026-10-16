import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { config } from '../config';
import { RedisService } from '../common/redis.service';
import { Db } from '../db/db.service';
import { dirtyKey, ScoringService } from '../scoring/scoring.service';
import { TemporalService } from '../temporal/temporal.service';
import { KafkaService } from './kafka.service';

interface EngagementEvent {
  type: string;
  tenant_id: string;
  contact_id?: string;
  listing_id?: string;
  [k: string]: unknown;
}

const CRM_EVENTS = new Set([
  'lead.created', 'lead.inquiry', 'appointment.booked', 'conversation.handoff', 'keyword.stop', 'farm_report.sent',
]);

/**
 * Consumers of engagement.events. Each one is idempotent or tolerant of a replay:
 * the CRM adapter (sandboxed here) receives lifecycle events, saved-search alerts become
 * an email digest, and every touched contact is marked for rescoring.
 */
@Injectable()
export class EngagementConsumer implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('engagement');
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly db: Db,
    private readonly kafka: KafkaService,
    private readonly redis: RedisService,
    private readonly scoring: ScoringService,
    private readonly temporal: TemporalService,
  ) {}

  async onApplicationBootstrap() {
    if (config.workerRoles.includes('engagement')) {
      await this.kafka.ensureTopics();
      const consumer = this.kafka.consumer('engagement');
      await consumer.connect();
      await consumer.subscribe({ topic: 'engagement.events', fromBeginning: true });
      await consumer.run({
        eachMessage: async ({ partition, message }) => {
          const e = JSON.parse(message.value!.toString()) as EngagementEvent;
          await this.handle(e, `${partition}:${message.offset}`);
        },
      });
    }
    if (config.workerRoles.includes('scheduler')) {
      this.every(config.scoringIntervalMs, () => this.scoring.scoreDirty());
      this.every(30_000, () => this.sweepUnstartedWorkflows());
    }
  }

  onApplicationShutdown() {
    this.timers.forEach(clearInterval);
  }

  private every(ms: number, fn: () => Promise<unknown>) {
    let running = false;
    this.timers.push(
      setInterval(async () => {
        if (running) return;
        running = true;
        try {
          await fn();
        } catch (err) {
          this.log.warn(`scheduled job failed: ${(err as Error).message}`);
        } finally {
          running = false;
        }
      }, ms),
    );
  }

  async handle(e: EngagementEvent, position: string) {
    if (e.contact_id) await this.redis.client.sadd(dirtyKey(e.tenant_id), e.contact_id).catch(() => undefined);
    if (CRM_EVENTS.has(e.type)) {
      await this.db.withTenant(e.tenant_id, (tx) =>
        tx.query(
          `INSERT INTO crm_sync_log (tenant_id, event_type, contact_id, payload)
           SELECT $1, $2, $3, $4 WHERE NOT EXISTS (SELECT 1 FROM crm_sync_log WHERE payload->>'position' = $5 AND event_type = $2)`,
          [e.tenant_id, e.type, e.contact_id ?? null, JSON.stringify({ ...e, position }), position],
        ),
      );
    }
    if (e.type === 'alert.sent' && e.contact_id && e.listing_id) {
      await this.db.withTenant(e.tenant_id, async (tx) => {
        const { rows } = await tx.query(
          `SELECT ct.first_name, ct.consent_email, l.list_price, CASE WHEN l.idx_address THEN l.address_line ELSE 'Address withheld' END AS address,
                  n.name AS neighborhood
           FROM contacts ct, listings l LEFT JOIN neighborhoods n ON n.id = l.neighborhood_id
           WHERE ct.id = $1 AND l.id = $2`,
          [e.contact_id, e.listing_id],
        );
        const r = rows[0];
        if (!r?.consent_email) return;
        // Every match is recorded as an alert, but a contact gets at most one alert email
        // an hour; the rest wait for the next one rather than flooding the inbox.
        const recent = await tx.query(
          "SELECT 1 FROM outbound_email WHERE contact_id = $1 AND kind = 'search_alert' AND created_at > now() - interval '1 hour' LIMIT 1",
          [e.contact_id],
        );
        if (recent.rowCount) return;
        const what = e.reason === 'price_reduced' ? 'Price drop' : 'New listing';
        await tx.query('INSERT INTO outbound_email (tenant_id, contact_id, kind, subject, body) VALUES ($1, $2, $3, $4, $5)', [
          e.tenant_id,
          e.contact_id,
          'search_alert',
          `${what} in ${r.neighborhood ?? 'your search'}`,
          `Hi ${r.first_name}, ${r.address} matches your saved search at $${Number(r.list_price).toLocaleString('en-US')}.`,
        ]);
      });
    }
  }

  /** Starts the workflow for any consented inquiry whose start failed after commit. */
  async sweepUnstartedWorkflows() {
    const rows = await this.db.platformQuery<{ id: string; tenant_id: string; contact_id: string }>(
      `SELECT c.id, c.tenant_id, c.contact_id FROM conversations c JOIN contacts ct ON ct.id = c.contact_id
       WHERE c.status = 'ai_active' AND c.workflow_id IS NULL AND c.first_inquiry_at < now() - interval '30 seconds'
         AND ct.consent_sms AND ct.opted_out_at IS NULL LIMIT 50`,
    );
    for (const r of rows) {
      const workflowId = await this.temporal.signalWithStart(
        { tenant_id: r.tenant_id, contact_id: r.contact_id, conversation_id: r.id },
        'new_inquiry',
        [{ listing_id: null, saved_search_id: null, message: null, at: new Date().toISOString(), swept: true }],
      );
      await this.db.platformQuery('UPDATE conversations SET workflow_id = $2 WHERE id = $1', [r.id, workflowId]);
    }
    if (rows.length) this.log.log(`swept ${rows.length} unstarted workflows`);
  }
}
