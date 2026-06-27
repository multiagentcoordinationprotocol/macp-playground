import { createIntegrationTestApp, IntegrationTestContext } from '../helpers/integration-test-app';

describe('Health (integration)', () => {
  let ctx: IntegrationTestContext;

  beforeAll(async () => {
    ctx = await createIntegrationTestApp();
  });

  afterAll(async () => {
    if (ctx) await ctx.cleanup();
  });

  it('GET /healthz returns ok', async () => {
    const result = await ctx.client.healthz();
    expect(result).toEqual({ ok: true, service: 'macp-playground' });
  });

  it('GET /healthz returns 200 status', async () => {
    const { status, body } = await ctx.client.requestRaw('GET', '/healthz');
    expect(status).toBe(200);
    expect(body).toHaveProperty('ok', true);
  });
});
