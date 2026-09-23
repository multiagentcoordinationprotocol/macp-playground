/**
 * Pure cancel-callback allocation (RFC-0001 §7.2 Option A). Extracted out of
 * `ProcessExampleAgentHostProvider` so the (host, port, path) computed for
 * each spawned agent's bootstrap payload is unit-testable in isolation.
 *
 * This is NOT currently wired into the CP-1 `RunDescriptor` submission — see
 * `docs/direct-agent-auth.md`'s "Known gap: control-plane-initiated cancel is
 * not wired" section. The receiving HTTP server this tuple describes
 * (`cancel-callback-server.ts`) was deleted in commit `51396ab`, so nothing
 * actually binds the port this function computes; the value only flows into
 * each agent's own bootstrap payload today.
 */
export interface CancelCallbackConfig {
  host: string;
  portBase: number;
  path: string;
}

export interface CancelCallbackTuple {
  host: string;
  port: number;
  path: string;
}

export function allocateCancelCallback(
  config: CancelCallbackConfig,
  participantId: string,
  runId: string
): CancelCallbackTuple | undefined {
  const host = config.host;
  if (!host) return undefined;
  if (!config.portBase || config.portBase <= 0) {
    // No port base configured; agents will listen on an ephemeral port and
    // POST the port back to the control-plane via a future registration
    // call. For now we just record host+path and let the agent bind :0.
    return { host, port: 0, path: config.path };
  }
  const port = nextCancelCallbackPort(config.portBase, runId, participantId);
  return { host, port, path: config.path };
}

function nextCancelCallbackPort(base: number, runId: string, participantId: string): number {
  // Deterministic offset so the same (runId, participantId) always lands on
  // the same port within a process — avoids collisions when launching the
  // same scenario repeatedly against a single host.
  let hash = 0;
  const material = `${runId}:${participantId}`;
  for (let i = 0; i < material.length; i += 1) {
    hash = (hash * 31 + material.charCodeAt(i)) | 0;
  }
  const offset = Math.abs(hash) % 1024;
  return base + offset;
}
