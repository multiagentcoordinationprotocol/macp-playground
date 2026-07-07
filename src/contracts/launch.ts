import { HostedExampleAgent, ParticipantAgentBinding, ExampleAgentSummary } from './example-agents';
import { CommitmentDefinition, PayloadEnvelopeTemplate, RuntimeSelectionTemplate } from './registry';
import { RunDescriptor } from './run-descriptor';

export type { CommitmentDefinition };
export type { RunDescriptor };
/** Alias retained for callers that imported `PayloadEnvelope`. Structurally identical to `PayloadEnvelopeTemplate`. */
export type PayloadEnvelope = PayloadEnvelopeTemplate;

export interface LaunchSchemaResponse {
  scenarioRef: string;
  templateId?: string;
  formSchema: Record<string, unknown>;
  defaults: Record<string, unknown>;
  participants: Array<{
    id: string;
    role: string;
    agentRef: string;
  }>;
  agents: ExampleAgentSummary[];
  runtime: RuntimeSelectionTemplate;
  launchSummary: {
    modeName: string;
    modeVersion: string;
    configurationVersion: string;
    policyVersion?: string;
    policyHints?: {
      type?: string;
      description?: string;
      threshold?: number;
      vetoEnabled?: boolean;
      criticalSeverityVetoes?: boolean;
      vetoRoles?: string[];
      vetoThreshold?: number;
      minimumConfidence?: number;
      designatedRoles?: string[];
    };
    ttlMs: number;
    initiatorParticipantId?: string;
  };
  expectedDecisionKinds?: string[];
}

export interface CompileLaunchRequest {
  scenarioRef: string;
  templateId?: string;
  inputs: Record<string, unknown>;
  mode?: 'live' | 'sandbox';
}

/**
 * Initiator-only compile output: the payload the initiator agent needs to
 * emit the first SessionStart envelope and the first mode-specific envelope
 * (e.g. Proposal). Non-initiator agents do not receive this.
 */
export interface InitiatorPayload {
  participantId: string;
  sessionStart: {
    intent: string;
    participants: string[];
    ttlMs: number;
    /** Session-bound suspend cap (ms) — proto 0.1.5 `max_suspend_ms`. */
    maxSuspendMs?: number;
    modeVersion: string;
    configurationVersion: string;
    policyVersion?: string;
    contextId?: string;
    extensions?: Record<string, unknown>;
    roots?: Array<{ uri: string; name?: string }>;
  };
  kickoff?: {
    messageType: string;
    /** Proto typeName the agent should encode the payload with. */
    payloadType?: string;
    payload: Record<string, unknown>;
  };
}

/**
 * Examples-service internal scenario metadata. Not part of the CP-1 wire
 * contract — fields here are consumed by the hosting flow when threading
 * policy + context into each agent's bootstrap.
 */
export interface ScenarioMeta {
  policyHints?: {
    type?: string;
    description?: string;
    threshold?: number;
    vetoEnabled?: boolean;
    criticalSeverityVetoes?: boolean;
    vetoRoles?: string[];
    vetoThreshold?: number;
    minimumConfidence?: number;
    designatedRoles?: string[];
  };
  sessionContext?: Record<string, unknown>;
  initiatorParticipantId?: string;
}

export interface CompileLaunchResult {
  /** Scenario-agnostic descriptor — the sole wire contract. */
  runDescriptor: RunDescriptor;
  /** Present iff the scenario has a kickoff and an identifiable initiator. */
  initiator?: InitiatorPayload;
  /** Shared session id pre-allocated at compile time (UUID v4). */
  sessionId: string;
  /** Execution mode chosen at request time — not part of the runtime contract. */
  mode: 'live' | 'sandbox';
  /** Examples-service internal scenario metadata consumed by hosting. */
  scenarioMeta: ScenarioMeta;
  display: {
    title: string;
    scenarioRef: string;
    templateId?: string;
    expectedDecisionKinds?: string[];
  };
  participantBindings: ParticipantAgentBinding[];
}

export interface RunExampleRequest extends CompileLaunchRequest {
  bootstrapAgents?: boolean;
  tags?: string[];
  requester?: { actorId?: string; actorType?: 'user' | 'service' | 'system' };
  runLabel?: string;
}

export interface RunExampleResult {
  compiled: CompileLaunchResult;
  hostedAgents: HostedExampleAgent[];
  sessionId?: string;
}
