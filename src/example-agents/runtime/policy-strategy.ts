type JsonRecord = Record<string, unknown>;

export interface PolicyHints {
  type?: string;
  description?: string;
  threshold?: number;
  vetoEnabled?: boolean;
  criticalSeverityVetoes?: boolean;
  vetoRoles?: string[];
  vetoThreshold?: number;
  minimumConfidence?: number;
  designatedRoles?: string[];
}

export interface SpecialistSignal {
  participantId: string;
  messageType: 'Evaluation' | 'Objection';
  recommendation?: string;
  confidence?: number;
  severity?: string;
  reason?: string;
}

export interface PolicyDecision {
  action: 'approve' | 'step_up' | 'decline';
  vote: 'approve' | 'reject';
  reason: string;
  policyApplied: string;
}

export interface PolicyStrategy {
  isQuorumMet(signals: Map<string, SpecialistSignal>, totalExpected: number): boolean;
  decide(signals: Map<string, SpecialistSignal>, sessionContext: JsonRecord): PolicyDecision;
}

export function createPolicyStrategy(policyHints: PolicyHints | undefined): PolicyStrategy {
  const type = policyHints?.type ?? 'none';
  const threshold = policyHints?.threshold ?? 0.5;
  const vetoEnabled = policyHints?.vetoEnabled ?? policyHints?.criticalSeverityVetoes ?? false;
  const vetoThreshold = policyHints?.vetoThreshold ?? 1;
  const minimumConfidence = policyHints?.minimumConfidence ?? 0.0;

  return {
    isQuorumMet(signals, totalExpected) {
      if (type === 'unanimous') return signals.size >= totalExpected;
      if (type === 'none') return signals.size >= totalExpected;
      return signals.size >= Math.max(1, Math.ceil(totalExpected * threshold));
    },

    decide(signals, _sessionContext) {
      const all = [...signals.values()];

      // 1. Check for veto-blocking objections — critical severity only (RFC-MACP-0004)
      if (vetoEnabled) {
        const blocking = all.filter((s) => s.messageType === 'Objection' && s.severity === 'critical');
        if (blocking.length >= vetoThreshold) {
          return {
            action: 'decline',
            vote: 'reject',
            reason: `policy ${type}: ${blocking.length} critical objection(s) met veto threshold of ${vetoThreshold}`,
            policyApplied: type
          };
        }
      }

      // 2. Filter evaluations by minimum_confidence (RFC-MACP-0012)
      const qualifiedEvaluations = all.filter(
        (s) => s.messageType === 'Evaluation' && (s.confidence ?? 1.0) >= minimumConfidence
      );
      const disqualifiedCount = all.filter(
        (s) => s.messageType === 'Evaluation' && (s.confidence ?? 1.0) < minimumConfidence
      ).length;

      const approvals = qualifiedEvaluations.filter((s) => (s.recommendation ?? '').toUpperCase() === 'APPROVE').length;
      const rejections = qualifiedEvaluations.filter((s) =>
        ['BLOCK', 'REJECT'].includes((s.recommendation ?? '').toUpperCase())
      ).length;
      const objections = all.filter((s) => s.messageType === 'Objection').length;
      const total = signals.size;

      // Exclude ABSTAIN votes from voting ratio denominator
      const abstainCount = qualifiedEvaluations.filter(
        (s) => (s.recommendation ?? '').toUpperCase() === 'ABSTAIN'
      ).length;
      const effectiveTotal = total - abstainCount;

      // 3. Apply voting algorithm
      if (type === 'unanimous') {
        if (rejections > 0 || objections > 0) {
          return {
            action: 'decline',
            vote: 'reject',
            reason: `policy unanimous: ${rejections} rejection(s), ${objections} objection(s)`,
            policyApplied: 'unanimous'
          };
        }
        if (disqualifiedCount > 0) {
          return {
            action: 'step_up',
            vote: 'approve',
            reason: `policy unanimous: ${disqualifiedCount} evaluation(s) below minimum confidence ${minimumConfidence}`,
            policyApplied: 'unanimous'
          };
        }
        if (total > 0 && approvals === total) {
          return {
            action: 'approve',
            vote: 'approve',
            reason: 'policy unanimous: all participants approved',
            policyApplied: 'unanimous'
          };
        }
        if (total === 0) {
          // Fail closed on an empty tally rather than treating "no signals"
          // as vacuously unanimous (RFC-MACP-0012 §4.1 empty-tally rule,
          // mirrored from macp-runtime's schema_version >= 3 evaluator arm).
          return {
            action: 'step_up',
            vote: 'approve',
            reason: 'policy unanimous: no signals received, cannot confirm unanimity',
            policyApplied: 'unanimous'
          };
        }
        return {
          action: 'step_up',
          vote: 'approve',
          reason: 'policy unanimous: mixed signals, stepping up',
          policyApplied: 'unanimous'
        };
      }

      const approvalRate = effectiveTotal > 0 ? approvals / effectiveTotal : 0;

      if (type === 'supermajority' || type === 'majority') {
        if (approvalRate >= threshold) {
          return {
            action: 'approve',
            vote: 'approve',
            reason: `policy ${type}: ${(approvalRate * 100).toFixed(0)}% approval meets ${(threshold * 100).toFixed(0)}% threshold`,
            policyApplied: type
          };
        }
        if (rejections + objections > approvals) {
          return {
            action: 'decline',
            vote: 'reject',
            reason: `policy ${type}: majority rejected or objected`,
            policyApplied: type
          };
        }
        return {
          action: 'step_up',
          vote: 'approve',
          reason: `policy ${type}: approval below ${(threshold * 100).toFixed(0)}% threshold, stepping up`,
          policyApplied: type
        };
      }

      // 'none' — simple pass-through: any blocking signal triggers decline
      if (rejections > 0 || objections > 0) {
        return {
          action: 'decline',
          vote: 'reject',
          reason: 'default policy: blocking signals observed',
          policyApplied: 'none'
        };
      }
      return {
        action: 'approve',
        vote: 'approve',
        reason: 'default policy: no blocking signals',
        policyApplied: 'none'
      };
    }
  };
}
