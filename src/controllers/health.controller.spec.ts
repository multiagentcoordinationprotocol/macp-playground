import { HealthController } from './health.controller';

describe('HealthController', () => {
  let controller: HealthController;

  beforeEach(() => {
    controller = new HealthController();
  });

  describe('healthz', () => {
    it('should return ok true with service name', () => {
      const result = controller.healthz();
      expect(result).toEqual({ ok: true, service: 'macp-playground' });
    });
  });
});
