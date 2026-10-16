import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { config } from '../config';
import { Db, Tx } from '../db/db.service';
import { KafkaService } from './kafka.service';

/** Writes an event into the outbox inside the caller's transaction. */
export async function emit(tx: Tx, topic: string, key: string, payload: Record<string, unknown>): Promise<void> {
  await tx.query('INSERT INTO outbox (topic, key, payload) VALUES ($1, $2, $3)', [topic, key, JSON.stringify(payload)]);
}

/**
 * The transactional outbox relay. Business writes and their events commit together in
 * Postgres; this loop publishes committed rows to Kafka and only then marks them
 * published. A crash between the two re-sends rows, so delivery is at-least-once and
 * every consumer is idempotent. Rows are keyed by aggregate id, so all events for one
 * listing or one contact land on the same partition in order.
 */
@Injectable()
export class RelayService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('outbox-relay');
  private stopped = false;
  published = 0;

  constructor(
    private readonly db: Db,
    private readonly kafka: KafkaService,
  ) {}

  async onApplicationBootstrap() {
    if (!config.workerRoles.includes('relay')) return;
    await this.kafka.ensureTopics();
    void this.loop();
  }

  onApplicationShutdown() {
    this.stopped = true;
  }

  private async loop() {
    let lastPrune = 0;
    while (!this.stopped) {
      let sent = 0;
      try {
        sent = await this.publishBatch(1000);
        if (Date.now() - lastPrune > 600_000) {
          await this.db.platformQuery("DELETE FROM outbox WHERE published_at < now() - interval '1 day'");
          lastPrune = Date.now();
        }
      } catch (err) {
        this.log.error(`relay batch failed, will retry: ${(err as Error).message}`);
        await new Promise((r) => setTimeout(r, 2000));
      }
      if (sent < 1000) await new Promise((r) => setTimeout(r, 250));
    }
  }

  async publishBatch(limit: number): Promise<number> {
    const producer = await this.kafka.getProducer();
    return this.db.platformTx(async (tx) => {
      const { rows } = await tx.query<{ id: string; topic: string; key: string; payload: unknown }>(
        `SELECT id, topic, key, payload FROM outbox WHERE published_at IS NULL
         ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`,
        [limit],
      );
      if (rows.length === 0) return 0;
      const byTopic = new Map<string, { key: string; value: string }[]>();
      for (const r of rows) {
        const list = byTopic.get(r.topic) ?? [];
        list.push({ key: r.key, value: JSON.stringify(r.payload) });
        byTopic.set(r.topic, list);
      }
      await producer.sendBatch({
        acks: -1,
        topicMessages: [...byTopic.entries()].map(([topic, messages]) => ({ topic, messages })),
      });
      await tx.query('UPDATE outbox SET published_at = clock_timestamp() WHERE id = ANY($1::bigint[])', [
        rows.map((r) => r.id),
      ]);
      this.published += rows.length;
      return rows.length;
    });
  }
}
