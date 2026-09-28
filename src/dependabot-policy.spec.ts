/**
 * Dependabot ignore-policy guardrail.
 *
 * Three dependencies in this repo cannot be upgraded freely, each because of an
 * upstream constraint that no change here can lift. Dependabot does not know
 * that, so `.github/dependabot.yml` carries explicit `ignore` rules; without
 * them Dependabot reopens permanently-red PRs (this is exactly what happened to
 * PRs #80 and #76, which this plan superseded).
 *
 * The rules are easy to drop by accident — a merge conflict in a YAML list
 * leaves no compile error and no failing test anywhere else. This spec fails CI
 * if any of them goes missing, so the regression is caught in the PR that
 * causes it rather than in the next red Dependabot run.
 *
 * If a ceiling genuinely lifts upstream, delete the rule here AND in the YAML
 * in the same commit, and say in the message which upstream release lifted it.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

const DEPENDABOT_YML = path.resolve(__dirname, '..', '.github', 'dependabot.yml');

interface IgnoreRule {
  'dependency-name'?: string;
  'update-types'?: string[];
}
interface UpdateEntry {
  'package-ecosystem'?: string;
  directory?: string;
  ignore?: IgnoreRule[];
}
interface DependabotConfig {
  version?: number;
  updates?: UpdateEntry[];
}

/**
 * Each entry: the package, the ecosystem its rule lives under, the update types
 * that MUST be ignored, and the upstream constraint that forces it. The reason
 * is asserted on failure so whoever trips this sees *why* without digging.
 */
const REQUIRED_IGNORES: Array<{
  ecosystem: string;
  dependency: string;
  updateTypes: string[];
  reason: string;
}> = [
  {
    ecosystem: 'npm',
    dependency: 'typescript',
    // Major AND minor: @typescript-eslint peers `typescript <6.1.0`, so against
    // the ~6.0.x pin a 6.1.x release is a semver-MINOR that would break the peer.
    updateTypes: ['version-update:semver-major', 'version-update:semver-minor'],
    reason: '@typescript-eslint peers typescript ">=4.8.4 <6.1.0"; a 6.1.x minor would violate it.'
  },
  {
    ecosystem: 'pip',
    dependency: 'langchain-core',
    updateTypes: ['version-update:semver-major'],
    reason: 'The langchain family must move 1.x -> 2.x together; a lone major is unresolvable.'
  },
  {
    ecosystem: 'pip',
    dependency: 'langchain-openai',
    updateTypes: ['version-update:semver-major'],
    reason: 'The langchain family must move 1.x -> 2.x together; a lone major is unresolvable.'
  },
  {
    ecosystem: 'pip',
    dependency: 'langgraph',
    updateTypes: ['version-update:semver-major'],
    reason: 'The langchain family must move 1.x -> 2.x together; a lone major is unresolvable.'
  },
  {
    ecosystem: 'pip',
    dependency: 'openai',
    updateTypes: ['version-update:semver-major'],
    reason: 'crewai -> instructor -> jiter<0.15 caps openai at 3.3.0; this is what made PR #76 permanently red.'
  }
];

describe('.github/dependabot.yml ignore policy', () => {
  const config = yaml.load(fs.readFileSync(DEPENDABOT_YML, 'utf8'), { schema: yaml.JSON_SCHEMA }) as DependabotConfig;

  it('parses as a v2 Dependabot config with update entries', () => {
    expect(config).toBeTruthy();
    expect(config.version).toBe(2);
    expect(Array.isArray(config.updates)).toBe(true);
    expect(config.updates?.length).toBeGreaterThan(0);
  });

  it.each(REQUIRED_IGNORES)(
    'ignores $dependency ($ecosystem): $reason',
    ({ ecosystem, dependency, updateTypes, reason }) => {
      const entry = config.updates?.find((u) => u['package-ecosystem'] === ecosystem);
      // Jest has no second-argument assertion message, so fold the explanation
      // into the compared value — it then shows up in the failure diff itself.
      expect(entry ? 'present' : `MISSING "${ecosystem}" package-ecosystem block in dependabot.yml`).toBe('present');

      const rule = entry?.ignore?.find((i) => i['dependency-name'] === dependency);
      expect(rule ? 'present' : `MISSING ignore rule for "${dependency}" (${ecosystem}) — ${reason}`).toBe('present');

      // Order is irrelevant to Dependabot, so compare as sets.
      expect(new Set(rule?.['update-types'] ?? [])).toEqual(new Set(updateTypes));
    }
  );

  it('keeps every ignore rule commented, so the next reader learns the constraint', () => {
    // Each `- dependency-name:` line must be preceded somewhere above by a `#`
    // comment within its own ignore block. Cheap structural proxy: the file has
    // at least as many comment lines as ignore rules.
    const lines = fs.readFileSync(DEPENDABOT_YML, 'utf8').split('\n');
    const ruleCount = lines.filter((l) => l.includes('- dependency-name:')).length;
    const commentCount = lines.filter((l) => l.trim().startsWith('#')).length;

    expect(ruleCount).toBe(REQUIRED_IGNORES.length);
    expect(commentCount).toBeGreaterThanOrEqual(ruleCount);
  });
});
