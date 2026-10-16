import { Global, Injectable, Module, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient, types } from 'pg';
import { config } from '../config';

// numeric -> number and bigint -> number; every value we store fits comfortably.
types.setTypeParser(types.builtins.NUMERIC, (v) => (v === null ? null : Number(v)));
types.setTypeParser(types.builtins.INT8, (v) => (v === null ? null : Number(v)));

export type Tx = PoolClient;

/**
 * Two pools, two Postgres roles.
 *
 * `idx_app` has no BYPASSRLS, so every tenant query runs inside withTenant(), which sets
 * app.tenant_id for the transaction only (set_config(..., true) is SET LOCAL). A request
 * can never inherit the previous request's tenant from a pooled connection.
 *
 * `idx_platform` bypasses RLS and is used only by work that is cross-tenant by nature:
 * replication, the outbox relay, the indexer and the ops endpoints.
 */
@Injectable()
export class Db implements OnModuleDestroy {
  readonly app = new Pool({ connectionString: config.appDsn, max: 20 });
  readonly platform = new Pool({ connectionString: config.platformDsn, max: 10 });

  async withTenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    const client = await this.app.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async platformTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const client = await this.platform.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** Read-only lookups against platform tables that idx_app may read (tenants, listings). */
  async query<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
    const res = await this.app.query(sql, params);
    return res.rows as T[];
  }

  async platformQuery<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
    const res = await this.platform.query(sql, params);
    return res.rows as T[];
  }

  async onModuleDestroy() {
    await Promise.allSettled([this.app.end(), this.platform.end()]);
  }
}

@Global()
@Module({ providers: [Db], exports: [Db] })
export class DbModule {}
