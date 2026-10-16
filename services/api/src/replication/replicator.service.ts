import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { config } from '../config';
import { Db } from '../db/db.service';
import { advance, CURSOR_ORDER, cursorFilter, Cursor, keyScanFilter } from './cursor';
import { loadMapping, Mapping, mapRecord } from './mapping';
import { ResoClient } from './reso-client';
import { markRemoved, recordIssues, upsertListings } from './upsert';

interface Market {
  code: string;
  client: ResoClient;
  mapping: Mapping;
}

/**
 * Pulls each MLS incrementally on its own loop. Every page commits the listings, their
 * outbox events, any mapping issues and the advanced cursor in one transaction, so a
 * crash mid-run resumes from the last committed page with nothing lost or doubled.
 */
@Injectable()
export class ReplicatorService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('replicator');
  private markets: Market[] = [];
  private stopped = false;
  private timers: NodeJS.Timeout[] = [];

  constructor(private readonly db: Db) {}

  async onApplicationBootstrap() {
    if (!config.workerRoles.includes('replicator')) return;
    const sources = await this.db.platformQuery<{ code: string; base_url: string }>(
      'SELECT code, base_url FROM mls_sources ORDER BY code',
    );
    this.markets = sources.map((s) => ({
      code: s.code,
      client: new ResoClient(s.code, s.base_url, `${s.code.toLowerCase()}-replicator`, config.mlsClientSecret),
      mapping: loadMapping(s.code),
    }));
    for (const m of this.markets) {
      void this.loop(m);
      void this.reconcileLoop(m);
    }
    this.log.log(`replicating ${this.markets.map((m) => m.code).join(', ')}`);
  }

  onApplicationShutdown() {
    this.stopped = true;
    this.timers.forEach(clearTimeout);
  }

  private wait(ms: number) {
    return new Promise<void>((resolve) => this.timers.push(setTimeout(resolve, ms)));
  }

  private async loop(m: Market) {
    while (!this.stopped) {
      try {
        await this.runOnce(m);
      } catch (err) {
        this.log.error(`${m.code} run failed: ${(err as Error).message}`);
        await this.db.platformQuery('UPDATE replication_state SET last_error = $2, last_run_at = now() WHERE mls_code = $1', [
          m.code,
          (err as Error).message.slice(0, 500),
        ]);
      }
      await this.wait(config.replicationIntervalMs);
    }
  }

  async runOnce(m: Market): Promise<{ pages: number; records: number }> {
    const [state] = await this.db.platformQuery<{ cursor_ts: Date; cursor_key: string; backfill_complete: boolean }>(
      'SELECT cursor_ts, cursor_key, backfill_complete FROM replication_state WHERE mls_code = $1',
      [m.code],
    );
    const backfill = !state.backfill_complete;
    const kind = backfill ? 'backfill' : 'incremental';
    let cursor: Cursor = { ts: state.cursor_ts.toISOString(), key: state.cursor_key };
    const [run] = await this.db.platformQuery<{ id: number }>(
      'INSERT INTO replication_runs (mls_code, kind, started_at) VALUES ($1, $2, now()) RETURNING id',
      [m.code, kind],
    );

    let pages = 0;
    let records = 0;
    let throttled = 0;
    const top = config.replicationPageSize;
    for (;;) {
      const page = await m.client.property<Record<string, any>>({ filter: cursorFilter(cursor), orderby: CURSOR_ORDER, top });
      throttled += page.throttled;
      if (page.value.length === 0) break;
      const mapped = page.value.map((r) => mapRecord(m.mapping, r));
      const next = advance(cursor, page.value as { ModificationTimestamp: string; ListingKey: string }[]);
      await this.db.platformTx(async (tx) => {
        await upsertListings(tx, mapped.map((x) => x.listing), { backfill });
        await recordIssues(tx, m.code, mapped.flatMap((x) => x.issues));
        await tx.query(
          `UPDATE replication_state SET cursor_ts = $2, cursor_key = $3, records_total = records_total + $4,
             throttled_total = throttled_total + $5 WHERE mls_code = $1`,
          [m.code, next.ts, next.key, page.value.length, page.throttled],
        );
      });
      cursor = next;
      pages++;
      records += page.value.length;
      if (page.value.length < top) break;
    }

    await this.db.platformTx(async (tx) => {
      await tx.query(
        `UPDATE replication_state SET last_run_at = now(), last_success_at = now(), last_error = NULL,
           backfill_complete = true WHERE mls_code = $1`,
        [m.code],
      );
      await tx.query(
        'UPDATE replication_runs SET finished_at = now(), pages = $2, records = $3, throttled = $4 WHERE id = $1',
        [run.id, pages, records, throttled],
      );
    });
    if (records > 0) this.log.log(`${m.code} ${kind}: ${records} records in ${pages} pages`);
    return { pages, records };
  }

  private async reconcileLoop(m: Market) {
    while (!this.stopped) {
      await this.wait(config.reconcileIntervalMs);
      if (this.stopped) return;
      try {
        await this.reconcile(m);
      } catch (err) {
        this.log.error(`${m.code} reconcile failed: ${(err as Error).message}`);
      }
    }
  }

  /**
   * Listings can vanish from a feed without a status change. Compare every key the MLS
   * still serves with what we hold, and remove the ones it no longer has. Only rows
   * replicated before the scan started are candidates, so a listing created mid-scan
   * is never removed by mistake.
   */
  async reconcile(m: Market): Promise<number> {
    const startedAt = new Date();
    const [state] = await this.db.platformQuery<{ backfill_complete: boolean }>(
      'SELECT backfill_complete FROM replication_state WHERE mls_code = $1',
      [m.code],
    );
    if (!state.backfill_complete) return 0;
    const [run] = await this.db.platformQuery<{ id: number }>(
      "INSERT INTO replication_runs (mls_code, kind, started_at) VALUES ($1, 'reconcile', $2) RETURNING id",
      [m.code, startedAt],
    );
    const live = new Set<string>();
    let after = '';
    let pages = 0;
    for (;;) {
      const page = await m.client.property<{ ListingKey: string }>({
        filter: keyScanFilter(after),
        orderby: 'ListingKey asc',
        select: 'ListingKey',
        top: 1000,
      });
      pages++;
      page.value.forEach((r) => live.add(r.ListingKey));
      if (page.value.length < 1000) break;
      after = page.value[page.value.length - 1].ListingKey;
    }
    const held = await this.db.platformQuery<{ listing_key: string }>(
      'SELECT listing_key FROM listings WHERE mls_code = $1 AND removed_at IS NULL AND replicated_at < $2',
      [m.code, startedAt],
    );
    const missing = held.map((r) => r.listing_key).filter((k) => !live.has(k));
    const removed = await this.db.platformTx(async (tx) => {
      const n = await markRemoved(tx, m.code, missing);
      await tx.query(
        `UPDATE replication_state SET last_reconcile_at = now(), removed_by_reconcile = removed_by_reconcile + $2
         WHERE mls_code = $1`,
        [m.code, n],
      );
      await tx.query('UPDATE replication_runs SET finished_at = now(), pages = $2, records = $3, removed = $4 WHERE id = $1', [
        run.id,
        pages,
        live.size,
        n,
      ]);
      return n;
    });
    if (removed > 0) this.log.log(`${m.code} reconcile removed ${removed} listings no longer in the feed`);
    return removed;
  }

  /** Exposed for ops and tests. */
  market(code: string): Market | undefined {
    return this.markets.find((m) => m.code === code);
  }
}
