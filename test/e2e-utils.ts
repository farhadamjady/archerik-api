import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';

/** Demo credentials created by prisma/seed.ts. */
export const DEMO_CREDENTIALS = { email: 'demo@acme.com', password: 'demo1234' };

/** Boots the app exactly as main.ts does (prefix + strict ValidationPipe). */
export async function createTestApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
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
