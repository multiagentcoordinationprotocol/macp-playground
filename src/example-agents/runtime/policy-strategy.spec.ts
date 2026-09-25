import { createPolicyStrategy, PolicyHints, SpecialistSignal } from './policy-strategy';

function signal(
  participantId: string,
  messageType: 'Evaluation' | 'Objection',
  overrides: Partial<SpecialistSignal> = {}
): SpecialistSignal {
  return { participantId, messageType, ...overrides };
}

function signalMap(...signals: SpecialistSignal[]): Map<string, SpecialistSignal> {
  return new Map(signals.map((s) => [s.participantId, s]));
}

describe('PolicyStrategy', () => {
  describe('createPolicyStrategy with no hints (default/none)', () => {
    const strategy = createPolicyStrategy(undefined);

    it('quorum requires all expected specialists (policy=none waits for everyone, then applies pass/block)', () => {
      expect(strategy.isQuorumMet(new Map(), 3)).toBe(false);
      expect(strategy.isQuorumMet(signalMap(signal('a', 'Evaluation')), 3)).toBe(false);
      expect(strategy.isQuorumMet(signalMap(signal('a', 'Evaluation'), signal('b', 'Evaluation')), 3)).toBe(false);
      expect(
        strategy.isQuorumMet(
          signalMap(signal('a', 'Evaluation'), signal('b', 'Evaluation'), signal('c', 'Evaluation')),
          3
        )
      ).toBe(true);
    });

    it('approves when no blocking signals', () => {
      const signals = signalMap(
        signal('a', 'Evaluation', { recommendation: 'APPROVE' }),
        signal('b', 'Evaluation', { recommendation: 'APPROVE' })
      );
      const decision = strategy.decide(signals, {});
      expect(decision.action).toBe('approve');
      expect(decision.vote).toBe('approve');
      expect(decision.policyApplied).toBe('none');
    });

    it('declines when blocking signals present', () => {
      const signals = signalMap(
        signal('a', 'Evaluation', { recommendation: 'APPROVE' }),
        signal('b', 'Evaluation', { recommendation: 'BLOCK' })
      );
      const decision = strategy.decide(signals, {});
      expect(decision.action).toBe('decline');
      expect(decision.vote).toBe('reject');
    });

    it('declines on any objection', () => {
      const signals = signalMap(signal('a', 'Objection', { severity: 'low', reason: 'concern' }));
      const decision = strategy.decide(signals, {});
      expect(decision.action).toBe('decline');
    });
  });

  describe('createPolicyStrategy with majority hints', () => {
    const hints: PolicyHints = { type: 'majority', threshold: 0.5, vetoEnabled: false };
    const strategy = createPolicyStrategy(hints);

    it('quorum requires at least ceil(total * threshold) signals', () => {
      expect(strategy.isQuorumMet(signalMap(signal('a', 'Evaluation')), 3)).toBe(false);
      expect(strategy.isQuorumMet(signalMap(signal('a', 'Evaluation'), signal('b', 'Evaluation')), 3)).toBe(true);
    });

    it('approves when approval rate meets threshold', () => {
      const signals = signalMap(
        signal('a', 'Evaluation', { recommendation: 'APPROVE' }),
        signal('b', 'Evaluation', { recommendation: 'APPROVE' }),
        signal('c', 'Evaluation', { recommendation: 'REVIEW' })
      );
      const decision = strategy.decide(signals, {});
      expect(decision.action).toBe('approve');
      expect(decision.reason).toContain('67%');
      expect(decision.policyApplied).toBe('majority');
    });

    it('steps up when approval below threshold', () => {
      const signals = signalMap(
        signal('a', 'Evaluation', { recommendation: 'APPROVE' }),
        signal('b', 'Evaluation', { recommendation: 'REVIEW' }),
        signal('c', 'Evaluation', { recommendation: 'REVIEW' })
      );
      const decision = strategy.decide(signals, {});
      expect(decision.action).toBe('step_up');
    });

    it('declines when majority rejected', () => {
      const signals = signalMap(
        signal('a', 'Evaluation', { recommendation: 'BLOCK' }),
        signal('b', 'Evaluation', { recommendation: 'BLOCK' }),
        signal('c', 'Evaluation', { recommendation: 'APPROVE' })
      );
      const decision = strategy.decide(signals, {});
      expect(decision.action).toBe('decline');
    });

    it('does not veto when vetoEnabled is false', () => {
      const signals = signalMap(
        signal('a', 'Objection', { severity: 'high', reason: 'concern' }),
        signal('b', 'Evaluation', { recommendation: 'APPROVE' }),
        signal('c', 'Evaluation', { recommendation: 'APPROVE' })
      );
      const decision = strategy.decide(signals, {});
      // With veto disabled, objections count as non-approvals but don't auto-decline
      expect(decision.policyApplied).toBe('majority');
    });
  });

  describe('createPolicyStrategy with majority-veto hints', () => {
    const hints: PolicyHints = { type: 'majority', threshold: 0.5, vetoEnabled: true };
    const strategy = createPolicyStrategy(hints);

    it('declines on critical-severity objection when veto enabled', () => {
      const signals = signalMap(
        signal('a', 'Objection', { severity: 'critical', reason: 'compliance violation' }),
        signal('b', 'Evaluation', { recommendation: 'APPROVE' }),
        signal('c', 'Evaluation', { recommendation: 'APPROVE' })
      );
      const decision = strategy.decide(signals, {});
      expect(decision.action).toBe('decline');
      expect(decision.vote).toBe('reject');
      expect(decision.reason).toContain('veto threshold');
    });

    it('does not veto on high-severity objection (critical-only)', () => {
      const signals = signalMap(
        signal('a', 'Objection', { severity: 'high', reason: 'major concern' }),
        signal('b', 'Evaluation', { recommendation: 'APPROVE' }),
        signal('c', 'Evaluation', { recommendation: 'APPROVE' })
      );
      const decision = strategy.decide(signals, {});
      // High severity no longer triggers veto (critical-only per RFC-MACP-0004)
      expect(decision.policyApplied).toBe('majority');
    });

    it('does not veto on low-severity objection', () => {
      const signals = signalMap(
        signal('a', 'Objection', { severity: 'low', reason: 'minor concern' }),
        signal('b', 'Evaluation', { recommendation: 'APPROVE' }),
        signal('c', 'Evaluation', { recommendation: 'APPROVE' })
      );
      const decision = strategy.decide(signals, {});
      expect(decision.policyApplied).toBe('majority');
    });
  });

  describe('createPolicyStrategy with supermajority hints', () => {
    const hints: PolicyHints = { type: 'supermajority', threshold: 0.67 };
    const strategy = createPolicyStrategy(hints);

    it('requires higher quorum (ceil(3 * 0.67) = 3)', () => {
      expect(strategy.isQuorumMet(signalMap(signal('a', 'Evaluation')), 3)).toBe(false);
      expect(strategy.isQuorumMet(signalMap(signal('a', 'Evaluation'), signal('b', 'Evaluation')), 3)).toBe(false);
      expect(
        strategy.isQuorumMet(
          signalMap(signal('a', 'Evaluation'), signal('b', 'Evaluation'), signal('c', 'Evaluation')),
          3
        )
      ).toBe(true);
    });

    it('approves when approval rate meets 67% threshold (3/4 = 75%)', () => {
      const signals = signalMap(
        signal('a', 'Evaluation', { recommendation: 'APPROVE' }),
        signal('b', 'Evaluation', { recommendation: 'APPROVE' }),
        signal('c', 'Evaluation', { recommendation: 'APPROVE' }),
        signal('d', 'Evaluation', { recommendation: 'REVIEW' })
      );
      const decision = strategy.decide(signals, {});
      expect(decision.action).toBe('approve');
      expect(decision.reason).toContain('75%');
    });

    it('steps up when just below threshold', () => {
      const signals = signalMap(
        signal('a', 'Evaluation', { recommendation: 'APPROVE' }),
        signal('b', 'Evaluation', { recommendation: 'REVIEW' }),
        signal('c', 'Evaluation', { recommendation: 'REVIEW' }),
        signal('d', 'Evaluation', { recommendation: 'REVIEW' })
      );
      const decision = strategy.decide(signals, {});
      expect(decision.action).toBe('step_up');
    });

    it('with 3 specialists, 2 approvals + 1 non-qualifying review falls just short of 67% (2/3 = 66.67%)', () => {
      const signals = signalMap(
        signal('a', 'Evaluation', { recommendation: 'APPROVE' }),
        signal('b', 'Evaluation', { recommendation: 'APPROVE' }),
        signal('c', 'Evaluation', { recommendation: 'REVIEW' })
      );
      const decision = strategy.decide(signals, {});
      expect(decision.action).toBe('step_up');
    });

    it('with 3 specialists, all 3 approvals meets 67% threshold (3/3 = 100%)', () => {
      const signals = signalMap(
        signal('a', 'Evaluation', { recommendation: 'APPROVE' }),
        signal('b', 'Evaluation', { recommendation: 'APPROVE' }),
        signal('c', 'Evaluation', { recommendation: 'APPROVE' })
      );
      const decision = strategy.decide(signals, {});
      expect(decision.action).toBe('approve');
    });
  });

  describe('createPolicyStrategy with unanimous hints', () => {
    const hints: PolicyHints = { type: 'unanimous', threshold: 1.0, vetoEnabled: true };
    const strategy = createPolicyStrategy(hints);

    it('requires all specialists for quorum', () => {
      expect(strategy.isQuorumMet(signalMap(signal('a', 'Evaluation'), signal('b', 'Evaluation')), 3)).toBe(false);
      expect(
        strategy.isQuorumMet(
          signalMap(signal('a', 'Evaluation'), signal('b', 'Evaluation'), signal('c', 'Evaluation')),
          3
        )
      ).toBe(true);
    });

    it('approves when all approve', () => {
      const signals = signalMap(
        signal('a', 'Evaluation', { recommendation: 'APPROVE' }),
        signal('b', 'Evaluation', { recommendation: 'APPROVE' }),
        signal('c', 'Evaluation', { recommendation: 'APPROVE' })
      );
      const decision = strategy.decide(signals, {});
      expect(decision.action).toBe('approve');
      expect(decision.policyApplied).toBe('unanimous');
    });

    it('declines on any rejection', () => {
      const signals = signalMap(
        signal('a', 'Evaluation', { recommendation: 'APPROVE' }),
        signal('b', 'Evaluation', { recommendation: 'BLOCK' }),
        signal('c', 'Evaluation', { recommendation: 'APPROVE' })
      );
      const decision = strategy.decide(signals, {});
      expect(decision.action).toBe('decline');
      expect(decision.vote).toBe('reject');
      expect(decision.reason).toContain('unanimous');
    });

    it('declines on any objection (unanimous always rejects on objection)', () => {
      const signals = signalMap(
        signal('a', 'Evaluation', { recommendation: 'APPROVE' }),
        signal('b', 'Objection', { severity: 'critical', reason: 'concern' }),
        signal('c', 'Evaluation', { recommendation: 'APPROVE' })
      );
      const decision = strategy.decide(signals, {});
      expect(decision.action).toBe('decline');
    });

    it('steps up on mixed non-blocking signals', () => {
      const signals = signalMap(
        signal('a', 'Evaluation', { recommendation: 'APPROVE' }),
        signal('b', 'Evaluation', { recommendation: 'REVIEW' }),
        signal('c', 'Evaluation', { recommendation: 'APPROVE' })
      );
      const decision = strategy.decide(signals, {});
      expect(decision.action).toBe('step_up');
    });
  });

  describe('RFC-MACP-0012: vetoThreshold', () => {
    it('does not veto when critical objections are below veto threshold', () => {
      const hints: PolicyHints = { type: 'majority', threshold: 0.5, vetoEnabled: true, vetoThreshold: 2 };
      const strategy = createPolicyStrategy(hints);
      const signals = signalMap(
        signal('a', 'Objection', { severity: 'critical', reason: 'compliance issue' }),
        signal('b', 'Evaluation', { recommendation: 'APPROVE' }),
        signal('c', 'Evaluation', { recommendation: 'APPROVE' })
      );
      const decision = strategy.decide(signals, {});
      // Only 1 critical objection, but threshold is 2 — no veto
      expect(decision.action).toBe('approve');
      expect(decision.policyApplied).toBe('majority');
    });

    it('vetoes when critical objections meet veto threshold of 2', () => {
      const hints: PolicyHints = { type: 'majority', threshold: 0.5, vetoEnabled: true, vetoThreshold: 2 };
      const strategy = createPolicyStrategy(hints);
      const signals = signalMap(
        signal('a', 'Objection', { severity: 'critical', reason: 'compliance issue' }),
        signal('b', 'Objection', { severity: 'critical', reason: 'fraud detected' }),
        signal('c', 'Evaluation', { recommendation: 'APPROVE' })
      );
      const decision = strategy.decide(signals, {});
      expect(decision.action).toBe('decline');
      expect(decision.vote).toBe('reject');
      expect(decision.reason).toContain('veto threshold of 2');
    });

    it('defaults vetoThreshold to 1 when not specified', () => {
      const hints: PolicyHints = { type: 'majority', threshold: 0.5, vetoEnabled: true };
      const strategy = createPolicyStrategy(hints);
      const signals = signalMap(
        signal('a', 'Objection', { severity: 'critical', reason: 'concern' }),
        signal('b', 'Evaluation', { recommendation: 'APPROVE' }),
        signal('c', 'Evaluation', { recommendation: 'APPROVE' })
      );
      const decision = strategy.decide(signals, {});
      expect(decision.action).toBe('decline');
      expect(decision.reason).toContain('veto threshold of 1');
    });

    it('only counts critical severity towards veto threshold (not high)', () => {
      const hints: PolicyHints = { type: 'majority', threshold: 0.5, vetoEnabled: true, vetoThreshold: 2 };
      const strategy = createPolicyStrategy(hints);
      const signals = signalMap(
        signal('a', 'Objection', { severity: 'critical', reason: 'critical concern' }),
        signal('b', 'Objection', { severity: 'high', reason: 'high concern' }),
        signal('c', 'Evaluation', { recommendation: 'APPROVE' }),
        signal('d', 'Evaluation', { recommendation: 'APPROVE' })
      );
      const decision = strategy.decide(signals, {});
      // 1 critical + 1 high = only 1 critical counts toward veto threshold of 2, so no veto
      expect(decision.reason).not.toContain('veto threshold');
      expect(decision.action).toBe('approve');
    });
  });

  describe('RFC-MACP-0012: minimumConfidence', () => {
    it('filters evaluations below minimum confidence threshold', () => {
      const hints: PolicyHints = {
        type: 'unanimous',
        threshold: 1.0,
        minimumConfidence: 0.7
      };
      const strategy = createPolicyStrategy(hints);
      const signals = signalMap(
        signal('a', 'Evaluation', { recommendation: 'APPROVE', confidence: 0.9 }),
        signal('b', 'Evaluation', { recommendation: 'APPROVE', confidence: 0.5 }),
        signal('c', 'Evaluation', { recommendation: 'APPROVE', confidence: 0.8 })
      );
      const decision = strategy.decide(signals, {});
      // b has confidence 0.5 < 0.7 threshold, disqualified -> step_up for unanimous
      expect(decision.action).toBe('step_up');
      expect(decision.reason).toContain('below minimum confidence');
    });

    it('approves when all evaluations meet minimum confidence', () => {
      const hints: PolicyHints = {
        type: 'unanimous',
        threshold: 1.0,
        minimumConfidence: 0.5
      };
      const strategy = createPolicyStrategy(hints);
      const signals = signalMap(
        signal('a', 'Evaluation', { recommendation: 'APPROVE', confidence: 0.9 }),
        signal('b', 'Evaluation', { recommendation: 'APPROVE', confidence: 0.7 }),
        signal('c', 'Evaluation', { recommendation: 'APPROVE', confidence: 0.8 })
      );
      const decision = strategy.decide(signals, {});
      expect(decision.action).toBe('approve');
    });

    it('treats evaluations without confidence as confidence 1.0 (qualified)', () => {
      const hints: PolicyHints = {
        type: 'majority',
        threshold: 0.5,
        minimumConfidence: 0.6
      };
      const strategy = createPolicyStrategy(hints);
      const signals = signalMap(
        signal('a', 'Evaluation', { recommendation: 'APPROVE' }),
        signal('b', 'Evaluation', { recommendation: 'APPROVE' })
      );
      const decision = strategy.decide(signals, {});
      // No confidence set = defaults to 1.0, passes threshold
      expect(decision.action).toBe('approve');
    });

    it('defaults minimumConfidence to 0.0 (all evaluations qualify)', () => {
      const strategy = createPolicyStrategy({ type: 'majority', threshold: 0.5 });
      const signals = signalMap(
        signal('a', 'Evaluation', { recommendation: 'APPROVE', confidence: 0.01 }),
        signal('b', 'Evaluation', { recommendation: 'APPROVE', confidence: 0.02 })
      );
      const decision = strategy.decide(signals, {});
      expect(decision.action).toBe('approve');
    });

    it('disqualified low-confidence rejections do not count as rejections', () => {
      const hints: PolicyHints = {
        type: 'majority',
        threshold: 0.5,
        minimumConfidence: 0.7
      };
      const strategy = createPolicyStrategy(hints);
      const signals = signalMap(
        signal('a', 'Evaluation', { recommendation: 'APPROVE', confidence: 0.9 }),
        signal('b', 'Evaluation', { recommendation: 'BLOCK', confidence: 0.3 }),
        signal('c', 'Evaluation', { recommendation: 'APPROVE', confidence: 0.8 })
      );
      const decision = strategy.decide(signals, {});
      // b's BLOCK is below confidence threshold — not counted
      // 2 approvals out of 3 total signals = 67% >= 50% threshold
      expect(decision.action).toBe('approve');
    });
  });

  describe('RFC-MACP-0012: designatedRoles', () => {
    // `designated_roles`/`commitment.authority` are enforced authoritatively
    // by macp-runtime's evaluator (see policies/policy.lending.conservative.json
    // + macp-runtime's check_commitment_authority). This local coordinator is
    // an advisory mirror only — it never reads PolicyHints.designatedRoles —
    // so the correct test isn't "it doesn't error when passed", it's "it has
    // zero effect on the outcome". If a future change starts consuming this
    // field, this test should start failing and get rewritten to prove the
    // new behavior instead of silently continuing to pass.
    it('has no effect on the decision — the field is informational only, not enforced locally', () => {
      const signals = signalMap(
        signal('a', 'Evaluation', { recommendation: 'APPROVE' }),
        signal('b', 'Evaluation', { recommendation: 'APPROVE' })
      );

      const withoutDesignatedRoles = createPolicyStrategy({ type: 'majority', threshold: 0.5 }).decide(signals, {});
      const withDesignatedRoles = createPolicyStrategy({
        type: 'majority',
        threshold: 0.5,
        designatedRoles: ['risk-agent', 'compliance-agent']
      }).decide(signals, {});

      expect(withDesignatedRoles).toEqual(withoutDesignatedRoles);
    });
  });

  describe('ABSTAIN exclusion from voting denominator', () => {
    it('excludes ABSTAIN votes from approval rate calculation', () => {
      const hints: PolicyHints = { type: 'majority', threshold: 0.5 };
      const strategy = createPolicyStrategy(hints);
      const signals = signalMap(
        signal('a', 'Evaluation', { recommendation: 'APPROVE', confidence: 0.9 }),
        signal('b', 'Evaluation', { recommendation: 'ABSTAIN', confidence: 0.8 }),
        signal('c', 'Evaluation', { recommendation: 'REVIEW', confidence: 0.7 })
      );
      const decision = strategy.decide(signals, {});
      // 1 approve, 1 abstain (excluded), 1 review out of effectiveTotal=2
      // approvalRate = 1/2 = 50% >= 50% threshold
      expect(decision.action).toBe('approve');
    });

    it('handles all ABSTAIN votes gracefully', () => {
      const hints: PolicyHints = { type: 'majority', threshold: 0.5 };
      const strategy = createPolicyStrategy(hints);
      const signals = signalMap(
        signal('a', 'Evaluation', { recommendation: 'ABSTAIN' }),
        signal('b', 'Evaluation', { recommendation: 'ABSTAIN' })
      );
      const decision = strategy.decide(signals, {});
      // effectiveTotal = 0, approvalRate = 0
      expect(decision.action).toBe('step_up');
    });
  });

  describe('criticalSeverityVetoes alias', () => {
    it('accepts criticalSeverityVetoes as alias for vetoEnabled', () => {
      const hints: PolicyHints = { type: 'majority', threshold: 0.5, criticalSeverityVetoes: true };
      const strategy = createPolicyStrategy(hints);
      const signals = signalMap(
        signal('a', 'Objection', { severity: 'critical', reason: 'critical issue' }),
        signal('b', 'Evaluation', { recommendation: 'APPROVE' }),
        signal('c', 'Evaluation', { recommendation: 'APPROVE' })
      );
      const decision = strategy.decide(signals, {});
      expect(decision.action).toBe('decline');
      expect(decision.reason).toContain('veto threshold');
    });

    it('vetoEnabled takes precedence over criticalSeverityVetoes', () => {
      const hints: PolicyHints = { type: 'majority', threshold: 0.5, vetoEnabled: false, criticalSeverityVetoes: true };
      const strategy = createPolicyStrategy(hints);
      const signals = signalMap(
        signal('a', 'Objection', { severity: 'critical', reason: 'critical issue' }),
        signal('b', 'Evaluation', { recommendation: 'APPROVE' }),
        signal('c', 'Evaluation', { recommendation: 'APPROVE' })
      );
      const decision = strategy.decide(signals, {});
      // vetoEnabled=false takes precedence
      expect(decision.policyApplied).toBe('majority');
    });
  });

  describe('edge cases', () => {
    it('handles empty signals map (0 approvals → step_up)', () => {
      const strategy = createPolicyStrategy({ type: 'majority', threshold: 0.5 });
      const decision = strategy.decide(new Map(), {});
      expect(decision.action).toBe('step_up');
      expect(decision.policyApplied).toBe('majority');
    });

    it('handles single signal', () => {
      const strategy = createPolicyStrategy({ type: 'majority', threshold: 0.5 });
      const signals = signalMap(signal('a', 'Evaluation', { recommendation: 'APPROVE' }));
      const decision = strategy.decide(signals, {});
      expect(decision.action).toBe('approve');
    });

    it('combined vetoThreshold and minimumConfidence', () => {
      const hints: PolicyHints = {
        type: 'majority',
        threshold: 0.5,
        vetoEnabled: true,
        vetoThreshold: 2,
        minimumConfidence: 0.6
      };
      const strategy = createPolicyStrategy(hints);
      const signals = signalMap(
        signal('a', 'Objection', { severity: 'critical', reason: 'concern' }),
        signal('b', 'Evaluation', { recommendation: 'APPROVE', confidence: 0.9 }),
        signal('c', 'Evaluation', { recommendation: 'APPROVE', confidence: 0.4 }),
        signal('d', 'Evaluation', { recommendation: 'APPROVE', confidence: 0.8 })
      );
      const decision = strategy.decide(signals, {});
      // 1 critical objection < vetoThreshold(2), so no veto
      // c is below minimumConfidence, so only b and d qualify as approvals
      // 2 qualified approvals out of 4 total = 50% >= 50% threshold
      expect(decision.action).toBe('approve');
    });
  });

  describe('fail-closed on an empty tally (RFC-MACP-0012 §4.1, mirrors macp-runtime schema_version >= 3)', () => {
    // A zero-participant/zero-signal tally must never resolve to 'approve' —
    // that would be exactly the fail-open shape schema_version 3 exists to
    // close off in the runtime evaluator. 'none' is the one algorithm the
    // runtime's own evaluator explicitly exempts from the empty-tally check
    // (it has no ballot to be empty), so it's excluded from this table.
    it.each(['majority', 'supermajority', 'unanimous'] as const)(
      'type=%s: decide() never returns approve on a completely empty signals map',
      (type) => {
        const strategy = createPolicyStrategy({ type, threshold: 0.67 });
        const decision = strategy.decide(new Map(), {});
        expect(decision.action).not.toBe('approve');
      }
    );

    it('unanimous with zero signals steps up rather than vacuously approving (0 === 0)', () => {
      // Regression test: `approvals === total` with total=0 previously read
      // as "all zero participants approved" and returned action: 'approve'.
      const strategy = createPolicyStrategy({ type: 'unanimous' });
      const decision = strategy.decide(new Map(), {});
      expect(decision.action).toBe('step_up');
      expect(decision.reason).toContain('no signals received');
    });

    it("none policy: zero signals is a legitimate pass-through approve (matches the runtime evaluator's exemption for algorithm=none)", () => {
      const strategy = createPolicyStrategy({ type: 'none' });
      const decision = strategy.decide(new Map(), {});
      expect(decision.action).toBe('approve');
    });
  });
});
