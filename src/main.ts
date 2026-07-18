import { RequestMethod, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  // rawBody: true captures req.rawBody so /v1/ingest can byte-compare against the stored baseline.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });

  // UI routes live under /api/v1 (API-CONTRACT.md). The extractor's /v1/* control-plane routes
  // (BACKEND_CONTRACT.md) are excluded so they stay at the base path the CLI expects.
  app.setGlobalPrefix('api/v1', {
    exclude: [
      { path: 'v1/auth/validate', method: RequestMethod.POST },
      { path: 'v1/ingest', method: RequestMethod.POST },
    ],
  });

  // Service graphs are large — the contract asks for a generous body cap (reference stub: 32 MB).
  app.useBodyParser('json', { limit: '32mb' });

  // Strict inbound validation: reject unknown query params, coerce types.
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );

  const origins = process.env.CORS_ORIGINS ?? '*';
  app.enableCors({
    origin: origins === '*' ? true : origins.split(',').map((o) => o.trim()),
  });

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(
    `Cartograph backend listening on http://localhost:${port} (UI: /api/v1, extractor: /v1)`,
  );
}

void bootstrap();
