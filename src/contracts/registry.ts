export type KickoffKind = 'request' | 'broadcast' | 'proposal' | 'context';
export type PayloadEncoding = 'json' | 'text' | 'base64' | 'proto';

export interface PackFile {
  apiVersion: 'scenarios.macp.dev/v1';
  kind: 'ScenarioPack';
  metadata: {
    slug: string;
    name: string;
    description?: string;
    tags?: string[];
  };
}

export interface PackSummary {
  slug: string;
  name: string;
  description?: string;
  tags?: string[];
}

export interface ParticipantTemplate {
  id: string;
  role: string;
  agentRef: string;
  displayName?: string;
  description?: string;
  transportIdentity?: string;
  metadata?: Record<string, unknown>;
}

export interface ProtoPayloadTemplate {
  typeName: string;
  value: Record<string, unknown>;
}

export interface PayloadEnvelopeTemplate {
  encoding: PayloadEncoding;
  mediaType?: string;
  json?: Record<string, unknown>;
  text?: string;
  base64?: string;
  proto?: ProtoPayloadTemplate;
}

export interface KickoffTemplate {
  from: string;
  to: string[];
  kind: KickoffKind;
  messageType?: string;
  payload?: Record<string, unknown>;
  payloadEnvelope?: PayloadEnvelopeTemplate;
  metadata?: Record<string, unknown>;
}

export interface RuntimeSelectionTemplate {
  kind: string;
  version?: string;
}

export interface CommitmentDefinition {
  id: string;
  title: string;
  description?: string;
  requiredRoles?: string[];
  policyRef?: string;
}

export interface ScenarioVersionFile {
  apiVersion: 'scenarios.macp.dev/v1';
  kind: 'ScenarioVersion';
  metadata: {
    pack: string;
    scenario: string;
    version: string;
    name: string;
    summary?: string;
    tags?: string[];
    deprecated?: boolean;
  };
  spec: {
    runtime?: RuntimeSelectionTemplate;
    inputs: {
      schema: Record<string, unknown>;
    };
    launch: {
      modeName: string;
      modeVersion: string;
      configurationVersion: string;
      policyVersion?: string;
      policyHints?: {
        type?: string;
        description?: string;
        threshold?: number;
        vetoEnabled?: boolean;
        vetoRoles?: string[];
        vetoThreshold?: number;
        minimumConfidence?: number;
        designatedRoles?: string[];
      };
      ttlMs: number;
      /**
       * Optional session-bound suspend cap (ms) — proto 0.1.5
       * `SessionStartPayload.max_suspend_ms`. 0/absent → runtime default (7 days).
       */
      maxSuspendMs?: number;
      initiatorParticipantId?: string;
      participants: ParticipantTemplate[];
      commitments?: CommitmentDefinition[];
      contextTemplate?: Record<string, unknown>;
      contextId?: string;
      extensions?: Record<string, unknown>;
      kickoffTemplate?: KickoffTemplate[];
      metadataTemplate?: Record<string, unknown>;
    };
    execution?: {
      idempotencyKey?: string;
      tags?: string[];
      requester?: {
        actorId?: string;
        actorType?: 'user' | 'service' | 'system';
      };
    };
    outputs?: {
      expectedDecisionKinds?: string[];
      expectedSignals?: string[];
    };
  };
}

export interface ScenarioTemplateFile {
  apiVersion: 'scenarios.macp.dev/v1';
  kind: 'ScenarioTemplate';
  metadata: {
    scenarioVersion: string;
    slug: string;
    name: string;
  };
  spec: {
    defaults?: Record<string, unknown>;
    overrides?: {
      runtime?: Partial<RuntimeSelectionTemplate>;
      launch?: Partial<ScenarioVersionFile['spec']['launch']>;
      execution?: Partial<ScenarioVersionFile['spec']['execution']>;
    };
  };
}

export interface ScenarioSummary {
  scenario: string;
  name: string;
  summary?: string;
  versions: string[];
  templates: string[];
  tags?: string[];
  runtimeKind?: string;
  agentRefs?: string[];
  policyVersion?: string;
  policyHints?: {
    type?: string;
    description?: string;
    threshold?: number;
    vetoEnabled?: boolean;
    vetoRoles?: string[];
    vetoThreshold?: number;
    minimumConfidence?: number;
    designatedRoles?: string[];
  };
}

export interface PackEntry {
  pack: PackFile;
  scenarios: Map<string, ScenarioEntry>;
}

export interface ScenarioEntry {
  versions: Map<string, ScenarioVersionEntry>;
}

export interface ScenarioVersionEntry {
  scenario: ScenarioVersionFile;
  templates: Map<string, ScenarioTemplateFile>;
}

export interface RegistrySnapshot {
  packs: Map<string, PackEntry>;
  loadedAt: number;
}
