export interface PolicyDefinition {
  policy_id: string;
  mode: string;
  schema_version: number;
  description: string;
  rules: {
    voting: {
      algorithm: 'none' | 'majority' | 'supermajority' | 'unanimous' | 'weighted' | 'plurality';
      threshold?: number;
      quorum?: { type: 'count' | 'percentage'; value: number };
      weights?: Record<string, number>;
    };
    objection_handling: {
      critical_severity_vetoes: boolean;
      /**
       * Optional upstream (schemas/policy/decision-rules.schema.json): defaults to 1,
       * only read when critical_severity_vetoes is true. Omit rather than set to 0 when
       * vetoes are off — see #81 / policy-rule-schema-validation.md.
       */
      veto_threshold?: number;
      critical_objection_action?: 'deny' | 'finalize_decline' | 'hold';
    };
    evaluation: {
      minimum_confidence: number;
      required_before_voting: boolean;
    };
    commitment: {
      authority: 'initiator_only' | 'designated_role' | 'any_participant';
      require_vote_quorum: boolean;
      designated_roles: string[];
      allow_decline_over_approval?: boolean;
    };
  };
}

export interface PolicyDescriptor extends PolicyDefinition {
  registeredAtUnixMs?: number;
}

export interface PolicyProjection {
  policyVersion: string;
  policyDescription?: string;
  resolvedAt?: string;
  outcomePositive?: boolean;
  commitmentEvaluations: Array<{
    commitmentId: string;
    decision: 'allow' | 'deny';
    reasons: string[];
    ts: string;
  }>;
}

export interface RunStateProjection {
  runId: string;
  status: string;
  policy?: PolicyProjection;
  [key: string]: unknown;
}

export interface ControlPlaneErrorResponse {
  statusCode: number;
  error: string;
  message: string;
  reasons?: string[];
}
