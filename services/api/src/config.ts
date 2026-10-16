import * as path from 'path';

const env = (key: string, fallback?: string): string => {
  const value = process.env[key] ?? fallback;
  if (value === undefined) throw new Error(`missing required env ${key}`);
  return value;
};
const num = (key: string, fallback: number): number => Number(process.env[key] ?? fallback);

const repoRoot = process.env.REPO_ROOT ?? path.resolve(__dirname, '..', '..', '..');

export const config = {
  port: num('PORT', 4000),
  ownerDsn: env('DATABASE_URL_OWNER', 'postgresql://idx:idx@localhost:5442/idx'),
  appDsn: env('DATABASE_URL_APP', 'postgresql://idx_app:idx_app@localhost:5442/idx'),
  platformDsn: env('DATABASE_URL_PLATFORM', 'postgresql://idx_platform:idx_platform@localhost:5442/idx'),
  appDbPassword: env('IDX_APP_PASSWORD', 'idx_app'),
  platformDbPassword: env('IDX_PLATFORM_PASSWORD', 'idx_platform'),
  redisUrl: env('REDIS_URL', 'redis://localhost:6390'),
  opensearchUrl: env('OPENSEARCH_URL', 'http://localhost:9210'),
  kafkaBrokers: env('KAFKA_BROKERS', 'localhost:19093').split(','),
  temporalAddress: env('TEMPORAL_ADDRESS', 'localhost:7243'),
  temporalNamespace: env('TEMPORAL_NAMESPACE', 'default'),
  temporalTaskQueue: env('TEMPORAL_TASK_QUEUE', 'engagement'),
  aiUrl: env('AI_URL', 'http://localhost:8100'),
  mlsBaseUrl: env('MLS_BASE_URL', 'http://localhost:8110'),
  mlsClientSecret: env('MLS_CLIENT_SECRET', 'dev-mls-secret'),
  internalToken: env('INTERNAL_TOKEN', 'dev-internal-token'),
  jwtSecret: env('JWT_SECRET', 'dev-jwt-secret-change-me'),
  authMode: env('AUTH_MODE', 'dev'),
  smsAdapter: env('SMS_ADAPTER', 'sandbox'),
  smsAuthToken: env('SMS_AUTH_TOKEN', 'dev-sms-auth-token'),
  publicWebhookBase: env('PUBLIC_WEBHOOK_BASE', 'http://localhost:4100'),
  twilioAccountSid: process.env.TWILIO_ACCOUNT_SID,
  replicationIntervalMs: num('REPLICATION_INTERVAL_MS', 15_000),
  reconcileIntervalMs: num('RECONCILE_INTERVAL_MS', 600_000),
  replicationPageSize: num('REPLICATION_PAGE_SIZE', 500),
  scoringIntervalMs: num('SCORING_INTERVAL_MS', 60_000),
  workerRoles: env('WORKER_ROLES', 'replicator,relay,indexer,engagement,scheduler').split(','),
  migrationsDir: env('MIGRATIONS_DIR', path.join(repoRoot, 'db', 'migrations')),
  geoPath: env('GEO_PATH', path.join(repoRoot, 'data', 'geo', 'markets.json')),
  mappingsDir: env('MAPPINGS_DIR', path.resolve(__dirname, '..', 'mappings')),
  listingsIndex: 'listings-v1',
  listingsAlias: 'listings',
  savedSearchIndex: 'saved-searches-v1',
};

export type Config = typeof config;
