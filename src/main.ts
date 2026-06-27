import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import * as express from 'express';
import { AppModule } from './app.module';
import { AppConfigService } from './config/app-config.service';
import { GlobalExceptionFilter } from './errors/exception.filter';

function buildCorsOrigin(
  config: AppConfigService
): string | string[] | ((origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => void) {
  const origins = config.corsOrigin;

  if (origins === '*') return '*';

  const list = Array.isArray(origins) ? origins : [origins];
  const hasWildcard = list.some((o) => o.includes('*'));

  if (!hasWildcard) return list.length === 1 ? list[0] : list;

  const patterns = list.map((o) => {
    if (!o.includes('*')) return o;
    const escaped = o.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`);
  });

  return (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => {
    if (!origin) return cb(null, true);
    const allowed = patterns.some((p) => (typeof p === 'string' ? p === origin : p.test(origin)));
    cb(null, allowed);
  };
}

async function bootstrap() {
  const config = new AppConfigService();

  const app = await NestFactory.create(AppModule, { cors: false });
  app.use(express.json({ limit: '1mb' }));
  app.useGlobalFilters(new GlobalExceptionFilter());
  app.enableCors({ origin: buildCorsOrigin(config), credentials: true });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false
    })
  );

  if (config.isDevelopment) {
    const swagger = new DocumentBuilder()
      .setTitle('MACP Playground')
      .setDescription('File-backed showcase catalog, compiler, and example-agent bootstrap service for MACP demos.')
      .setVersion('0.2.0')
      .build();
    const document = SwaggerModule.createDocument(app, swagger);
    SwaggerModule.setup('docs', app, document);
  }

  app.enableShutdownHooks();

  await app.listen(config.port, config.host);
}

bootstrap().catch((err) => {
  new Logger('Bootstrap').error(
    `bootstrap failed: ${err instanceof Error ? err.message : String(err)}`,
    err instanceof Error ? err.stack : undefined
  );
  process.exit(1);
});
