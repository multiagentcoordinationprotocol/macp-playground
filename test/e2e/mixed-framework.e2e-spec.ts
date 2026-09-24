import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { AppConfigService } from '../../src/config/app-config.service';
import { GlobalExceptionFilter } from '../../src/errors/exception.filter';
import { buildE2eConfig, stubAuthMinter, stubExampleAgentCatalog } from './e2e-config';

describe('Mixed Framework Scenarios (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await stubExampleAgentCatalog(
      stubAuthMinter(
        Test.createTestingModule({
          imports: [AppModule]
        }).overrideProvider(AppConfigService).useValue(buildE2eConfig())
      )
    ).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalFilters(new GlobalExceptionFilter());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('Lending pack', () => {
    it('GET /packs should include lending pack', () => {
      return request(app.getHttpServer())
        .get('/packs')
        .expect(200)
        .expect((res: any) => {
          const lending = res.body.find((p: { slug: string }) => p.slug === 'lending');
          expect(lending).toBeDefined();
          expect(lending.name).toBe('Lending');
        });
    });

    it('GET /packs/lending/scenarios should return loan-underwriting scenario', () => {
      return request(app.getHttpServer())
        .get('/packs/lending/scenarios')
        .expect(200)
        .expect((res: any) => {
          expect(Array.isArray(res.body)).toBe(true);
          const scenario = res.body.find((s: { scenario: string }) => s.scenario === 'loan-underwriting');
          expect(scenario).toBeDefined();
          expect(scenario.versions).toContain('1.0.0');
          expect(scenario.templates).toContain('default');
        });
    });

    it('GET launch-schema for loan-underwriting should return 4 participants', () => {
      return request(app.getHttpServer())
        .get('/packs/lending/scenarios/loan-underwriting/versions/1.0.0/launch-schema')
        .expect(200)
        .expect((res: any) => {
          expect(res.body.scenarioRef).toBe('lending/loan-underwriting@1.0.0');
          expect(res.body.participants).toHaveLength(4);
          expect(res.body.agents).toHaveLength(4);
          expect(res.body.formSchema).toBeDefined();
          expect(res.body.runtime).toEqual({ kind: 'rust', version: 'v1' });
        });
    });

    it('POST /launch/compile should compile loan-underwriting scenario', () => {
      return request(app.getHttpServer())
        .post('/launch/compile')
        .send({
          scenarioRef: 'lending/loan-underwriting@1.0.0',
          templateId: 'default',
          mode: 'sandbox',
          inputs: {
            loanAmount: 25000,
            creditScore: 680,
            debtToIncomeRatio: 0.35,
            employmentYears: 3,
            isExistingCustomer: true,
            priorDefaults: 0
          }
        })
        .expect(201)
        .expect((res: any) => {
          expect(res.body.runDescriptor).toBeDefined();
          expect(res.body.runDescriptor.session.participants).toHaveLength(4);
          expect(res.body.participantBindings).toHaveLength(4);
          const frameworks = res.body.participantBindings.map((b: any) => b.agentRef);
          expect(frameworks).toContain('fraud-agent');
          expect(frameworks).toContain('growth-agent');
          expect(frameworks).toContain('compliance-agent');
          expect(frameworks).toContain('risk-agent');
        });
    });

    it('POST /examples/run (dry run) should resolve mixed-framework agents for lending', () => {
      return request(app.getHttpServer())
        .post('/examples/run')
        .send({
          scenarioRef: 'lending/loan-underwriting@1.0.0',
          templateId: 'default',
          submitToControlPlane: false,
          inputs: {
            loanAmount: 25000,
            creditScore: 680,
            debtToIncomeRatio: 0.35,
            employmentYears: 3,
            isExistingCustomer: true,
            priorDefaults: 0
          }
        })
        .expect(201)
        .expect((res: any) => {
          expect(res.body.compiled.runDescriptor).toBeDefined();
          expect(res.body.hostedAgents).toHaveLength(4);

          const findAgent = (ref: string) => res.body.hostedAgents.find((a: any) => a.agentRef === ref);
          expect(findAgent('fraud-agent').framework).toBe('langgraph');
          expect(findAgent('growth-agent').framework).toBe('langchain');
          expect(findAgent('compliance-agent').framework).toBe('crewai');
          expect(findAgent('risk-agent').framework).toBe('custom');

          expect(res.body.sessionId).toBeDefined();
        });
    });
  });

  describe('Claims pack', () => {
    it('GET /packs should include claims pack', () => {
      return request(app.getHttpServer())
        .get('/packs')
        .expect(200)
        .expect((res: any) => {
          const claims = res.body.find((p: { slug: string }) => p.slug === 'claims');
          expect(claims).toBeDefined();
          expect(claims.name).toBe('Claims');
        });
    });

    it('GET /packs/claims/scenarios should return auto-claim-review scenario', () => {
      return request(app.getHttpServer())
        .get('/packs/claims/scenarios')
        .expect(200)
        .expect((res: any) => {
          const scenario = res.body.find((s: { scenario: string }) => s.scenario === 'auto-claim-review');
          expect(scenario).toBeDefined();
          expect(scenario.versions).toContain('1.0.0');
        });
    });

    it('POST /launch/compile should compile auto-claim-review scenario', () => {
      return request(app.getHttpServer())
        .post('/launch/compile')
        .send({
          scenarioRef: 'claims/auto-claim-review@1.0.0',
          templateId: 'default',
          mode: 'sandbox',
          inputs: {
            claimAmount: 8500,
            policyAge: 24,
            priorClaims: 1,
            isHighValuePolicy: false,
            incidentSeverity: 'moderate'
          }
        })
        .expect(201)
        .expect((res: any) => {
          expect(res.body.runDescriptor).toBeDefined();
          expect(res.body.runDescriptor.session.participants).toHaveLength(4);
          expect(res.body.display.title).toBe('Auto Claim Review');
        });
    });

    it('POST /examples/run (dry run) should resolve mixed-framework agents for claims', () => {
      return request(app.getHttpServer())
        .post('/examples/run')
        .send({
          scenarioRef: 'claims/auto-claim-review@1.0.0',
          submitToControlPlane: false,
          inputs: {
            claimAmount: 8500,
            policyAge: 24,
            priorClaims: 1,
            isHighValuePolicy: false,
            incidentSeverity: 'moderate'
          }
        })
        .expect(201)
        .expect((res: any) => {
          expect(res.body.hostedAgents).toHaveLength(4);
          expect(res.body.hostedAgents.every((a: any) => a.transportIdentity.startsWith('agent://'))).toBe(true);

          const frameworks = res.body.hostedAgents.map((a: any) => a.framework).sort();
          expect(frameworks).toEqual(['crewai', 'custom', 'langchain', 'langgraph']);
        });
    });
  });
});
