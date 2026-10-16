import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { config } from './config';
import { migrate } from './db/migrate';

async function bootstrap() {
  const log = new Logger('api');
  await migrate((m) => log.log(m));
  const app = await NestFactory.create(AppModule, { logger: ['log', 'warn', 'error'] });
  app.enableCors({ origin: true });
  app.enableShutdownHooks();
  await app.listen(config.port, '0.0.0.0');
  log.log(`listening on ${config.port}`);
}

void bootstrap();
