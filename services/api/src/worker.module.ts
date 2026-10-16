import { Module } from '@nestjs/common';
import { SHARED_PROVIDERS } from './app.module';
import { DbModule } from './db/db.service';
import { EngagementConsumer } from './events/engagement.consumer';
import { IndexerConsumer } from './events/indexer.consumer';
import { RelayService } from './events/relay.service';
import { ReplicatorService } from './replication/replicator.service';

/** Background roles, selected per process with WORKER_ROLES. */
@Module({
  imports: [DbModule],
  providers: [...SHARED_PROVIDERS, ReplicatorService, RelayService, IndexerConsumer, EngagementConsumer],
})
export class WorkerModule {}
