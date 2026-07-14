import { INestApplication, RequestMethod, ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';

/** Demo credentials created by prisma/seed.ts. */
export const DEMO_CREDENTIALS = { email: 'demo@acme.com', password: 'demo1234' };
/** Extractor API key created by prisma/seed.ts. */
export const DEMO_API_KEY = 'ekg_dev_local_demokey';

/** Boots the app exactly as main.ts does (rawBody + prefix exclusion + strict ValidationPipe). */
export async function createTestApp(): Promise<NestExpressApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ rawBody: true });
  app.setGlobalPrefix('api/v1', {
    exclude: [
      { path: 'v1/auth/validate', method: RequestMethod.POST },
      { path: 'v1/ingest', method: RequestMethod.POST },
    ],
  });
  app.useBodyParser('json', { limit: '32mb' });
  app.useGlobalPipes(
    new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }),
  );
  await app.init();
  return app;
}

/** Logs in with the demo user and returns a valid bearer token. */
export async function login(app: INestApplication): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send(DEMO_CREDENTIALS)
    .expect(201);
  return res.body.token as string;
}
