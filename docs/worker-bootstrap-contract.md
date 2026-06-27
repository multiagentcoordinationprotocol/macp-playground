# Worker Bootstrap Contract

## Overview

Every MACP worker process receives a **bootstrap payload** — a JSON file
containing everything needed to start participating in a run. The shape is
flat and framework-agnostic; both `macp_sdk` (Python) and
`macp-sdk-typescript` consume it verbatim via their `fromBootstrap()` /
`from_bootstrap()` entry points.

> **The bootstrap shape is canonically owned by the SDKs**, not by this
> service. For the authoritative field-by-field reference and the behaviour
> of each field, see:
>
> - [TypeScript SDK — Agent Framework → fromBootstrap()](https://github.com/multiagentcoordinationprotocol/macp-sdk-typescript/blob/main/docs/guides/agent-framework.md#frombootstrap)
> - [Python SDK — Agent Framework](https://github.com/multiagentcoordinationprotocol/macp-sdk-python/blob/main/docs/guides/agent-framework.md)
>
> This doc only captures how the macp-playground **produces** the
> bootstrap (delivery, per-agent metadata, ambient-signal scope) and the
> additional fields the service threads through `metadata` for its own
> agents.

As of April 2026 the contract carries direct-agent-auth fields — a per-agent
Bearer token, the runtime gRPC address, an initiator payload, and an optional
cancel-callback tuple. See [`docs/direct-agent-auth.md`](direct-agent-auth.md)
for the end-to-end flow.

## Delivery mechanism

- **File path**: `MACP_BOOTSTRAP_FILE` environment variable points to a temp
  JSON file written by `LaunchSupervisor.writeBootstrapFile()` before the
  worker process is spawned.
- **Convenience env vars**: `MACP_FRAMEWORK`, `MACP_PARTICIPANT_ID`,
  `MACP_RUN_ID`, `MACP_SESSION_ID`, `MACP_RUNTIME_ADDRESS`,
  `MACP_RUNTIME_TOKEN`, `MACP_RUNTIME_TLS`, `MACP_RUNTIME_ALLOW_INSECURE`,
  `MACP_CANCEL_CALLBACK_HOST` / `_PORT` / `_PATH`, `MACP_LOG_LEVEL`. These are
  populated by `buildAgentEnv()` in
  `src/hosting/adapters/agent-env.ts` and are intended as a convenience —
  the JSON file is authoritative.

## Bootstrap payload — macp-playground view

The canonical TypeScript definition lives at
`src/hosting/contracts/bootstrap.types.ts`. The shape uses `snake_case` keys
so it matches the upstream SDKs' `fromBootstrap` expectations:

```typescript
interface BootstrapPayload {
  participant_id: string;           // Agent's sender identity in this session
  session_id: string;               // UUID v4, allocated at compile time
  mode: string;                     // e.g. "macp.mode.decision.v1"
  runtime_url: string;              // gRPC endpoint (e.g. "runtime.local:50051")
  auth_token?: string;              // Per-agent Bearer token (RFC-MACP-0004 §4)
  agent_id?: string;                // Dev-only identity header value
  secure?: boolean;                 // TLS flag (RFC-MACP-0006 §3)
  allow_insecure?: boolean;         // Required when secure=false
  participants?: string[];
  mode_version?: string;
  configuration_version?: string;
  policy_version?: string;
  initiator?: { session_start: { ... }; kickoff?: { ... } };
  cancel_callback?: { host: string; port: number; path: string };
  metadata?: { /* macp-playground-specific — see below */ };
}
```

Refer to the SDK `fromBootstrap` doc linked above for the meaning and
validation of every field the SDK consumes. The macp-playground writes
these fields verbatim; it does not own their semantics.

### `metadata.*` — macp-playground additions

These fields are **not** consumed by the SDK. They are pass-through context
for agent logic and the in-tree `PolicyStrategy`:

| Field | Purpose |
|-------|---------|
| `run_id` / `trace_id` | Correlation for logs and observer projections |
| `scenario_ref` | `pack/scenario@version` the run was compiled from |
| `role` / `agent_ref` / `framework` | Catalog identity of the spawned agent |
| `policy_hints` | Denormalized policy fields (see table below) |
| `session_context` | Scenario-specific inputs (e.g. `transactionAmount`) |

`metadata.policy_hints` carries the RFC-MACP-0012 fields consumed by
`PolicyStrategy`:

| Field                 | Default | Description                                                         |
|-----------------------|---------|---------------------------------------------------------------------|
| `type`                | `none`  | `majority`, `supermajority`, `unanimous`, `none`                    |
| `threshold`           | —       | Approval rate (0–1) required to pass                                |
| `vetoEnabled`         | `false` | Whether critical-severity objections veto                           |
| `vetoThreshold`       | `1`     | Number of critical objections required for veto                     |
| `minimumConfidence`   | `0.0`   | Minimum confidence for an evaluation to count                       |
| `designatedRoles`     | `[]`    | Roles allowed to author the terminal commitment                     |

See [`docs/policy-authoring.md`](policy-authoring.md) for how these hints
map from the canonical policy descriptor.

## Worker lifecycle (direct-agent-auth)

The canonical lifecycle (authenticate → branch on initiator → react →
emit → cancel → exit) is documented in the SDK agent-framework guide. In
the macp-playground it plays out as:

1. **Bootstrap** — worker reads `MACP_BOOTSTRAP_FILE`.
2. **Authenticate** — SDK constructs the gRPC client from `runtime_url` +
   `auth_token`.
3. **Initiator vs non-initiator** — the SDK branches based on whether
   `initiator` is present in the payload.
4. **React** — handlers receive `Proposal`, `Evaluation`, `Objection`,
   `Vote`, `Commitment`, etc.
5. **Emit** — `ctx.actions.evaluate() / .vote() / .commit() / .objection()`.
6. **Cancel callback** — the SDK auto-binds an HTTP listener from
   `bootstrap.cancel_callback` during `fromBootstrap()` / `from_bootstrap()`.
7. **Exit** — terminal status closes the stream; `onTerminal` fires.

## Ambient envelopes (Signal / Progress)

Agents may emit envelopes that are not tied to a specific mode — e.g. the
`session.context` **Signal** emitted by `risk-decider.worker.ts` once it
observes the first `Proposal`. Ambient envelopes have `mode = ""` and
`session_id = ""` (correlation id travels in the payload). For the
runtime to accept these, the agent's JWT must include `""` in its
`allowed_modes` scope — the macp-playground does this automatically in
`deriveScopes()` (`src/hosting/process-example-agent-host.provider.ts`).
Dropping the empty string triggers `FORBIDDEN` at the runtime boundary.

For the runtime-side `Signal` semantics (no session binding, not
persisted, delivered via `WatchSignals`), see
[`macp-runtime/docs/API.md` § WatchSignals](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/API.md#watchsignals).

## SDK usage patterns

Minimal handler wiring in each SDK — full API is in the SDK docs:

**Python** — see
[`macp-sdk-python/docs/guides/agent-framework.md`](https://github.com/multiagentcoordinationprotocol/macp-sdk-python/blob/main/docs/guides/agent-framework.md):

```python
from macp_sdk.agent import from_bootstrap

participant = from_bootstrap()  # reads MACP_BOOTSTRAP_FILE automatically

def handle_proposal(message, ctx):
    ctx.actions.evaluate(
        message.proposal_id or "",
        "APPROVE", confidence=0.85, reason="looks good",
    )
    participant.stop()

participant.on("Proposal", handle_proposal)
participant.run()
```

**Node** — see
[`macp-sdk-typescript/docs/guides/agent-framework.md`](https://github.com/multiagentcoordinationprotocol/macp-sdk-typescript/blob/main/docs/guides/agent-framework.md):

```typescript
import { agent } from 'macp-sdk-typescript';

const participant = agent.fromBootstrap();

participant.on('Proposal', async (message, ctx) => {
  await ctx.actions.evaluate?.({
    proposalId: message.proposalId ?? '',
    recommendation: 'APPROVE', confidence: 0.85, reason: 'acceptable risk',
  });
  await participant.stop();
});

await participant.run();
```

The in-tree coordinator at `src/example-agents/runtime/risk-decider.worker.ts`
follows the Node pattern; the only extra machinery it owns is the
`PolicyStrategy` (quorum + voting + veto). Framework workers live in
`agents/langgraph_worker/`, `agents/langchain_worker/`, and
`agents/crewai_worker/` — each uses the Python SDK with a
framework-specific handler body.
