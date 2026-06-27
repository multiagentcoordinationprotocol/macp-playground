import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { AppConfigService } from '../../src/config/app-config.service';
import { buildE2eConfig } from './e2e-config';

describe('Health (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule]
    })
      .overrideProvider(AppConfigService)
      .useValue(buildE2eConfig({ isDevelopment: false }))
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /healthz', () => {
    it('should return ok', () => {
      return request(app.getHttpServer())
        .get('/healthz')
        .expect(200)
        .expect((res: any) => {
          expect(res.body.ok).toBe(true);
          expect(res.body.service).toBe('macp-playground');
        });
    });
  });
});
