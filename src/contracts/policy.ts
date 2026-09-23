export interface PolicyDefinition {
  policy_id: string;
  mode: string;
  schema_version: number;
  description: string;
  rules: {
    voting: {
      algorithm: 'none' | 'majority' | 'supermajority' | 'unanimous' | 'weighted';
      threshold?: number;
      quorum?: { type: 'count' | 'percentage'; value: number };
      weights?: Record<string, number>;
    };
    objection_handling: {
      critical_severity_vetoes: boolean;
      veto_threshold: number;
    };
    evaluation: {
      minimum_confidence: number;
      required_before_voting: boolean;
    };
    commitment: {
      authority: 'initiator_only' | 'designated_role' | 'any_participant';
      require_vote_quorum: boolean;
      designated_roles: string[];
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
