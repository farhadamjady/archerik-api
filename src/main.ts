import { RequestMethod, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { ErrorBodyFilter } from './common/error-body.filter';
import { assertSecretKeysConfigured } from './common/secret-box';

async function bootstrap(): Promise<void> {
  // Refuse to start without the encryption keys, rather than serving traffic that dies on the first
  // SSO login or provider-key save. There is deliberately no default for either — see secret-box.ts.
  // Reads process.env, which by this point includes any .env file: importing AppModule pulls in
  // @prisma/client, and the Prisma client loads .env as it initialises.
  assertSecretKeysConfigured();

  // rawBody: true captures req.rawBody so /v1/ingest can byte-compare against the stored baseline.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });

  // UI routes live under /api/v1. The extractor's /v1/* control-plane routes
  // are excluded so they stay at the base path the CLI expects.
  app.setGlobalPrefix('api/v1', {
    exclude: [
      { path: 'v1/auth/validate', method: RequestMethod.POST },
      { path: 'v1/ingest', method: RequestMethod.POST },
    ],
  });

  // Service graphs are large, so the body cap is deliberately generous. Align any proxy in front.
  app.useBodyParser('json', { limit: '32mb' });

  // Strict inbound validation: reject unknown query params, coerce types.
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );

  // Normalises every non-2xx body to { error }. Registered after the pipe so validation
  // rejections pass through it too.
  app.useGlobalFilters(new ErrorBodyFilter());

  const origins = process.env.CORS_ORIGINS ?? '*';
  app.enableCors({
    origin: origins === '*' ? true : origins.split(',').map((o) => o.trim()),
  });

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`Archerik API listening on http://localhost:${port} (UI: /api/v1, extractor: /v1)`);
}

void bootstrap();
