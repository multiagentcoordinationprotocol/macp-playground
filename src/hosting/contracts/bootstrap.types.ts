/**
 * Flat bootstrap payload written by the macp-playground service for each spawned agent.
 *
 * This format matches what both `macp_sdk` (Python) and `macp-sdk-typescript`
 * expect in their `fromBootstrap()` functions. The macp-playground service is the
 * single source of truth for this file — agents read it directly via the
 * `MACP_BOOTSTRAP_FILE` environment variable.
 */
export interface BootstrapPayload {
  /** Agent's unique sender identity within the session. */
  participant_id: string;
  /** Pre-allocated session UUID v4. Every agent in a run receives the same value. */
  session_id: string;
  /** Mode URI (e.g. `macp.mode.decision.v1`). */
  mode: string;
  /** gRPC address of the MACP runtime (e.g. `runtime.local:50051`). */
  runtime_url: string;
  /** Bearer token for this agent's runtime identity. Always populated (JWT minted per spawn). */
  auth_token: string;
  /** Dev-only: agent identity header value (requires `MACP_ALLOW_DEV_SENDER_HEADER=1`). */
  agent_id?: string;
  /** Enable TLS for the runtime gRPC channel. Defaults to true in production. */
  secure?: boolean;
  /** Allow plaintext gRPC. Required when `secure` is false. */
  allow_insecure?: boolean;
  /** List of all participant IDs in the session. */
  participants?: string[];
  /** Mode semantic version. */
  mode_version?: string;
  /** Configuration schema version. */
  configuration_version?: string;
  /** Governance policy version. */
  policy_version?: string;

  /**
   * Present ONLY on the initiator agent's bootstrap. Contains the payload
   * the initiator uses to emit SessionStart + the first mode-specific
   * envelope (e.g. Proposal). Non-initiators have `initiator` absent.
   */
  initiator?: {
    session_start: {
      intent: string;
      participants: string[];
      ttl_ms: number;
      mode_version: string;
      configuration_version: string;
      policy_version?: string;
      context?: Record<string, unknown>;
      context_id?: string;
      extensions?: Record<string, unknown>;
      roots?: Array<{ uri: string; name?: string }>;
    };
    kickoff?: {
      message_type: string;
      payload_type?: string;
      payload: Record<string, unknown>;
    };
  };

  /**
   * Cancel callback endpoint (RFC-0001 §7.2 Option A).
   * The agent listens on `http://host:port{path}` for `{ runId, reason }` POST.
   */
  cancel_callback?: {
    host: string;
    port: number;
    path: string;
  };

  /** Metadata not consumed by the SDK but available to agent logic. */
  metadata?: {
    run_id?: string;
    trace_id?: string;
    scenario_ref?: string;
    role?: string;
    framework?: string;
    agent_ref?: string;
    policy_hints?: Record<string, unknown>;
    session_context?: Record<string, unknown>;
  };
}

export interface BootstrapDelivery {
  filePath: string;
  env: Record<string, string>;
}
