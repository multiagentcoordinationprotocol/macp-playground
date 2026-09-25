import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { runValidate } from '../../scripts/scenario/validate';
import { runDryRun } from '../../scripts/scenario/dry-run';
import { runNew } from '../../scripts/scenario/new';
import { runLint } from '../../scripts/scenario/lint';

const execFileP = promisify(execFile);
const REPO_ROOT = path.resolve(__dirname, '../..');
const FIXTURES_PACKS = path.resolve(REPO_ROOT, 'test/fixtures/packs');
const TS_NODE = path.resolve(REPO_ROOT, 'node_modules/.bin/ts-node');
const SCENARIO_SCRIPT = path.resolve(REPO_ROOT, 'scripts/scenario.ts');

async function spawnScenarioCli(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileP(TS_NODE, [SCENARIO_SCRIPT, ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, NODE_ENV: 'test' }
    });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? 1 };
  }
}

describe('Scenario CLI (integration)', () => {
  describe('runValidate (in-process)', () => {
    let logSpy: jest.SpyInstance;
    let errSpy: jest.SpyInstance;

    beforeEach(() => {
      logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      logSpy.mockRestore();
      errSpy.mockRestore();
    });

    it('passes on the fraud fixture (which uses !include)', async () => {
      const code = await runValidate({
        target: path.join(FIXTURES_PACKS, 'fraud/scenarios/high-value-new-device/1.0.0/scenario.yaml'),
        packsRoot: FIXTURES_PACKS
      });
      expect(code).toBe(0);
    });

    it('fails when scenario file does not exist', async () => {
      const code = await runValidate({
        target: '/nonexistent/scenario.yaml',
        packsRoot: FIXTURES_PACKS
      });
      expect(code).toBe(1);
    });

    it('fails on a scenario whose !include escapes packs root', async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-validate-'));
      try {
        // Create a tiny pack tree
        fs.mkdirSync(path.join(tmp, 'evil/scenarios/x/1.0.0'), { recursive: true });
        fs.writeFileSync(
          path.join(tmp, 'evil/pack.yaml'),
          'apiVersion: scenarios.macp.dev/v1\nkind: ScenarioPack\nmetadata: { slug: evil, name: Evil }\n'
        );
        fs.writeFileSync(
          path.join(tmp, 'evil/scenarios/x/1.0.0/scenario.yaml'),
          `apiVersion: scenarios.macp.dev/v1
kind: ScenarioVersion
metadata: { pack: evil, scenario: x, version: 1.0.0, name: X }
spec:
  inputs: { schema: { type: object } }
  launch:
    modeName: m
    modeVersion: '1'
    configurationVersion: c
    ttlMs: 1000
    participants: !include ../../../../../../etc/passwd
`
        );
        const code = await runValidate({
          target: path.join(tmp, 'evil/scenarios/x/1.0.0/scenario.yaml'),
          packsRoot: tmp
        });
        expect(code).toBe(1);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  describe('runDryRun (in-process)', () => {
    let logSpy: jest.SpyInstance;
    let errSpy: jest.SpyInstance;

    beforeEach(() => {
      logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      logSpy.mockRestore();
      errSpy.mockRestore();
    });

    it('compiles a fraud scenario and prints a CompileLaunchResult with !include-inlined metadata', async () => {
      const tmpInputs = path.join(os.tmpdir(), `inputs-${Date.now()}.json`);
      fs.writeFileSync(
        tmpInputs,
        JSON.stringify({
          transactionAmount: 3200,
          deviceTrustScore: 0.12,
          accountAgeDays: 5,
          isVipCustomer: true,
          priorChargebacks: 1
        })
      );
      try {
        const code = await runDryRun({
          scenarioRef: 'fraud/high-value-new-device@1.0.0',
          inputsFile: tmpInputs,
          mode: 'sandbox',
          packsRoot: FIXTURES_PACKS
        });
        expect(code).toBe(0);

        const printed = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
        const compileResult = JSON.parse(printed);
        expect(compileResult.runDescriptor.session.modeName).toBe('macp.mode.decision.v1');
        expect(compileResult.runDescriptor.session.participants).toHaveLength(4);
        expect(compileResult.scenarioMeta.sessionContext.transactionAmount).toBe(3200);
      } finally {
        fs.unlinkSync(tmpInputs);
      }
    });

    it('fails for unknown scenarioRef with non-zero exit', async () => {
      const tmpInputs = path.join(os.tmpdir(), `inputs-${Date.now()}.json`);
      fs.writeFileSync(tmpInputs, JSON.stringify({}));
      try {
        const code = await runDryRun({
          scenarioRef: 'fraud/does-not-exist@1.0.0',
          inputsFile: tmpInputs,
          mode: 'sandbox',
          packsRoot: FIXTURES_PACKS
        });
        expect(code).toBe(1);
      } finally {
        fs.unlinkSync(tmpInputs);
      }
    });
  });

  describe('runNew (in-process)', () => {
    let tmpPacks: string;

    beforeEach(() => {
      tmpPacks = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-new-'));
      // Need _shared so the starter's !include resolves
      fs.cpSync(path.join(FIXTURES_PACKS, '_shared'), path.join(tmpPacks, '_shared'), { recursive: true });
      // The starter uses 4-agent-fraud and policy-hints/default that the test fixture _shared lacks.
      // Copy from production _shared so the scaffolded scenario validates.
      fs.cpSync(
        path.resolve(REPO_ROOT, 'packs/_shared'),
        path.join(tmpPacks, '_shared'),
        { recursive: true, force: true } as fs.CopySyncOptions
      );
    });

    afterEach(() => {
      fs.rmSync(tmpPacks, { recursive: true, force: true });
    });

    it('scaffolds a new scenario tree and the result passes validate', async () => {
      const newCode = await runNew({
        pack: 'demo',
        scenario: 'my-sample',
        version: '1.0.0',
        packsRoot: tmpPacks
      });
      expect(newCode).toBe(0);

      const scenarioPath = path.join(tmpPacks, 'demo/scenarios/my-sample/1.0.0/scenario.yaml');
      expect(fs.existsSync(scenarioPath)).toBe(true);
      expect(fs.existsSync(path.join(tmpPacks, 'demo/pack.yaml'))).toBe(true);

      // Also must validate cleanly
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const validateCode = await runValidate({ target: scenarioPath, packsRoot: tmpPacks });
        expect(validateCode).toBe(0);
      } finally {
        logSpy.mockRestore();
        errSpy.mockRestore();
      }
    });

    it('refuses to overwrite an existing version directory', async () => {
      await runNew({ pack: 'demo', scenario: 's1', version: '1.0.0', packsRoot: tmpPacks });
      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const code = await runNew({ pack: 'demo', scenario: 's1', version: '1.0.0', packsRoot: tmpPacks });
        expect(code).toBe(1);
      } finally {
        errSpy.mockRestore();
      }
    });

    it('rejects non-kebab slugs', async () => {
      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const code = await runNew({ pack: 'BadSlug', scenario: 'ok', version: '1.0.0', packsRoot: tmpPacks });
        expect(code).toBe(1);
      } finally {
        errSpy.mockRestore();
      }
    });
  });

  describe('runLint (in-process)', () => {
    it('passes on the production packs', async () => {
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const code = await runLint({
          target: path.resolve(REPO_ROOT, 'packs'),
          packsRoot: path.resolve(REPO_ROOT, 'packs')
        });
        expect(code).toBe(0);
      } finally {
        logSpy.mockRestore();
        errSpy.mockRestore();
      }
    });

    // #81 / plan Phase 3: proves lintPack's real-schema-validation check actually rejects a
    // scenario whose referenced policy fails the vendored rules schema, rather than only
    // proving the (already schema-clean) production packs pass. Reuses the issue's own
    // motivating typo (veto_threshhold, extra "h") as the deliberately-broken fixture.
    it('reports an error-level finding for a scenario whose referenced policy fails rules-schema validation', async () => {
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-lint-broken-policy-'));
      try {
        fs.mkdirSync(path.join(tmp, 'policies'), { recursive: true });
        fs.writeFileSync(
          path.join(tmp, 'policies/policy.lintprobe.broken.json'),
          JSON.stringify({
            policy_id: 'policy.lintprobe.broken',
            mode: 'macp.mode.decision.v1',
            schema_version: 3,
            description: 'Deliberately broken fixture for the scenario-cli lint negative test (#81)',
            rules: {
              voting: { algorithm: 'none' },
              objection_handling: { critical_severity_vetoes: false, veto_threshhold: 3 },
              evaluation: { minimum_confidence: 0, required_before_voting: false },
              commitment: { authority: 'initiator_only', require_vote_quorum: false, designated_roles: [] }
            }
          })
        );

        fs.mkdirSync(path.join(tmp, 'packs/lintprobe/scenarios/probe/1.0.0'), { recursive: true });
        fs.writeFileSync(
          path.join(tmp, 'packs/lintprobe/pack.yaml'),
          'apiVersion: scenarios.macp.dev/v1\nkind: ScenarioPack\nmetadata: { slug: lintprobe, name: Lint Probe }\n'
        );
        fs.writeFileSync(
          path.join(tmp, 'packs/lintprobe/scenarios/probe/1.0.0/scenario.yaml'),
          `apiVersion: scenarios.macp.dev/v1
kind: ScenarioVersion
metadata: { pack: lintprobe, scenario: probe, version: 1.0.0, name: Probe }
spec:
  inputs: { schema: { type: object } }
  launch:
    modeName: macp.mode.decision.v1
    modeVersion: '1'
    configurationVersion: c
    ttlMs: 1000
    policyVersion: policy.lintprobe.broken
`
        );

        const code = await runLint({
          target: path.join(tmp, 'packs'),
          packsRoot: path.join(tmp, 'packs')
        });

        expect(code).toBe(1);
        const errorLines = errSpy.mock.calls.map((call) => String(call[0]));
        expect(errorLines.some((line) => line.includes('FAIL') && line.includes('veto_threshhold'))).toBe(true);
      } finally {
        logSpy.mockRestore();
        errSpy.mockRestore();
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  describe('end-to-end via spawned process', () => {
    it('scenario validate exits 0 on the fraud fixture and prints OK', async () => {
      const result = await spawnScenarioCli([
        'validate',
        path.join(FIXTURES_PACKS, 'fraud/scenarios/high-value-new-device/1.0.0/scenario.yaml'),
        '--packs-root',
        FIXTURES_PACKS
      ]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('OK');
    });

    it('scenario dry-run prints a parseable ExecutionRequest', async () => {
      const tmpInputs = path.join(os.tmpdir(), `inputs-spawn-${Date.now()}.json`);
      fs.writeFileSync(
        tmpInputs,
        JSON.stringify({
          transactionAmount: 3200,
          deviceTrustScore: 0.12,
          accountAgeDays: 5,
          isVipCustomer: true,
          priorChargebacks: 1
        })
      );
      try {
        const result = await spawnScenarioCli([
          'dry-run',
          'fraud/high-value-new-device@1.0.0',
          '--inputs',
          tmpInputs,
          '--packs-root',
          FIXTURES_PACKS
        ]);
        expect(result.code).toBe(0);
        const compileResult = JSON.parse(result.stdout);
        expect(compileResult.mode).toBe('sandbox');
        expect(compileResult.runDescriptor.session.modeName).toBe('macp.mode.decision.v1');
        expect(compileResult.sessionId).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
        );
      } finally {
        fs.unlinkSync(tmpInputs);
      }
    });

    it('scenario lint exits 0 against production packs', async () => {
      const result = await spawnScenarioCli(['lint', 'packs', '--packs-root', 'packs']);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('error(s)');
    });
  });
});
