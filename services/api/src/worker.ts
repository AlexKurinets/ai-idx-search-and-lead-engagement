import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { config } from './config';
import { migrate } from './db/migrate';
import { WorkerModule } from './worker.module';

async function bootstrap() {
  const log = new Logger('worker');
  await migrate((m) => log.log(m));
  const app = await NestFactory.createApplicationContext(WorkerModule, { logger: ['log', 'warn', 'error'] });
  app.enableShutdownHooks();
  log.log(`worker roles: ${config.workerRoles.join(', ')}`);
}

void bootstrap();
