import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { AppConfigService } from '../../src/config/app-config.service';
import { GlobalExceptionFilter } from '../../src/errors/exception.filter';
import { LaunchSupervisor } from '../../src/hosting/launch-supervisor';
import { LLM_PROVIDER_ENV_KEYS } from '../../src/hosting/process-example-agent-host.provider';
import { buildE2eConfig, stubAuthMinter, stubExampleAgentCatalog } from './e2e-config';

// Owner decision 1b: a hosted launch must never spend the deployment's LLM key. The shipped workers
// call an LLM only when `OPENAI_API_KEY` is in their environment (graph.py / chain.py / crew.py), so
// "no LLM call" is proven here at the one place it is decided: the env each spawned agent receives.
// The deployment holds the key throughout — exactly like the hosted service — and only
// PLAYGROUND_ALLOW_LLM decides whether it reaches the workers.
const FAKE_KEY = 'sk-e2e-must-not-reach-workers';

const runBody = {
  scenarioRef: 'fraud/high-value-new-device@1.0.0',
  submitToControlPlane: false,
  inputs: {
    transactionAmount: 3200,
    deviceTrustScore: 0.12,
    accountAgeDays: 5,
    isVipCustomer: true,
    priorChargebacks: 1
  }
};

async function bootApp(allowLlmAgents: boolean): Promise<INestApplication> {
  const moduleFixture = await stubExampleAgentCatalog(
    stubAuthMinter(
      Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(AppConfigService)
        .useValue(buildE2eConfig({ allowLlmAgents }))
    )
  ).compile();
  const app = moduleFixture.createNestApplication();
  app.useGlobalFilters(new GlobalExceptionFilter());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();
  return app;
}

/** POST /examples/run and return the response body plus the env handed to every spawned agent. */
async function launch(
  app: INestApplication,
  body: Record<string, unknown> = runBody
): Promise<{ res: any; envs: Record<string, string>[] }> {
  const launchSpy = jest.spyOn(app.get(LaunchSupervisor), 'launch');
  try {
    const res = await request(app.getHttpServer()).post('/examples/run').send(body).expect(201);
    return { res: res.body, envs: launchSpy.mock.calls.map(([prepared]) => prepared.env) };
  } finally {
    launchSpy.mockRestore();
  }
}

describe('Agent execution mode (e2e)', () => {
  let savedKey: string | undefined;

  beforeAll(() => {
    savedKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = FAKE_KEY;
  });

  afterAll(() => {
    if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedKey;
  });

  describe('default deployment (PLAYGROUND_ALLOW_LLM unset)', () => {
    let app: INestApplication;

    beforeAll(async () => {
      app = await bootApp(false);
    });

    afterAll(async () => {
      await app.close();
    });

    it('spawns every agent without an LLM key, so a default launch makes no LLM call', async () => {
      const { res, envs } = await launch(app);

      expect(envs).toHaveLength(4);
      for (const env of envs) {
        for (const key of LLM_PROVIDER_ENV_KEYS) expect(env).not.toHaveProperty(key);
        expect(Object.values(env)).not.toContain(FAKE_KEY);
        expect(env.MACP_AGENT_EXECUTION).toBe('deterministic');
      }
      expect(res.compiled.scenarioMeta.agentExecution).toBe('deterministic');
      expect(res.compiled.runDescriptor.session.metadata.agentExecution).toBe('deterministic');
      for (const agent of res.hostedAgents) {
        expect(agent.participantMetadata.agentExecution).toBe('deterministic');
      }
    });

    it('ignores a caller that tries to opt in from the request body', async () => {
      const { res, envs } = await launch(app, { ...runBody, agentExecution: 'llm', useLlm: true, llm: true });

      expect(envs).toHaveLength(4);
      for (const env of envs) expect(env).not.toHaveProperty('OPENAI_API_KEY');
      expect(res.compiled.scenarioMeta.agentExecution).toBe('deterministic');
    });
  });

  describe('explicit opt-in (PLAYGROUND_ALLOW_LLM=1)', () => {
    let app: INestApplication;

    beforeAll(async () => {
      app = await bootApp(true);
    });

    afterAll(async () => {
      await app.close();
    });

    it('hands the deployment key to every agent, so the LLM path still works when requested', async () => {
      const { res, envs } = await launch(app);

      expect(envs).toHaveLength(4);
      for (const env of envs) {
        expect(env.OPENAI_API_KEY).toBe(FAKE_KEY);
        expect(env).not.toHaveProperty('MACP_AGENT_EXECUTION');
      }
      expect(res.compiled.scenarioMeta.agentExecution).toBe('llm');
      expect(res.compiled.runDescriptor.session.metadata.agentExecution).toBe('llm');
      for (const agent of res.hostedAgents) {
        expect(agent.participantMetadata.agentExecution).toBe('llm');
      }
    });
  });
});
