import { Controller, Get, Module } from '@nestjs/common';
import { DevAuthController } from './auth/auth';
import { AiClient } from './common/ai-client';
import { RedisService } from './common/redis.service';
import { ConsoleController } from './console/console.controller';
import { Db, DbModule } from './db/db.service';
import { KafkaService } from './events/kafka.service';
import { ReportsService } from './geo/reports.service';
import { LeadsService } from './leads/leads.service';
import { InternalController } from './messaging/internal.controller';
import { MessagingService } from './messaging/messaging.service';
import { SmsSenderFactory } from './messaging/sms-sender';
import { WebhookController } from './messaging/webhook.controller';
import { AdminController } from './ops/admin.controller';
import { OpsController } from './ops/ops.controller';
import { SandboxController } from './sandbox/sandbox.controller';
import { ScoringService } from './scoring/scoring.service';
import { OpenSearchService } from './search/opensearch.service';
import { OfficesController, PublicController } from './search/public.controller';
import { SearchService } from './search/search.service';
import { TenantsService } from './search/tenants.service';
import { TemporalService } from './temporal/temporal.service';

@Controller()
class HealthController {
  constructor(private readonly db: Db) {}

  @Get('healthz')
  async health() {
    await this.db.query('SELECT 1');
    return { ok: true };
  }
}

export const SHARED_PROVIDERS = [
  AiClient, RedisService, KafkaService, OpenSearchService, TenantsService, TemporalService, SmsSenderFactory,
  MessagingService, ReportsService, ScoringService,
];

@Module({
  imports: [DbModule],
  controllers: [
    HealthController, OfficesController, PublicController, WebhookController, InternalController, ConsoleController, OpsController,
    DevAuthController, SandboxController, AdminController,
  ],
  providers: [...SHARED_PROVIDERS, SearchService, LeadsService],
})
export class AppModule {}
