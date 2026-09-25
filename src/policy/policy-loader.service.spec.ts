import * as fs from 'node:fs';
import { PolicyDefinition } from '../contracts/policy';
import { PolicyLoaderService } from './policy-loader.service';

jest.mock('node:fs');
const fsMock = fs as jest.Mocked<typeof fs>;
const actualFs = jest.requireActual<typeof fs>('node:fs');

/**
 * PolicyLoaderService's constructor now also constructs a real PolicyRulesValidator (#81),
 * which reads the real vendored schema files off disk via fs.readFileSync. Since this file
 * mocks the whole `node:fs` module, every readFileSync stand-in below must delegate
 * schema-path reads to the real filesystem and only fake the policies/*.json content —
 * otherwise every `new PolicyLoaderService()` in this file throws at construction time.
 */
function delegatingReadFileSync(policyContent: (path: string) => string): typeof fs.readFileSync {
  return ((filePath: fs.PathOrFileDescriptor, options?: unknown) => {
    const p = String(filePath);
    if (p.includes('schemas')) {
      return actualFs.readFileSync(filePath as fs.PathOrFileDescriptor, options as BufferEncoding);
    }
    return policyContent(p);
  }) as typeof fs.readFileSync;
}

describe('PolicyLoaderService', () => {
  let service: PolicyLoaderService;

  const defaultPolicy: PolicyDefinition = {
    policy_id: 'policy.default',
    mode: '*',
    schema_version: 3,
    description: 'Default policy',
    rules: {
      voting: { algorithm: 'none' },
      objection_handling: { critical_severity_vetoes: false, veto_threshold: 1 },
      evaluation: { minimum_confidence: 0, required_before_voting: false },
      commitment: { authority: 'initiator_only', require_vote_quorum: false, designated_roles: [] }
    }
  };

  const fraudPolicy: PolicyDefinition = {
    policy_id: 'policy.fraud.unanimous',
    mode: 'macp.mode.decision.v1',
    schema_version: 3,
    description: 'Unanimous',
    rules: {
      voting: { algorithm: 'unanimous' },
      objection_handling: { critical_severity_vetoes: true, veto_threshold: 1 },
      evaluation: { minimum_confidence: 0.7, required_before_voting: true },
      commitment: { authority: 'initiator_only', require_vote_quorum: true, designated_roles: [] }
    }
  };

  beforeEach(() => {
    fsMock.existsSync.mockReturnValue(true);
    (fsMock.readdirSync as jest.Mock).mockReturnValue(['policy.default.json', 'policy.fraud.unanimous.json']);
    fsMock.readFileSync.mockImplementation(
      delegatingReadFileSync((p) => {
        if (p.includes('policy.default.json')) return JSON.stringify(defaultPolicy);
        if (p.includes('policy.fraud.unanimous.json')) return JSON.stringify(fraudPolicy);
        throw new Error('file not found');
      })
    );
    // Constructed last, after the mocks above are in place — its constructor now eagerly
    // builds a real PolicyRulesValidator, which reads schema files via the mock above.
    service = new PolicyLoaderService();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('loads policies from the policies directory', () => {
    const policies = service.listAvailablePolicies();
    expect(policies).toHaveLength(2);
    expect(policies.map((p) => p.policy_id)).toEqual(
      expect.arrayContaining(['policy.default', 'policy.fraud.unanimous'])
    );
  });

  it('loads a specific policy by ID', () => {
    const policy = service.loadPolicy('policy.fraud.unanimous');
    expect(policy).toBeDefined();
    expect(policy!.policy_id).toBe('policy.fraud.unanimous');
    expect(policy!.rules.voting.algorithm).toBe('unanimous');
  });

  it('returns undefined for unknown policy ID', () => {
    const policy = service.loadPolicy('policy.unknown');
    expect(policy).toBeUndefined();
  });

  it('caches policies after first load', () => {
    const freshService = new PolicyLoaderService();
    (fsMock.readdirSync as jest.Mock).mockClear();
    freshService.listAvailablePolicies();
    freshService.listAvailablePolicies();
    // readdirSync should only be called once due to caching
    expect(fsMock.readdirSync).toHaveBeenCalledTimes(1);
  });

  it('filters out policy.default from registrable policies', () => {
    const registrable = service.listRegistrablePolicies();
    expect(registrable).toHaveLength(1);
    expect(registrable[0].policy_id).toBe('policy.fraud.unanimous');
  });

  it('handles missing policies directory gracefully', () => {
    fsMock.existsSync.mockReturnValue(false);
    service = new PolicyLoaderService();
    const policies = service.listAvailablePolicies();
    expect(policies).toHaveLength(0);
  });

  it('handles malformed JSON gracefully', () => {
    fsMock.readFileSync.mockImplementation(delegatingReadFileSync(() => 'not valid json'));
    service = new PolicyLoaderService();
    const policies = service.listAvailablePolicies();
    expect(policies).toHaveLength(0);
  });

  it('skips files without policy_id', () => {
    (fsMock.readdirSync as jest.Mock).mockReturnValue(['broken.json']);
    fsMock.readFileSync.mockImplementation(
      delegatingReadFileSync(() => JSON.stringify({ description: 'no policy_id' }))
    );
    service = new PolicyLoaderService();
    const policies = service.listAvailablePolicies();
    expect(policies).toHaveLength(0);
  });

  describe('validatePolicy', () => {
    it('returns no errors for a valid policy', () => {
      const errors = service.validatePolicy(fraudPolicy);
      expect(errors).toEqual([]);
    });

    it('returns error when schema_version < 1', () => {
      const errors = service.validatePolicy({ ...fraudPolicy, schema_version: 0 });
      expect(errors).toContain('schema_version must be >= 1');
    });

    // The four hand-rolled checks these next several tests originally exercised (supermajority
    // threshold, weighted-requires-weights, minimum_confidence range, designated_role) were
    // removed in #81 / plan Phase 2 as exactly redundant with the real vendored schema now
    // wired in via PolicyRulesValidator. The rejections below still happen — via the schema —
    // so these tests are updated to assert against the schema's own formatted messages
    // (which include the offending path, e.g. "/voting/threshold") rather than deleted
    // hand-rolled strings, preserving the regression coverage rather than dropping it.

    it('returns error when supermajority threshold is <= 0.5 (caught by the real upstream schema)', () => {
      const policy = {
        ...fraudPolicy,
        rules: {
          ...fraudPolicy.rules,
          voting: { algorithm: 'supermajority' as const, threshold: 0.5 }
        }
      };
      const errors = service.validatePolicy(policy);
      expect(errors.some((e) => e.includes('threshold'))).toBe(true);
    });

    it('accepts supermajority with threshold > 0.5', () => {
      const policy = {
        ...fraudPolicy,
        rules: {
          ...fraudPolicy.rules,
          voting: { algorithm: 'supermajority' as const, threshold: 0.67 }
        }
      };
      const errors = service.validatePolicy(policy);
      expect(errors).toEqual([]);
    });

    it('returns error when weighted algorithm has no weights (caught by the real upstream schema)', () => {
      const policy = {
        ...fraudPolicy,
        rules: {
          ...fraudPolicy.rules,
          voting: { algorithm: 'weighted' as const }
        }
      };
      const errors = service.validatePolicy(policy);
      expect(errors.some((e) => e.includes('weights'))).toBe(true);
    });

    it('returns error when weighted algorithm has empty weights map (caught by the real upstream schema)', () => {
      const policy: PolicyDefinition = {
        ...fraudPolicy,
        rules: {
          ...fraudPolicy.rules,
          voting: { algorithm: 'weighted', weights: {} }
        }
      };
      const errors = service.validatePolicy(policy);
      expect(errors.some((e) => e.includes('weights'))).toBe(true);
    });

    it('returns error when designated_role authority has empty roles (caught by the real upstream schema)', () => {
      const policy: PolicyDefinition = {
        ...fraudPolicy,
        rules: {
          ...fraudPolicy.rules,
          commitment: {
            authority: 'designated_role',
            require_vote_quorum: true,
            designated_roles: []
          }
        }
      };
      const errors = service.validatePolicy(policy);
      expect(errors.some((e) => e.includes('designated_roles'))).toBe(true);
    });

    it('accepts designated_role authority with non-empty roles', () => {
      const policy: PolicyDefinition = {
        ...fraudPolicy,
        rules: {
          ...fraudPolicy.rules,
          commitment: {
            authority: 'designated_role',
            require_vote_quorum: true,
            designated_roles: ['risk-lead']
          }
        }
      };
      const errors = service.validatePolicy(policy);
      expect(errors).toEqual([]);
    });

    it('returns error when minimum_confidence > 1 (caught by the real upstream schema)', () => {
      const policy: PolicyDefinition = {
        ...fraudPolicy,
        rules: {
          ...fraudPolicy.rules,
          evaluation: { minimum_confidence: 1.5, required_before_voting: false }
        }
      };
      const errors = service.validatePolicy(policy);
      expect(errors.some((e) => e.includes('minimum_confidence'))).toBe(true);
    });

    it('returns error when minimum_confidence < 0 (caught by the real upstream schema)', () => {
      const policy: PolicyDefinition = {
        ...fraudPolicy,
        rules: {
          ...fraudPolicy.rules,
          evaluation: { minimum_confidence: -0.1, required_before_voting: false }
        }
      };
      const errors = service.validatePolicy(policy);
      expect(errors.some((e) => e.includes('minimum_confidence'))).toBe(true);
    });

    it('returns error when veto_threshold < 1 and critical_severity_vetoes is true', () => {
      const policy: PolicyDefinition = {
        ...fraudPolicy,
        rules: {
          ...fraudPolicy.rules,
          objection_handling: { critical_severity_vetoes: true, veto_threshold: 0 }
        }
      };
      const errors = service.validatePolicy(policy);
      expect(errors).toContain('veto_threshold must be >= 1 when critical_severity_vetoes is true');
    });

    it('does not require veto_threshold >= 1 when critical_severity_vetoes is false', () => {
      const policy: PolicyDefinition = {
        ...fraudPolicy,
        rules: {
          ...fraudPolicy.rules,
          objection_handling: { critical_severity_vetoes: false, veto_threshold: 0 }
        }
      };
      const errors = service.validatePolicy(policy);
      expect(errors).not.toEqual(expect.arrayContaining([expect.stringContaining('veto_threshold must be >= 1')]));
    });

    it('warns when veto_threshold is set but critical_severity_vetoes is false (dead config)', () => {
      const policy: PolicyDefinition = {
        ...fraudPolicy,
        rules: {
          ...fraudPolicy.rules,
          objection_handling: { critical_severity_vetoes: false, veto_threshold: 1 }
        }
      };
      const errors = service.validatePolicy(policy);
      expect(errors).toContain(
        'veto_threshold is set but critical_severity_vetoes is false — the threshold is never read'
      );
    });

    // Inverted per #81 / plan Phase 2: this test previously asserted 0 was silently accepted
    // as the "vetoes are off" sentinel. That's exactly what steered policy authors toward the
    // one value that fails the real upstream schema's `veto_threshold: { minimum: 1 }` — the
    // schema-conformant way to say "off" is to omit the key entirely, not set it to 0. Now
    // both the hand-rolled dead-config warning AND the real schema flag this independently.
    it('warns when veto_threshold is 0 and critical_severity_vetoes is false', () => {
      const policy: PolicyDefinition = {
        ...fraudPolicy,
        rules: {
          ...fraudPolicy.rules,
          objection_handling: { critical_severity_vetoes: false, veto_threshold: 0 }
        }
      };
      const errors = service.validatePolicy(policy);
      expect(errors).toContain(
        'veto_threshold is set but critical_severity_vetoes is false — the threshold is never read'
      );
      expect(errors.length).toBeGreaterThanOrEqual(2);
    });

    it('returns error when schema_version exceeds the highest version the runtime supports', () => {
      const policy: PolicyDefinition = { ...fraudPolicy, schema_version: 4 };
      const errors = service.validatePolicy(policy);
      expect(errors).toContain(
        'schema_version 4 exceeds the highest version this evaluator supports (3); every commitment under this policy will be denied with "unsupported policy schema version"'
      );
    });

    it('accepts schema_version 3 without an upper-bound error', () => {
      const policy: PolicyDefinition = { ...fraudPolicy, schema_version: 3 };
      const errors = service.validatePolicy(policy);
      expect(errors).not.toEqual(expect.arrayContaining([expect.stringContaining('exceeds the highest version')]));
    });

    it('returns multiple errors for multiple violations', () => {
      const policy: PolicyDefinition = {
        ...fraudPolicy,
        schema_version: 0,
        rules: {
          ...fraudPolicy.rules,
          voting: { algorithm: 'weighted' },
          evaluation: { minimum_confidence: 2, required_before_voting: false }
        }
      };
      const errors = service.validatePolicy(policy);
      expect(errors.length).toBeGreaterThanOrEqual(3);
    });

    it('still loads policies with validation warnings', () => {
      const invalidPolicy = {
        policy_id: 'policy.bad',
        mode: '*',
        schema_version: 0,
        description: 'bad policy',
        rules: {
          voting: { algorithm: 'weighted' as const },
          objection_handling: { critical_severity_vetoes: false, veto_threshold: 1 },
          evaluation: { minimum_confidence: 0, required_before_voting: false },
          commitment: { authority: 'initiator_only' as const, require_vote_quorum: false, designated_roles: [] }
        }
      };
      (fsMock.readdirSync as jest.Mock).mockReturnValue(['policy.bad.json']);
      fsMock.readFileSync.mockImplementation(delegatingReadFileSync(() => JSON.stringify(invalidPolicy)));
      service = new PolicyLoaderService();
      const policies = service.listAvailablePolicies();
      // Policy is still loaded despite warnings (non-fatal validation)
      expect(policies).toHaveLength(1);
      expect(policies[0].policy_id).toBe('policy.bad');
    });
  });
});
