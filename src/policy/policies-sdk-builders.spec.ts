// Every shipped `policies/*.json` must survive the SDK's own builder, not just our validator and
// the runtime's admission check (CI's `runtime-policy-admission` job). macp-sdk-typescript 0.17.0
// (#183, `feat(policy)!`) made `buildDecisionPolicy` refuse every off-domain rule value the 0.9
// runtime enforces, so a file that the builder rejects is one an SDK-authored copy of the same
// policy could never be produced from. Runs on every SDK bump via the lockfile.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildDecisionPolicy, MacpSessionError } from 'macp-sdk-typescript';
import type { DecisionPolicyRulesInput } from 'macp-sdk-typescript';
import { PolicyDefinition } from '../contracts/policy';

const POLICIES_DIR = path.resolve(__dirname, '../../policies');

// The files are wire-shaped (snake_case); the builder takes camelCase. `weights` keys are
// participant ids, not field names, so they are carried through untouched.
function toBuilderInput(value: unknown, key?: string): unknown {
  if (Array.isArray(value) || value === null || typeof value !== 'object' || key === 'weights') {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([k, v]) => [
      k.replace(/_(.)/g, (_m, c: string) => c.toUpperCase()),
      toBuilderInput(v, k)
    ])
  );
}

function build(policy: PolicyDefinition) {
  return buildDecisionPolicy(
    policy.policy_id,
    policy.description,
    toBuilderInput(policy.rules) as DecisionPolicyRulesInput,
    { schemaVersion: policy.schema_version as 1 | 2 | 3 }
  );
}

const policies = fs
  .readdirSync(POLICIES_DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(fs.readFileSync(path.join(POLICIES_DIR, f), 'utf-8')) as PolicyDefinition);

describe('policies/*.json through macp-sdk-typescript buildDecisionPolicy', () => {
  it.each(policies.map((p) => [p.policy_id, p] as const))('%s builds and keeps every authored value', (_id, policy) => {
    const descriptor = build(policy);
    expect(descriptor.policyId).toBe(policy.policy_id);
    expect(descriptor.schemaVersion).toBe(policy.schema_version);
    // The builder fills schema defaults (e.g. critical_objection_action), so the authored rules
    // must be a subset of what it emits — never altered.
    expect(JSON.parse(descriptor.rules)).toMatchObject(policy.rules as Record<string, unknown>);
  });

  it('the builder really refuses an off-domain value (the gate above is live)', () => {
    const [policy] = policies;
    const bad = {
      ...policy,
      rules: { ...policy.rules, commitment: { authority: 'everyone' } }
    } as unknown as PolicyDefinition;
    expect(() => build(bad)).toThrow(MacpSessionError);
  });
});
