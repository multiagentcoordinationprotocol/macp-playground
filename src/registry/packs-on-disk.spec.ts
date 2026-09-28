import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadYamlWithIncludes } from './include-resolver';

/**
 * Golden-parse regression over the REAL `packs/` tree.
 *
 * Every other include-resolver test builds tiny synthetic YAML in a temp dir. None of them parses a
 * shipped pack, so a loader change could alter how the real catalog resolves and every test would
 * still be green. This spec is the safety net for that, and it earns its keep on every future
 * loader change, not just the js-yaml 5 rewrite it was written for. It mirrors the
 * `src/policy/policies-on-disk.spec.ts` precedent of asserting against real shipped files.
 *
 * WHY A COMMITTED FIXTURE AND `toEqual`, NOT `toMatchSnapshot`:
 * no jest invocation in this repo passes `--ci` (see `package.json`'s scripts and
 * `.github/workflows/ci.yml`). Under jest's default, a MISSING snapshot is silently WRITTEN and the
 * test passes — so deleting the `.snap`, renaming this test, or reordering the walk would make the
 * safety net regenerate itself green. That is the exact failure mode a golden fixture exists to
 * prevent. A plain JSON file compared with `toEqual` cannot self-heal: if it is missing, the require
 * throws.
 *
 * The fixture was generated under the js-yaml **4** implementation, in a commit that predates the
 * v5 bump, and is NOT regenerated as part of that bump. If this test goes red, the loader changed
 * behaviour — fix the loader, do not refresh the fixture. Regenerate it only when a pack file is
 * deliberately edited, and say so in the commit message.
 */
const REPO_ROOT = path.resolve(__dirname, '../..');
const PACKS_ROOT = path.join(REPO_ROOT, 'packs');
const GOLDEN_PATH = path.join(REPO_ROOT, 'test/fixtures/packs-golden.json');

/**
 * Deterministic walk of every loader-visible YAML file under `packs/`: each pack's `pack.yaml`,
 * each scenario version's `scenario.yaml`, and every `templates/*.yaml`. Skips `_`-prefixed
 * directories exactly as `FileRegistryLoader` does, so `_shared/` fragments are reached only
 * through `!include` — which is the behaviour under test.
 *
 * Sorted at every level and again at the end: the fixture is compared with `toEqual` on an object,
 * so key order does not affect the assertion, but a stable order keeps the fixture's diffs readable.
 */
function collectPackYamlFiles(packsRoot: string): string[] {
  const out: string[] = [];
  for (const packEntry of fs.readdirSync(packsRoot, { withFileTypes: true })) {
    if (!packEntry.isDirectory()) continue;
    if (packEntry.name.startsWith('_')) continue;
    const packDir = path.join(packsRoot, packEntry.name);
    const packYaml = path.join(packDir, 'pack.yaml');
    if (fs.existsSync(packYaml)) out.push(packYaml);
    const scenariosRoot = path.join(packDir, 'scenarios');
    if (!fs.existsSync(scenariosRoot)) continue;
    for (const slug of fs.readdirSync(scenariosRoot).sort()) {
      const slugDir = path.join(scenariosRoot, slug);
      if (!fs.statSync(slugDir).isDirectory()) continue;
      for (const version of fs.readdirSync(slugDir).sort()) {
        const versionDir = path.join(slugDir, version);
        if (!fs.statSync(versionDir).isDirectory()) continue;
        const scenarioYaml = path.join(versionDir, 'scenario.yaml');
        if (fs.existsSync(scenarioYaml)) out.push(scenarioYaml);
        const templatesDir = path.join(versionDir, 'templates');
        if (!fs.existsSync(templatesDir)) continue;
        for (const tmpl of fs.readdirSync(templatesDir).sort()) {
          if (!tmpl.endsWith('.yaml') && !tmpl.endsWith('.yml')) continue;
          out.push(path.join(templatesDir, tmpl));
        }
      }
    }
  }
  return out.sort();
}

describe('real packs/ tree parses identically to the committed golden fixture', () => {
  const files = collectPackYamlFiles(PACKS_ROOT);

  it('finds the shipped pack files at all', () => {
    // Guards the degenerate pass: if the walk silently returned nothing (a renamed directory, a
    // changed layout), every per-file assertion below would vanish and the suite would stay green.
    expect(files.length).toBeGreaterThanOrEqual(13);
  });

  it('parses every file and matches the golden fixture exactly', () => {
    // A bare require, deliberately: a missing fixture must throw, not be regenerated.
    const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf-8')) as Record<string, unknown>;

    const actual: Record<string, unknown> = {};
    for (const file of files) {
      actual[path.relative(REPO_ROOT, file)] = loadYamlWithIncludes(file, PACKS_ROOT);
    }

    // Compared through a JSON round-trip on both sides so the assertion is about the *data* the
    // loader produces, not about prototypes or `undefined`-vs-absent distinctions that YAML cannot
    // express anyway. This is also exactly how the fixture was generated.
    expect(JSON.parse(JSON.stringify(actual))).toEqual(golden);

    // The fixture must cover the same file set, in both directions — an added pack that nobody
    // added to the fixture, or a fixture entry for a pack that was deleted, are both drift.
    expect(Object.keys(actual).sort()).toEqual(Object.keys(golden).sort());
  });

  it('resolves !include rather than leaving the tag unexpanded', () => {
    // Independent of the fixture: proves the tag is actually doing work on the real tree, so a
    // rewrite that silently stopped resolving includes could not pass by matching a fixture that
    // had itself been generated from a broken loader.
    const fraud = loadYamlWithIncludes(
      path.join(PACKS_ROOT, 'fraud/scenarios/high-value-new-device/1.0.0/scenario.yaml'),
      PACKS_ROOT
    ) as { spec: { launch: { participants: unknown; commitments: unknown } } };

    expect(Array.isArray(fraud.spec.launch.participants)).toBe(true);
    expect((fraud.spec.launch.participants as unknown[]).length).toBeGreaterThan(0);
    expect(Array.isArray(fraud.spec.launch.commitments)).toBe(true);
    expect((fraud.spec.launch.commitments as unknown[]).length).toBeGreaterThan(0);
  });
});
