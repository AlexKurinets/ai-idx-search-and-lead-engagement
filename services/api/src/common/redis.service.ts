import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';
import { config } from '../config';

@Injectable()
export class RedisService implements OnApplicationShutdown {
  readonly client = new Redis(config.redisUrl, { maxRetriesPerRequest: 2, lazyConnect: false });

  async getJson<T>(key: string): Promise<T | null> {
    try {
      const raw = await this.client.get(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      return null;
    }
  }

  async setJson(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    try {
      await this.client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    } catch {
      // A cache write failure must never fail the request.
    }
  }

  async onApplicationShutdown() {
    this.client.disconnect();
  }
}
