# Direct-agent-auth in the macp-playground

Last updated: 2026-04-22 (AUTH-2 JWT-only, PolicyRegistrar, ambient signals).

This document describes how the **macp-playground** spawns agents under
RFC-MACP-0004 §4 ("sender MUST be derived from authenticated identity"):
how scenarios compile, how bootstrap files are written, and how the
service registers scenario policies with the runtime at startup.

> **Agent-side patterns — the initiator / non-initiator code, the
> `expected_sender` guardrail, and `session.cancel()` behaviour — are
> canonically documented in the SDK guides**, not here. See:
>
> - Python: [`macp-sdk-python/docs/guides/direct-agent-auth.md`](https://github.com/multiagentcoordinationprotocol/macp-sdk-python/blob/main/docs/guides/direct-agent-auth.md)
> - TypeScript: [`macp-sdk-typescript/docs/guides/authentication.md`](https://github.com/multiagentcoordinationprotocol/macp-sdk-typescript/blob/main/docs/guides/authentication.md)
>   and [`macp-sdk-typescript/docs/guides/agent-framework.md`](https://github.com/multiagentcoordinationprotocol/macp-sdk-typescript/blob/main/docs/guides/agent-framework.md)
>
> This doc covers only the **macp-playground side**: how the bootstrap
> is produced, how JWTs are minted, and how policies are registered.

See `CLAUDE.md` § "Direct-agent-auth" for a short summary.

## Why

Before this change, every spawned agent emitted envelopes by POSTing to the
control-plane's `/runs/:id/messages` route, and the control-plane forged
`SessionStart` on the agent's behalf. That violates **RFC-MACP-0004 §4** and
**RFC-MACP-0001 §5.3** ("no MACP bypass"). The change re-homes envelope
emission to agents themselves and narrows the control-plane to a read-only
observer.

## Architectural invariants

1. **Agents authenticate to the runtime directly** using a JWT minted per spawn.
2. **The initiator agent opens the session** via `DecisionSession.start()`.
3. **The control-plane is scenario-agnostic** — it does not inspect policy hints, kickoff templates, roles, or commitments.
4. **Control-plane never calls `Send`.** Observer-only.
5. **session_id is owned by the macp-playground** (UUID v4 allocated at compile time).
6. **Cancellation stays with the initiator** (RFC-MACP-0001 §7.2 Option A: agent-bound callback).
7. **Scenario policies are registered with the runtime at startup** by `PolicyRegistrarService`, using a separate admin JWT.

For the runtime-side enforcement of invariants 1–4 (authenticated sender
derivation, observer-identity passive-subscribe, `policy_version` lookup,
rate limits) see
[`macp-runtime/docs/getting-started.md` § Authentication](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/getting-started.md#authentication)
and
[`macp-runtime/docs/API.md`](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/API.md).

## Compile output (twin artifacts)

`CompilerService.compile()` produces:

```ts
interface CompileLaunchResult {
  sessionId: string;            // UUID v4 — shared by every agent + control-plane
  runDescriptor: RunDescriptor; // generic POST /runs body (no scenario-specific fields)
  initiator?: InitiatorPayload; // SessionStart + kickoff for exactly one participant
  executionRequest: ExecutionRequest; // legacy shape retained for bootstrap bookkeeping
  // ...existing fields
}
```

`runDescriptor.session` intentionally strips `policyHints`, `initiatorParticipantId`,
`participants[].role`, `commitments[]`, and `kickoff[]`; those live only on
`initiator` and in the per-agent bootstrap files.

## Agent bootstrap schema

The canonical definition lives at `src/hosting/contracts/bootstrap.types.ts`.
For the field-by-field reference see
[`docs/worker-bootstrap-contract.md`](worker-bootstrap-contract.md), which
itself defers to the SDK `fromBootstrap()` docs for the SDK-owned fields.

Summary of the fields the macp-playground is responsible for populating:

- `runtime_url` — gRPC endpoint (from `MACP_RUNTIME_ADDRESS`).
- `auth_token` — the Bearer JWT minted for this specific agent.
- `secure` / `allow_insecure` — TLS flags (RFC-MACP-0006 §3).
- `initiator` — `session_start` + `kickoff` (present on exactly one agent's bootstrap).
- `cancel_callback` — host/port/path the SDK auto-binds; cancel requests POST here.

## End-to-end flow

```
UI → macp-playground: POST /examples/run
  ↓
macp-playground compiles scenario → { runDescriptor, executionRequest, initiator, sessionId }
  ↓
For each participant:
  ├─ AuthTokenMinterService.mintToken(sender, scopes)  ← POST /tokens to auth-service
  └─ LaunchSupervisor.writeBootstrapFile(payload)      ← /tmp/*.json, auth_token baked in
  ↓
LaunchSupervisor.launch() spawns each agent process with MACP_BOOTSTRAP_FILE env
  ↓
Each agent (driven by the SDK — see the SDK guides linked above):
  ├─ reads MACP_BOOTSTRAP_FILE
  ├─ SDK opens runtime gRPC channel using runtime_url + auth_token
  ├─ if initiator: session.start() + first mode envelope
  │   else:        session.openStream() and react to history replay + live events
  └─ SDK auto-binds the cancel-callback HTTP listener at cancel_callback.{host,port,path}
  ↓
Control-plane observer: StreamSession(sessionId, read-only)
                        → projection → SSE broadcast to UI
```

## AUTH-2 — on-demand JWT minting

Every agent spawn mints a short-lived RS256 JWT against the standalone
`auth-service` (`POST /tokens`). There is no static-token fallback — the
service requires `MACP_AUTH_SERVICE_URL` to be set at boot and throws
`INVALID_CONFIG` otherwise (see `AppConfigService.validateAuthConfig()`).

### What the minter sends

```http
POST /tokens
Content-Type: application/json

{
  "sender": "<binding.participantId>",
  "ttl_seconds": <MACP_AUTH_TOKEN_TTL_SECONDS>,
  "scopes": {
    "can_start_sessions": <true iff binding is the initiator>,
    "is_observer": false,
    "allowed_modes": ["<scenario modeName>", ""]
  }
}
```

- `MACP_AUTH_SCOPES_JSON[sender]` is deep-merged on top (use `null` to clear a key).
- Initiator detection uses `context.initiator?.participantId === binding.participantId`.
- The trailing empty string in `allowed_modes` is **load-bearing**: it authorizes ambient envelopes (Signal / Progress) whose `mode` field is `""`. See the "Ambient envelopes" section below.

### Single-flight cache

`AuthTokenMinterService` keeps a short-lived in-memory cache keyed by
`(sender, scope-hash)`:

- Concurrent spawns for the same sender coalesce into one HTTP call (`inflight` map).
- Cached entries are returned until `expiresAt - 10s` (clock-skew buffer).
- The cache is not persistent — it exists to amortize launch bursts, not to extend token lifetime.

### Lifecycle constraint — no mid-stream refresh

Both SDKs bind the Bearer token to the gRPC channel once at stream open
and the runtime captures `AuthIdentity` once per stream (see
[`macp-runtime/docs/architecture.md` § Auth Layer](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/architecture.md#layers)).
There is no refresh callback in either SDK.

**Consequences:**

- `MACP_AUTH_TOKEN_TTL_SECONDS` must exceed the agent process's gRPC stream lifetime.
- auth-service `MACP_AUTH_MAX_TTL_SECONDS` (default 3600s) caps the requested TTL — raise both knobs for long-running agents.
- A follow-up ticket (AUTH-3) tracks adding a credentials-provider refresh hook and a `token_source` field to the bootstrap wire contract. Out of scope for AUTH-2.

### Observability

- Successful mints log `auth_mint_success sender=<id> expires_in=<s>s`.
- Failures log `auth_mint_failure sender=<id> reason=...` at warn level; the request surfaces `AUTH_MINT_FAILED` (HTTP 502).
- The token body is never logged (enforced by `auth-token-minter.service.spec.ts`).

## Policy registration (startup)

When `REGISTER_POLICIES_ON_LAUNCH=true` (the default) and `MACP_RUNTIME_ADDRESS`
is set, `PolicyRegistrarService.onApplicationBootstrap()` runs once per process
start:

1. Mints an admin JWT from the auth-service with `sender=macp-playground` and scopes `{ can_manage_mode_registry: true, is_observer: false, allowed_modes: ['*'] }`.
2. Opens a short-lived gRPC channel to the runtime using that JWT.
3. For each non-default policy loaded by `PolicyLoaderService`, calls `MacpClient.registerPolicy(descriptor)`.
4. Treats errors whose message contains `"already"` as idempotent success.
5. Logs `policy_registration_complete registered=<n> already=<n> failed=<n> total=<n>`.

If the admin mint fails, registration is aborted and an ERROR is logged:

```
[PolicyRegistrarService] policy registration aborted: failed to mint admin JWT
    — launches will fail with UNKNOWN_POLICY_VERSION. auth-service returned 500
```

Downstream `/examples/run` requests will reach the runtime with a `policyVersion`
it doesn't recognize, and the runtime rejects the session with
`UNKNOWN_POLICY_VERSION`. See
[`docs/policy-authoring.md` § Troubleshooting](policy-authoring.md#troubleshooting)
for the full checklist.

Policy registration is skipped (with a warning) when `MACP_RUNTIME_ADDRESS` is
unset — useful in CI and local tests that don't need a live runtime.

## Ambient envelopes (Signal / Progress)

Agents can emit ambient envelopes that are not bound to any specific mode —
for example, `risk-decider.worker.ts` emits a `session.context` **Signal**
when the proposal is first observed. Ambient envelopes have:

- `mode = ""`
- `session_id = ""` (correlation id travels in the payload instead)

For the runtime's mode-authorization check to accept these, the agent's JWT
must include `""` in `allowed_modes`. The macp-playground does this
automatically in `deriveScopes()` — every agent mint ends with
`allowed_modes: [context.modeName, '']`. Removing the empty string breaks
ambient emission at the runtime boundary with `FORBIDDEN`.

For the runtime-side handling (broadcast via `WatchSignals`, no session
history) see
[`macp-runtime/docs/API.md` § WatchSignals](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/API.md#watchsignals).

## Deployment checklist

1. Run the auth-service (see `docker-compose.dev.yml` for a dev topology).
2. Configure the runtime with `MACP_AUTH_ISSUER`, `MACP_AUTH_AUDIENCE`, and `MACP_AUTH_JWKS_URL=<auth-service>/.well-known/jwks.json` — see
   [`macp-runtime/docs/deployment.md`](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/deployment.md)
   for the full runtime deployment reference.
3. Set on the macp-playground:
   - `MACP_AUTH_SERVICE_URL=http://auth-service:3200` (required, fails fast).
   - `MACP_RUNTIME_ADDRESS=runtime.local:50051` (required for runs).
   - `MACP_AUTH_TOKEN_TTL_SECONDS` ≥ worst-case run length.
4. On first boot, confirm the logs show `policy_registration_complete` with `failed=0`.

## Adding a new agent

1. Add the agent to `src/example-agents/example-agent-catalog.service.ts` and create a matching manifest in `agents/manifests/<agent>.json`.
2. Ensure the worker loads its bootstrap via `loadBootstrapPayload()` / `from_bootstrap()` and lets the SDK construct a `MacpClient` from `runtime_url` + `auth_token`.
3. No control-plane or UI changes required. The Bearer token is minted per spawn by the auth-service — no static configuration.

## Cross-repo dependencies

This plan has matching tasks in:

- `macp-sdk-python` — PY-1..6 (secure default, `expected_sender`, publish). **Done upstream** (v0.2.0 features present in-tree).
- `macp-sdk-typescript` — TS-1..5 (secure default, `expectedSender`). **Done upstream** (v0.2.0 features present in-tree). v0.3.0 added the auto-binding cancel-callback listener so the worker no longer hand-rolls one.
- `macp-control-plane` — CP-1..15 (RunDescriptor contract, sessionId response, delete forged-envelope paths, observer-mode). **Not yet landed** — the macp-playground continues to POST `executionRequest` until CP-1 ships.
- `macp-ui-console` — UI-1..5 (remove operator inject panel). Independent of macp-playground.

## Forward-compat notes

- The `executionRequest.session.metadata.sessionId` carries the compiled `sessionId`, so observer tooling that reads metadata already sees the same id as the agents.
- `runDescriptor` is produced on every compile and returned in the `CompileLaunchResult`. Callers consume it directly — there is no legacy `executionRequest` shape.
- The macp-playground no longer ships a control-plane HTTP client (`src/control-plane/control-plane.client.ts` was removed during the direct-agent-auth rollout). If a future revision re-introduces a control-plane submit step, add a new module under `src/control-plane/` rather than reviving the old shape.
