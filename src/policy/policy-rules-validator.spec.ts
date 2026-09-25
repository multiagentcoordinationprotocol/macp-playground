import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PolicyRulesValidator } from './policy-rules-validator';

const GOOD_DECISION_RULES = {
  voting: {
    algorithm: 'majority',
    threshold: 0.5,
    quorum: { type: 'count', value: 2 }
  },
  objection_handling: {
    critical_severity_vetoes: true,
    veto_threshold: 1
  },
  evaluation: {
    minimum_confidence: 0.0,
    required_before_voting: false
  },
  commitment: {
    authority: 'initiator_only',
    require_vote_quorum: true,
    designated_roles: []
  }
};

const GOOD_DESCRIPTOR = {
  policy_id: 'policy.test',
  mode: 'macp.mode.decision.v1',
  schema_version: 3,
  description: 'test fixture',
  rules: GOOD_DECISION_RULES
};

describe('PolicyRulesValidator', () => {
  let validator: PolicyRulesValidator;

  beforeEach(() => {
    validator = new PolicyRulesValidator();
  });

  it('AC1: compiles all 5 mode schemas plus the descriptor schema with no ajv errors, no strict-mode console warnings', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
    const logSpy = jest.spyOn(console, 'log').mockImplementation();
    try {
      expect(() => new PolicyRulesValidator()).not.toThrow();
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it('AC2: a known-good decision rules object returns []', () => {
    expect(validator.validateRules('macp.mode.decision.v1', GOOD_DECISION_RULES)).toEqual([]);
  });

  it("AC3: an unknown key anywhere in objection_handling is rejected with a message naming the key path (the issue's own veto_threshhold typo)", () => {
    const broken = {
      ...GOOD_DECISION_RULES,
      objection_handling: {
        ...GOOD_DECISION_RULES.objection_handling,
        veto_threshhold: 3 // typo: extra "h" — the issue's own motivating example
      }
    };
    const errors = validator.validateRules('macp.mode.decision.v1', broken);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes('veto_threshhold'))).toBe(true);
  });

  it('AC4: $comment/_note annotation keys are accepted at the top level and at a nested closed level', () => {
    const annotated = {
      ...GOOD_DECISION_RULES,
      $comment: 'top-level annotation',
      objection_handling: {
        ...GOOD_DECISION_RULES.objection_handling,
        _note: 'nested annotation'
      }
    };
    expect(validator.validateRules('macp.mode.decision.v1', annotated)).toEqual([]);
  });

  it('AC5: voting.weights keys stay open for arbitrary participant ids, but the map still requires minProperties 1', () => {
    const withWeights = {
      ...GOOD_DECISION_RULES,
      voting: {
        algorithm: 'weighted',
        weights: { 'some-participant-id': 1 }
      }
    };
    expect(validator.validateRules('macp.mode.decision.v1', withWeights)).toEqual([]);

    const emptyWeights = {
      ...GOOD_DECISION_RULES,
      voting: {
        algorithm: 'weighted',
        weights: {}
      }
    };
    expect(validator.validateRules('macp.mode.decision.v1', emptyWeights).length).toBeGreaterThan(0);
  });

  it('AC6: validates the whole PolicyDefinition against the descriptor schema — schema_version 4 rejected, 1/2/3 accepted', () => {
    expect(validator.validateDescriptor({ ...GOOD_DESCRIPTOR, schema_version: 4 }).length).toBeGreaterThan(0);
    expect(validator.validateDescriptor({ ...GOOD_DESCRIPTOR, schema_version: 1 })).toEqual([]);
    expect(validator.validateDescriptor({ ...GOOD_DESCRIPTOR, schema_version: 2 })).toEqual([]);
    expect(validator.validateDescriptor({ ...GOOD_DESCRIPTOR, schema_version: 3 })).toEqual([]);
  });

  it('AC6b: the descriptor schema requires description, independent of rules shape', () => {
    const withoutDescription: Record<string, unknown> = { ...GOOD_DESCRIPTOR };
    delete withoutDescription.description;
    expect(validator.validateDescriptor(withoutDescription).length).toBeGreaterThan(0);
  });

  it('AC7: designated_role authority with an empty designated_roles array is rejected for both decision and quorum modes', () => {
    // `commitment` is the only field name shared across all 5 mode schemas — a
    // decision-shaped rules object fails a non-decision schema outright on unrelated
    // additionalProperties errors, so this fixture is intentionally minimal.
    const minimalFixture = {
      commitment: { authority: 'designated_role', designated_roles: [] }
    };
    expect(validator.validateRules('macp.mode.decision.v1', minimalFixture).length).toBeGreaterThan(0);
    expect(validator.validateRules('macp.mode.quorum.v1', minimalFixture).length).toBeGreaterThan(0);
  });

  it('AC7b: a non-empty designated_roles array is accepted for both modes', () => {
    const minimalFixture = {
      commitment: { authority: 'designated_role', designated_roles: ['risk-agent'] }
    };
    expect(validator.validateRules('macp.mode.decision.v1', minimalFixture)).toEqual([]);
    expect(validator.validateRules('macp.mode.quorum.v1', minimalFixture)).toEqual([]);
  });

  it('validates a decision-shaped mode-agnostic ("*") policy, still catching a typo nested inside a decision-only key', () => {
    expect(validator.validateRules('*', GOOD_DECISION_RULES)).toEqual([]);
    const broken = { ...GOOD_DECISION_RULES, objection_handling: { veto_threshhold: 3 } };
    expect(validator.validateRules('*', broken).length).toBeGreaterThan(0);
  });

  it("AC-reconcile: a wildcard policy is validated against every standards-track mode's schema, not just decision's", () => {
    // Regression test for macp-runtime's own fail-open-defect fix (registry.rs:369-414,
    // commit 298c0f4): a wildcard-mode policy can legitimately carry a quorum-only field
    // (`threshold`) if the session it eventually binds to turns out to be a Quorum
    // session — and that field's value must actually be checked, not silently waved
    // through the way a Decision-only dispatch would (Decision doesn't recognize
    // `threshold` at all, so a naive single-schema dispatch never even looks at it).
    const withValidThreshold = { ...GOOD_DECISION_RULES, threshold: { type: 'n_of_m', value: 5 } };
    expect(validator.validateRules('*', withValidThreshold)).toEqual([]);

    // threshold.value must be > 0 (schemas/policy/quorum-rules.schema.json's own
    // exclusiveMinimum: 0 — a zero approval bar trivially passes everything). A
    // Decision-only wildcard dispatch would never catch this, since Decision's schema
    // doesn't declare `threshold` and would just reject the whole object as an
    // unrecognized top-level key rather than checking its value at all.
    const withInvalidThreshold = { ...GOOD_DECISION_RULES, threshold: { type: 'n_of_m', value: 0 } };
    expect(validator.validateRules('*', withInvalidThreshold).length).toBeGreaterThan(0);
  });

  it('AC-reconcile: an entirely unrecognized top-level key on a wildcard policy is still rejected', () => {
    const withBogusKey = { ...GOOD_DECISION_RULES, totally_made_up_section: { foo: 'bar' } };
    const errors = validator.validateRules('*', withBogusKey);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes('totally_made_up_section'))).toBe(true);
  });

  it('returns an explicit "unknown mode" error rather than silently passing for an unrecognized mode', () => {
    const errors = validator.validateRules('macp.mode.made-up.v1', GOOD_DECISION_RULES);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('macp.mode.made-up.v1');
  });

  it('a malformed vendored schema fails loudly at construction (throws, does not silently produce a no-op validator)', () => {
    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-rules-validator-spec-'));
    fs.writeFileSync(path.join(scratchDir, 'decision-rules.schema.json'), '{ not valid json');
    const originalCwd = process.cwd();
    try {
      // schemas/ must sit at "<cwd>/schemas/policy" — point cwd at a scratch dir whose
      // schemas/policy/decision-rules.schema.json is corrupt, leaving the other 5 files
      // absent entirely (also must fail, just for a different reason: ENOENT).
      fs.mkdirSync(path.join(scratchDir, 'schemas', 'policy'), { recursive: true });
      fs.renameSync(
        path.join(scratchDir, 'decision-rules.schema.json'),
        path.join(scratchDir, 'schemas', 'policy', 'decision-rules.schema.json')
      );
      process.chdir(scratchDir);
      expect(() => new PolicyRulesValidator()).toThrow();
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  });
});
