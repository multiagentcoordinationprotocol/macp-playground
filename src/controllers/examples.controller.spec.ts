import { ExamplesController } from './examples.controller';
import { AppConfigService } from '../config/app-config.service';
import { ExampleRunService } from '../launch/example-run.service';
import { ClientIpRequest } from '../llm-budget/client-ip';

function req(headers: Record<string, string>): ClientIpRequest {
  return { headers, socket: { remoteAddress: '10.0.0.1' } };
}

describe('ExamplesController', () => {
  let controller: ExamplesController;
  let mockRunService: jest.Mocked<ExampleRunService>;

  beforeEach(() => {
    mockRunService = {
      run: jest.fn()
    } as unknown as jest.Mocked<ExampleRunService>;
    controller = new ExamplesController(mockRunService, {
      authApiKeys: ['console-key'],
      trustedProxyHops: 1
    } as AppConfigService);
  });

  describe('run', () => {
    it('should delegate to ExampleRunService', async () => {
      const body = {
        scenarioRef: 'fraud/test@1.0.0',
        inputs: { amount: 100 },
        submitToControlPlane: false
      };
      const mockResult = {
        compiled: {
          runDescriptor: {},
          sessionId: 'sess-1',
          mode: 'sandbox',
          scenarioMeta: {},
          display: { title: 'Test', scenarioRef: 'fraud/test@1.0.0' },
          participantBindings: []
        },
        hostedAgents: [],
        controlPlane: { baseUrl: 'http://localhost:3001', validated: false, submitted: false }
      };
      mockRunService.run.mockResolvedValue(mockResult as never);

      const result = await controller.run(body, req({ 'x-forwarded-for': '198.51.100.9' }));
      expect(result).toBe(mockResult);
      expect(mockRunService.run).toHaveBeenCalledWith(body, '198.51.100.9');
    });

    it('keys the launch on X-MACP-Client-IP only when the request carries the valid API key', async () => {
      mockRunService.run.mockResolvedValue({} as never);
      const body = { scenarioRef: 'fraud/test@1.0.0', inputs: {} };
      await controller.run(
        body,
        req({ 'x-api-key': 'console-key', 'x-macp-client-ip': '203.0.113.50', 'x-forwarded-for': '198.51.100.9' })
      );
      expect(mockRunService.run).toHaveBeenLastCalledWith(body, '203.0.113.50');
      await controller.run(
        body,
        req({ 'x-api-key': 'nope', 'x-macp-client-ip': '203.0.113.50', 'x-forwarded-for': '198.51.100.9' })
      );
      expect(mockRunService.run).toHaveBeenLastCalledWith(body, '198.51.100.9');
    });

    it('should propagate errors from service', async () => {
      mockRunService.run.mockRejectedValue(new Error('compilation failed'));
      await expect(controller.run({ scenarioRef: 'bad', inputs: {} }, req({}))).rejects.toThrow('compilation failed');
    });
  });
});
