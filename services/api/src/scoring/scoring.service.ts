import { Injectable, Logger } from '@nestjs/common';
import { AiClient, ScoreInput } from '../common/ai-client';
import { RedisService } from '../common/redis.service';
import { Db } from '../db/db.service';

const INPUT_SQL = `
  SELECT ct.id AS contact_id, ct.stage, ct.opted_out_at IS NOT NULL AS opted_out,
    EXISTS (SELECT 1 FROM appointments a WHERE a.contact_id = ct.id AND a.status = 'booked' AND a.starts_at > now()) AS has_upcoming_appointment,
    (SELECT c.status FROM conversations c WHERE c.contact_id = ct.id ORDER BY c.updated_at DESC LIMIT 1) AS conversation_status,
    (SELECT max(occurred_at) FROM contact_activity x WHERE x.contact_id = ct.id AND x.kind = 'sms_in') AS last_inbound_at,
    (SELECT max(occurred_at) FROM contact_activity x WHERE x.contact_id = ct.id AND x.kind IN ('sms_out', 'email_sent')) AS last_outbound_at,
    (SELECT count(*)::int FROM search_alerts sa WHERE sa.contact_id = ct.id AND sa.created_at > now() - interval '7 days') AS new_matches_7d,
    (SELECT count(*)::int FROM saved_searches ss WHERE ss.contact_id = ct.id) AS saved_searches,
    (SELECT coalesce(json_agg(json_build_object('kind', x.kind, 'at', x.occurred_at, 'intent', x.meta->>'intent') ORDER BY x.occurred_at), '[]'::json)
       FROM contact_activity x WHERE x.contact_id = ct.id AND x.occurred_at > now() - interval '90 days') AS events
  FROM contacts ct
  WHERE ($1::uuid[] IS NULL OR ct.id = ANY($1::uuid[]))
  ORDER BY ct.id`;

export const dirtyKey = (tenantId: string) => `scoring:dirty:${tenantId}`;

/**
 * Gathers each contact's last 90 days of engagement and asks the AI service to score
 * it. The score is transparent: the components come back with it and are stored, so an
 * agent can see why a contact is "cooling" rather than trusting a bare number.
 */
@Injectable()
export class ScoringService {
  private readonly log = new Logger('scoring');

  constructor(
    private readonly db: Db,
    private readonly ai: AiClient,
    private readonly redis: RedisService,
  ) {}

  async scoreTenant(tenantId: string, contactIds: string[] | null = null): Promise<number> {
    const inputs = await this.db.withTenant(tenantId, async (tx) => (await tx.query(INPUT_SQL, [contactIds])).rows as ScoreInput[]);
    let written = 0;
    for (let i = 0; i < inputs.length; i += 400) {
      const batch = inputs.slice(i, i + 400).map((r) => ({
        ...r,
        last_inbound_at: r.last_inbound_at && new Date(r.last_inbound_at).toISOString(),
        last_outbound_at: r.last_outbound_at && new Date(r.last_outbound_at).toISOString(),
      }));
      const { scores } = await this.ai.computeScores(batch);
      await this.db.withTenant(tenantId, async (tx) => {
        await tx.query(
          `INSERT INTO relationship_scores (contact_id, tenant_id, score, band, components, next_action, next_action_reason, computed_at)
           SELECT s.contact_id, $1, s.score, s.band, s.components, s.next_action, s.next_action_reason, now()
           FROM jsonb_to_recordset($2::jsonb) AS s(contact_id uuid, score int, band text, components jsonb, next_action text, next_action_reason text)
           ON CONFLICT (contact_id) DO UPDATE SET score = EXCLUDED.score, band = EXCLUDED.band, components = EXCLUDED.components,
             next_action = EXCLUDED.next_action, next_action_reason = EXCLUDED.next_action_reason, computed_at = now()`,
          [tenantId, JSON.stringify(scores)],
        );
      });
      written += scores.length;
    }
    return written;
  }

  async scoreAll(): Promise<number> {
    const tenants = await this.db.query<{ id: string }>('SELECT id FROM tenants ORDER BY slug');
    let total = 0;
    for (const t of tenants) total += await this.scoreTenant(t.id);
    this.log.log(`scored ${total} contacts across ${tenants.length} offices`);
    return total;
  }

  async scoreDirty(): Promise<number> {
    const tenants = await this.db.query<{ id: string }>('SELECT id FROM tenants');
    let total = 0;
    for (const t of tenants) {
      const ids = await this.redis.client.spop(dirtyKey(t.id), 2000).catch(() => [] as string[]);
      if (ids.length) total += await this.scoreTenant(t.id, ids);
    }
    return total;
  }
}
