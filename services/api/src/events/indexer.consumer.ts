import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { config } from '../config';
import { Db } from '../db/db.service';
import { isIndexable, LISTING_DOC_SQL, ListingRow, OpenSearchService, toDocument } from '../search/opensearch.service';
import { emit } from './relay.service';
import { KafkaService } from './kafka.service';

interface ListingEvent {
  type: 'upserted' | 'removed';
  listing_id: string;
  mls: string;
  change: 'created' | 'price_reduced' | 'back_on_market' | 'status_changed' | 'updated' | 'removed';
  modification_ts: string;
  replicated_at?: string;
  backfill: boolean;
}

const ALERT_CHANGES = new Set(['created', 'price_reduced', 'back_on_market']);

/**
 * Consumes listing.events and keeps OpenSearch in step with Postgres. Each batch reads
 * the current rows rather than trusting event payloads, writes them with external
 * versioning so a late event cannot regress a document, records end-to-end lag for
 * incremental changes, and percolates new listings and price drops against saved
 * searches to raise alerts.
 */
@Injectable()
export class IndexerConsumer implements OnApplicationBootstrap {
  private readonly log = new Logger('indexer');

  constructor(
    private readonly db: Db,
    private readonly kafka: KafkaService,
    private readonly os: OpenSearchService,
  ) {}

  async onApplicationBootstrap() {
    if (!config.workerRoles.includes('indexer')) return;
    await this.os.ensureIndices();
    await this.kafka.ensureTopics();
    const consumer = this.kafka.consumer('indexer');
    await consumer.connect();
    await consumer.subscribe({ topic: 'listing.events', fromBeginning: true });
    await consumer.run({
      eachBatchAutoResolve: false,
      eachBatch: async ({ batch, resolveOffset, heartbeat, commitOffsetsIfNecessary }) => {
        const chunk = 1000;
        for (let i = 0; i < batch.messages.length; i += chunk) {
          const slice = batch.messages.slice(i, i + chunk);
          const events = slice.map((m) => JSON.parse(m.value!.toString()) as ListingEvent);
          await this.handle(events);
          resolveOffset(slice[slice.length - 1].offset);
          await heartbeat();
        }
        await commitOffsetsIfNecessary();
      },
    });
  }

  async handle(events: ListingEvent[]): Promise<void> {
    // Collapse to the latest event per listing within the batch.
    const latest = new Map<string, ListingEvent>();
    for (const e of events) latest.set(e.listing_id, e);
    const ids = [...latest.keys()];
    const rows = await this.db.platformQuery<ListingRow>(`${LISTING_DOC_SQL} WHERE l.id = ANY($1::uuid[])`, [ids]);
    const byId = new Map(rows.map((r) => [r.id, r]));

    const upserts: { doc: Record<string, unknown>; version: number; event: ListingEvent }[] = [];
    const deletes: { id: string; version: number }[] = [];
    for (const [id, e] of latest) {
      const row = byId.get(id);
      const version = new Date(e.modification_ts).getTime();
      if (!row || e.type === 'removed' || !isIndexable(row)) {
        deletes.push({ id, version });
      } else {
        upserts.push({ doc: toDocument(row), version: row.modification_ts.getTime(), event: e });
      }
    }
    const result = await this.os.bulk(upserts, deletes);
    if (result.errors) this.log.warn(`bulk had ${result.errors} errors`);

    const incremental = upserts.filter((u) => !u.event.backfill && u.event.replicated_at);
    if (incremental.length) {
      await this.db.platformQuery(
        `INSERT INTO pipeline_lag_samples (listing_id, mls_code, mls_modified_at, replicated_at)
         SELECT * FROM unnest($1::uuid[], $2::text[], $3::timestamptz[], $4::timestamptz[])`,
        [
          incremental.map((u) => u.doc.id),
          incremental.map((u) => u.event.mls),
          incremental.map((u) => u.event.modification_ts),
          incremental.map((u) => u.event.replicated_at),
        ],
      );
    }

    const alertable = upserts.filter((u) => !u.event.backfill && ALERT_CHANGES.has(u.event.change));
    if (alertable.length) await this.raiseAlerts(alertable);
  }

  private async raiseAlerts(items: { doc: Record<string, unknown>; event: ListingEvent }[]) {
    const docs = items.map((i) => i.doc);
    const matches = await this.os.percolate(docs);
    let raised = 0;
    for (const [slot, hits] of matches) {
      const item = items[slot];
      for (const hit of hits) {
        await this.db.platformTx(async (tx) => {
          const res = await tx.query(
            `INSERT INTO search_alerts (tenant_id, saved_search_id, contact_id, listing_id, reason)
             VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING RETURNING id`,
            [hit.tenantId, hit.savedSearchId, hit.contactId, item.doc.id, item.event.change],
          );
          if (!res.rowCount) return;
          raised++;
          await tx.query(
            `INSERT INTO contact_activity (tenant_id, contact_id, kind, listing_id, meta)
             VALUES ($1, $2, 'alert_sent', $3, $4)`,
            [hit.tenantId, hit.contactId, item.doc.id, JSON.stringify({ reason: item.event.change, saved_search_id: hit.savedSearchId })],
          );
          await tx.query('UPDATE saved_searches SET last_alert_at = now() WHERE id = $1', [hit.savedSearchId]);
          await emit(tx, 'engagement.events', hit.contactId, {
            type: 'alert.sent',
            tenant_id: hit.tenantId,
            contact_id: hit.contactId,
            listing_id: item.doc.id,
            reason: item.event.change,
          });
        });
      }
    }
    if (raised) this.log.log(`raised ${raised} saved-search alerts`);
  }
}
