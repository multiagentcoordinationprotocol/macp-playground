/**
 * Scenario-agnostic run descriptor — matches the `RunDescriptorDto` contract
 * accepted by the control-plane's `POST /runs` and `POST /runs/validate`
 * (control-plane commit 2026-04-15, plan CP-1). The control-plane rejects
 * unknown keys via `forbidNonWhitelisted: true`, so this shape MUST stay in
 * lockstep with `macp-control-plane/src/dto/execution-request.dto.ts`.
 *
 * See `macp-ui-console/plans/direct-agent-auth.md` § "Generic contracts".
 */
export interface RunDescriptor {
  mode: 'live' | 'sandbox';
  runtime: {
    kind: string;
    version?: string;
  };
  session: {
    /**
     * Caller-allocated session id. Must satisfy the runtime validator (UUID
     * v4/v7 or base64url 22+ chars). If omitted, the control-plane allocates
     * a UUID v4 and echoes it back in `RunDescriptorResponse.sessionId`.
     */
    sessionId?: string;
    modeName: string;
    modeVersion: string;
    configurationVersion: string;
    /** Opaque to the control-plane; forwarded to the runtime on SessionStart. */
    policyVersion?: string;
    ttlMs: number;
    /**
     * Bare sender strings wrapped in `{id}` objects — for audit/projection only.
     * Control-plane does NOT derive identity from this list; runtime enforces
     * identity via `MACP_AUTH_TOKENS_JSON` entries.
     */
    participants: Array<{ id: string }>;
    /**
     * Opaque metadata. Reserved keys: `source`, `sourceRef`, `environment`,
     * `scenarioRef`, `cancelCallback`, `cancellationDelegated`.
     */
    metadata?: Record<string, unknown>;
  };
  execution?: {
    idempotencyKey?: string;
    tags?: string[];
    requester?: { actorId?: string; actorType?: 'user' | 'service' | 'system' };
  };
}

export interface RunDescriptorResponse {
  runId: string;
  sessionId: string;
  traceId?: string;
  status: 'queued' | 'binding_session' | 'running' | 'completed' | 'failed' | string;
}
