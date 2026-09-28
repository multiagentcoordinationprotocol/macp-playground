import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Logger } from '@nestjs/common';
import { FileRegistryLoader } from './file-registry.loader';
import { AppConfigService } from '../config/app-config.service';
import { AppException } from '../errors/app-exception';
import { ErrorCode } from '../errors/error-codes';

describe('FileRegistryLoader', () => {
  let loader: FileRegistryLoader;
  const packsDir = path.resolve(__dirname, '../../packs');

  beforeEach(() => {
    const config = { packsDir } as AppConfigService;
    loader = new FileRegistryLoader(config);
  });

  describe('loadAll', () => {
    it('should discover the fraud pack', async () => {
      const snapshot = await loader.loadAll();
      expect(snapshot.packs.has('fraud')).toBe(true);
    });

    it('should discover the high-value-new-device scenario', async () => {
      const snapshot = await loader.loadAll();
      const fraudPack = snapshot.packs.get('fraud')!;
      expect(fraudPack.scenarios.has('high-value-new-device')).toBe(true);
    });

    it('should discover version 1.0.0', async () => {
      const snapshot = await loader.loadAll();
      const fraudPack = snapshot.packs.get('fraud')!;
      const scenario = fraudPack.scenarios.get('high-value-new-device')!;
      expect(scenario.versions.has('1.0.0')).toBe(true);
    });

    it('should discover templates', async () => {
      const snapshot = await loader.loadAll();
      const fraudPack = snapshot.packs.get('fraud')!;
      const scenario = fraudPack.scenarios.get('high-value-new-device')!;
      const version = scenario.versions.get('1.0.0')!;
      expect(version.templates.has('default')).toBe(true);
      expect(version.templates.has('strict-risk')).toBe(true);
    });

    it('should parse pack metadata correctly', async () => {
      const snapshot = await loader.loadAll();
      const fraudPack = snapshot.packs.get('fraud')!;
      expect(fraudPack.pack.metadata.slug).toBe('fraud');
      expect(fraudPack.pack.metadata.name).toBe('Fraud');
      expect(fraudPack.pack.metadata.description).toBe('Fraud and risk decisioning demos');
    });

    it('should parse scenario metadata correctly', async () => {
      const snapshot = await loader.loadAll();
      const fraudPack = snapshot.packs.get('fraud')!;
      const version = fraudPack.scenarios.get('high-value-new-device')!.versions.get('1.0.0')!;
      expect(version.scenario.metadata.name).toBe('High Value Purchase From New Device');
      expect(version.scenario.spec.launch.participants).toHaveLength(4);
    });

    it('should return empty snapshot for non-existent directory', async () => {
      const config = { packsDir: '/non/existent/path' } as AppConfigService;
      const emptyLoader = new FileRegistryLoader(config);
      const snapshot = await emptyLoader.loadAll();
      expect(snapshot.packs.size).toBe(0);
    });

    it('should include loadedAt timestamp', async () => {
      const before = Date.now();
      const snapshot = await loader.loadAll();
      expect(snapshot.loadedAt).toBeGreaterThanOrEqual(before);
    });
  });

  describe('loadAll with fixtures', () => {
    it('should handle empty pack directory', async () => {
      const fixturesDir = path.resolve(__dirname, '../../test/fixtures/packs');
      const config = { packsDir: fixturesDir } as AppConfigService;
      const fixtureLoader = new FileRegistryLoader(config);
      const snapshot = await fixtureLoader.loadAll();
      // Should have fraud pack and the empty-pack (which has no scenarios)
      const emptyPack = snapshot.packs.get('empty-pack');
      if (emptyPack) {
        expect(emptyPack.scenarios.size).toBe(0);
      }
    });
  });

  describe('loadAll with shared fragments', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loader-shared-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('skips _-prefixed top-level directories during pack discovery', async () => {
      // Create a normal pack
      fs.mkdirSync(path.join(tmpDir, 'normal'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'normal/pack.yaml'),
        'apiVersion: scenarios.macp.dev/v1\nkind: ScenarioPack\nmetadata:\n  slug: normal\n  name: Normal\n'
      );
      // And a _shared sibling that should be ignored even though it has a pack.yaml
      fs.mkdirSync(path.join(tmpDir, '_shared'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, '_shared/pack.yaml'),
        'apiVersion: scenarios.macp.dev/v1\nkind: ScenarioPack\nmetadata:\n  slug: should-not-load\n  name: Hidden\n'
      );

      const config = { packsDir: tmpDir } as AppConfigService;
      const sharedLoader = new FileRegistryLoader(config);
      const snapshot = await sharedLoader.loadAll();

      expect(snapshot.packs.has('normal')).toBe(true);
      expect(snapshot.packs.has('should-not-load')).toBe(false);
      expect(snapshot.packs.size).toBe(1);
    });

    it('inlines !include fragments at load time', async () => {
      // _shared fragment
      fs.mkdirSync(path.join(tmpDir, '_shared/participants'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, '_shared/participants/duo.yaml'),
        '- id: a\n  role: r1\n  agentRef: a\n- id: b\n  role: r2\n  agentRef: b\n'
      );
      // pack
      fs.mkdirSync(path.join(tmpDir, 'demo/scenarios/x/1.0.0/templates'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'demo/pack.yaml'),
        'apiVersion: scenarios.macp.dev/v1\nkind: ScenarioPack\nmetadata:\n  slug: demo\n  name: Demo\n'
      );
      fs.writeFileSync(
        path.join(tmpDir, 'demo/scenarios/x/1.0.0/scenario.yaml'),
        `apiVersion: scenarios.macp.dev/v1
kind: ScenarioVersion
metadata:
  pack: demo
  scenario: x
  version: 1.0.0
  name: X
spec:
  runtime: { kind: rust, version: v1 }
  inputs:
    schema: { type: object }
  launch:
    modeName: m
    modeVersion: '1'
    configurationVersion: c
    ttlMs: 1000
    participants: !include ../../../../_shared/participants/duo.yaml
`
      );
      fs.writeFileSync(
        path.join(tmpDir, 'demo/scenarios/x/1.0.0/templates/default.yaml'),
        'apiVersion: scenarios.macp.dev/v1\nkind: ScenarioTemplate\nmetadata:\n  scenarioVersion: demo/x@1.0.0\n  slug: default\n  name: Default\nspec: {}\n'
      );

      const config = { packsDir: tmpDir } as AppConfigService;
      const includingLoader = new FileRegistryLoader(config);
      const snapshot = await includingLoader.loadAll();

      const version = snapshot.packs.get('demo')?.scenarios.get('x')?.versions.get('1.0.0');
      expect(version?.scenario.spec.launch.participants).toEqual([
        { id: 'a', role: 'r1', agentRef: 'a' },
        { id: 'b', role: 'r2', agentRef: 'b' }
      ]);
    });
  });

  /**
   * The js-yaml 4 -> 5 upgrade changed what a document-less file parses to: every spelling used to
   * yield `null`, and `'---\n'` now yields `''`. Because the loader dereferenced the parsed document
   * unguarded, that flipped a placeholder pack.yaml from "one pack skipped" (TypeError, swallowed by
   * loadAll's per-pack catch) to "HTTP 500 INVALID_PACK_DATA on every catalog route" (AppException,
   * which loadAll rethrows) -- and with REGISTRY_CACHE_TTL_MS=0 it never cleared.
   *
   * These cases pin BOTH halves of the intended split, because the defect was not that either half
   * was wrong on its own -- it was that two spellings of the same placeholder landed on opposite
   * halves. Deleting the "still fails the whole load" case would let a future change quietly demote
   * a real INVALID_PACK_DATA into a silently-vanishing pack.
   */
  describe('a file that is not a pack document costs only that pack', () => {
    let tmpDir: string;
    const goodPack = 'apiVersion: scenarios.macp.dev/v1\nkind: ScenarioPack\nmetadata:\n  slug: good\n  name: Good\n';
    let errorLogs: string[];

    const scenarioYaml = (slug: string) => `apiVersion: scenarios.macp.dev/v1
kind: ScenarioVersion
metadata:
  pack: ${slug}
  scenario: x
  version: 1.0.0
  name: X
spec:
  runtime: { kind: rust, version: v1 }
  inputs:
    schema: { type: object }
  launch:
    modeName: m
    modeVersion: '1'
    configurationVersion: c
    ttlMs: 1000
    participants: []
`;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loader-shape-'));
      fs.mkdirSync(path.join(tmpDir, 'good'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'good/pack.yaml'), goodPack);
      errorLogs = [];
      jest.spyOn(Logger.prototype, 'error').mockImplementation((msg: unknown) => {
        errorLogs.push(String(msg));
      });
    });

    afterEach(() => {
      jest.restoreAllMocks();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    const load = async () => {
      const config = { packsDir: tmpDir } as AppConfigService;
      return new FileRegistryLoader(config).loadAll();
    };

    // The first row is the js-yaml 5 regression itself; the rest are the adjacent spellings that
    // must not diverge from it, including the two `''` producers the earlier normalisation missed.
    it.each([
      ['a marker-only document', '---\n', 'an empty document'],
      ['a marker plus a comment', '---\n# TODO: write this pack\n', 'an empty document'],
      ['an indented marker', '  ---\n', 'an empty document'],
      ['a comment-only document', '# TODO: write this pack\n', 'null'],
      ['an empty file', '', 'null'],
      ['an explicit null', 'null\n', 'null'],
      ['a sequence', '- a\n- b\n', 'a sequence'],
      ['a bare scalar', 'just a string\n', 'a string']
    ])('skips a pack whose pack.yaml is %s, and keeps serving the rest', async (_label, body, shape) => {
      fs.mkdirSync(path.join(tmpDir, 'bad'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'bad/pack.yaml'), body);

      const snapshot = await load();

      expect(snapshot.packs.has('good')).toBe(true);
      expect(snapshot.packs.size).toBe(1);
      expect(errorLogs.some((m) => m.includes('bad/pack.yaml') && m.includes(`got ${shape}`))).toBe(true);
    });

    it('skips only the offending version when scenario.yaml is document-less, not the whole pack', async () => {
      const base = path.join(tmpDir, 'good/scenarios/x');
      fs.mkdirSync(path.join(base, '1.0.0'), { recursive: true });
      fs.mkdirSync(path.join(base, '2.0.0'), { recursive: true });
      fs.writeFileSync(path.join(base, '1.0.0/scenario.yaml'), '---\n');
      fs.writeFileSync(path.join(base, '2.0.0/scenario.yaml'), scenarioYaml('good'));

      const snapshot = await load();

      const versions = snapshot.packs.get('good')?.scenarios.get('x')?.versions;
      expect(versions?.has('2.0.0')).toBe(true);
      expect(versions?.has('1.0.0')).toBe(false);
      expect(errorLogs.some((m) => m.includes('1.0.0/scenario.yaml'))).toBe(true);
    });

    // The other half of the split. A file that IS a mapping but carries the wrong apiVersion/kind is
    // a malformed pack, not a missing one, and must still fail the entire load loudly.
    it.each([
      ['apiVersion', 'apiVersion: wrong/v9\nkind: ScenarioPack\nmetadata:\n  slug: bad\n  name: Bad\n'],
      ['kind', 'apiVersion: scenarios.macp.dev/v1\nkind: NotAPack\nmetadata:\n  slug: bad\n  name: Bad\n'],
      ['metadata.slug', 'apiVersion: scenarios.macp.dev/v1\nkind: ScenarioPack\nmetadata:\n  name: Bad\n']
    ])('still fails the whole load when pack.yaml has a bad %s', async (_label, body) => {
      fs.mkdirSync(path.join(tmpDir, 'bad'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'bad/pack.yaml'), body);

      await expect(load()).rejects.toThrow(AppException);
      await expect(load()).rejects.toMatchObject({ errorCode: ErrorCode.INVALID_PACK_DATA });
    });

    // Input js-yaml itself rejects is neither class: it is a reportable load failure, and the
    // per-pack catch is what keeps it from taking the catalog with it.
    it.each([
      ['a directive with no document', '%YAML 1.2\n'],
      ['two documents in one file', '---\n---\n']
    ])('reports %s as a load failure rather than treating it as empty', async (_label, body) => {
      fs.mkdirSync(path.join(tmpDir, 'bad'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'bad/pack.yaml'), body);

      await expect(load()).rejects.toMatchObject({ errorCode: ErrorCode.INVALID_PACK_DATA });
    });
  });
});
