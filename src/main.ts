import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  // All routes live under /api/v1 per API-CONTRACT.md.
  app.setGlobalPrefix('api/v1');

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
  console.log(`Cartograph backend listening on http://localhost:${port}/api/v1`);
}

void bootstrap();
