import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { Admin, Consumer, Kafka, logLevel, Producer } from 'kafkajs';
import { config } from '../config';

export const TOPICS = ['listing.events', 'engagement.events'];

@Injectable()
export class KafkaService implements OnApplicationShutdown {
  private readonly log = new Logger('kafka');
  readonly kafka = new Kafka({
    clientId: 'idx-platform',
    brokers: config.kafkaBrokers,
    logLevel: logLevel.WARN,
    retry: { retries: 10, initialRetryTime: 300 },
  });
  private producer?: Promise<Producer>;
  private consumers: Consumer[] = [];
  private admin?: Promise<Admin>;
  private topics?: Promise<void>;

  /** Creates the topics once per process; concurrent callers share the same promise. */
  ensureTopics(): Promise<void> {
    this.topics ??= (async () => {
      const admin = await this.getAdmin();
      const existing = new Set(await admin.listTopics());
      const missing = TOPICS.filter((t) => !existing.has(t));
      if (missing.length) {
        await admin.createTopics({ topics: missing.map((topic) => ({ topic, numPartitions: 6, replicationFactor: 1 })) });
        this.log.log(`created topics ${missing.join(', ')}`);
      }
    })().catch((err) => {
      this.topics = undefined;
      throw err;
    });
    return this.topics;
  }

  // Memoized connect promises: two callers must never share a client before it connects.
  getProducer(): Promise<Producer> {
    this.producer ??= (async () => {
      const p = this.kafka.producer({ idempotent: true, maxInFlightRequests: 1 });
      await p.connect();
      return p;
    })().catch((err) => {
      this.producer = undefined;
      throw err;
    });
    return this.producer;
  }

  getAdmin(): Promise<Admin> {
    this.admin ??= (async () => {
      const a = this.kafka.admin();
      await a.connect();
      return a;
    })().catch((err) => {
      this.admin = undefined;
      throw err;
    });
    return this.admin;
  }

  consumer(groupId: string): Consumer {
    const c = this.kafka.consumer({ groupId, sessionTimeout: 30_000, maxBytesPerPartition: 4 * 1024 * 1024 });
    this.consumers.push(c);
    return c;
  }

  /** Total lag across partitions for a consumer group on a topic. */
  async groupLag(groupId: string, topic: string): Promise<number | null> {
    try {
      const admin = await this.getAdmin();
      const [ends, committed] = await Promise.all([
        admin.fetchTopicOffsets(topic),
        admin.fetchOffsets({ groupId, topics: [topic] }),
      ]);
      const done = new Map(committed[0]?.partitions.map((p) => [p.partition, Number(p.offset)]) ?? []);
      return ends.reduce((sum, p) => {
        const c = done.get(p.partition) ?? -1;
        return sum + Math.max(0, Number(p.high) - (c < 0 ? Number(p.low) : c));
      }, 0);
    } catch {
      return null;
    }
  }

  async onApplicationShutdown() {
    await Promise.allSettled([
      ...this.consumers.map((c) => c.disconnect()),
      this.producer?.then((p) => p.disconnect()),
      this.admin?.then((a) => a.disconnect()),
    ]);
  }
}
