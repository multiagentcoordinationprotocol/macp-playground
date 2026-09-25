// Unlike policy-loader.service.spec.ts (which mocks node:fs with inline
// fixtures), this spec reads the real `policies/*.json` files straight off
// disk. That distinction matters: a spec built on inline fixtures is a
// tautology against a hand-authored real file — it proves the loader parses
// what it's given, never that the files it's actually given are correct. The
// bug this repo shipped once (policy.lending.conservative.json's
// designated_roles holding role labels like "risk" instead of the
// runtime-matched participant identity "risk-agent") was invisible to every
// tier of mocked/fixture-based test; only a spec reading the real files
// against the real participant rosters would have caught it.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { PolicyDefinition } from '../contracts/policy';
import { PolicyLoaderService } from './policy-loader.service';
import { PolicyRulesValidator } from './policy-rules-validator';

const POLICIES_DIR = path.resolve(__dirname, '../../policies');
const PARTICIPANTS_DIR = path.resolve(__dirname, '../../packs/_shared/participants');

function loadRealPolicies(): PolicyDefinition[] {
  const files = fs.readdirSync(POLICIES_DIR).filter((f) => f.endsWith('.json'));
  return files.map((file) => JSON.parse(fs.readFileSync(path.join(POLICIES_DIR, file), 'utf-8')) as PolicyDefinition);
}

function loadRealParticipantIds(): Set<string> {
  const files = fs.readdirSync(PARTICIPANTS_DIR).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
  const ids = new Set<string>();
  for (const file of files) {
    const raw = fs.readFileSync(path.join(PARTICIPANTS_DIR, file), 'utf-8');
    const roster = yaml.load(raw) as Array<{ id: string; role: string }>;
    for (const participant of roster) {
      ids.add(participant.id);
    }
  }
  return ids;
}

describe('policies/*.json (on disk)', () => {
  const policies = loadRealPolicies();
  const participantIds = loadRealParticipantIds();

  it('has exactly the 6 bundled policy files', () => {
    // Guards against a new policy landing without the schema_version /
    // designated_roles checks below ever being applied to it.
    expect(policies).toHaveLength(6);
  });

  it.each(policies.map((p) => [p.policy_id, p] as const))('%s uses schema_version 3', (_id, policy) => {
    expect(policy.schema_version).toBe(3);
  });

  it('uses only recognized commitment.authority values', () => {
    const validAuthorities = ['initiator_only', 'designated_role', 'any_participant'];
    for (const policy of policies) {
      expect(validAuthorities).toContain(policy.rules.commitment.authority);
    }
  });

  it('never uses the plural "designated_roles" as an authority value (regression guard for the original typo)', () => {
    for (const policy of policies) {
      expect(policy.rules.commitment.authority).not.toBe('designated_roles');
    }
  });

  it('policy.lending.conservative.json requires designated_role authority', () => {
    const lending = policies.find((p) => p.policy_id === 'policy.lending.conservative');
    expect(lending?.rules.commitment.authority).toBe('designated_role');
  });

  describe('designated_roles reference real participant identities, not role labels', () => {
    const withDesignatedRole = policies.filter((p) => p.rules.commitment.authority === 'designated_role');

    it('at least one shipped policy actually exercises designated_role authority', () => {
      // If this ever regresses to 0, every test below is vacuously true —
      // guard against the check silently stopping to mean anything.
      expect(withDesignatedRole.length).toBeGreaterThan(0);
    });

    it.each(withDesignatedRole.map((p) => [p.policy_id, p] as const))(
      '%s: every designated_roles entry is a real participant id',
      (_id, policy) => {
        for (const role of policy.rules.commitment.designated_roles) {
          expect(participantIds.has(role)).toBe(true);
        }
      }
    );

    it('rejects the specific regression this check exists to catch: a human-readable role label is not a valid participant id', () => {
      // "risk"/"compliance" are `role:` labels in packs/_shared/participants/
      // (see 4-agent-lending.yaml), never `id:` values. If this assertion
      // ever fails, participantIds is built wrong and every test above is
      // meaningless.
      expect(participantIds.has('risk')).toBe(false);
      expect(participantIds.has('compliance')).toBe(false);
      expect(participantIds.has('risk-agent')).toBe(true);
      expect(participantIds.has('compliance-agent')).toBe(true);
    });
  });

  it('passes PolicyLoaderService.validatePolicy() with zero warnings for every shipped file', () => {
    const service = new PolicyLoaderService();
    for (const policy of policies) {
      expect(service.validatePolicy(policy)).toEqual([]);
    }
  });

  describe('conforms to the real upstream rule schemas (#81)', () => {
    // The hard CI gate for #81: PolicyLoaderService.validatePolicy() above is warn-and-load,
    // never fails a test on its own. This block calls PolicyRulesValidator directly, keyed by
    // each policy's own `mode` (including "*"), so a shape regression like the issue's own
    // `veto_threshhold` typo — or the `veto_threshold: 0` bug this repo actually shipped —
    // turns red here rather than loading silently. Sanity-checked during implementation by
    // temporarily reintroducing `veto_threshold: 0` into one shipped file and confirming this
    // block goes red, then reverting — not committed as a separate test since it would just be
    // testing PolicyRulesValidator's own already-covered behavior (policy-rules-validator.spec.ts).
    const validator = new PolicyRulesValidator();

    it.each(policies.map((p) => [p.policy_id, p] as const))('%s rules conform to their mode schema', (_id, policy) => {
      expect(validator.validateRules(policy.mode, policy.rules)).toEqual([]);
    });

    it.each(policies.map((p) => [p.policy_id, p] as const))('%s conforms to the descriptor schema', (_id, policy) => {
      expect(validator.validateDescriptor(policy)).toEqual([]);
    });

    it("covers policy.default.json's wildcard mode explicitly, not just incidentally", () => {
      const wildcardPolicies = policies.filter((p) => p.mode === '*');
      expect(wildcardPolicies).toHaveLength(1);
      expect(wildcardPolicies[0].policy_id).toBe('policy.default');
      expect(validator.validateRules('*', wildcardPolicies[0].rules)).toEqual([]);
    });
  });
});
