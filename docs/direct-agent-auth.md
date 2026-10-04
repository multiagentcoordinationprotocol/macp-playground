# Direct-agent-auth in the macp-playground

This document describes how the **macp-playground** spawns agents under
[RFC-MACP-0004 §3](https://github.com/multiagentcoordinationprotocol/multiagentcoordinationprotocol/blob/main/rfcs/RFC-MACP-0004-security.md#3-authentication)
("the `sender` field MUST be derived from authenticated identity"): how
scenarios compile, how per-agent JWTs are minted, how runs are registered with
the control-plane, and how ambient envelopes are authorized. It is the
canonical home for AUTH-2 minting, CP-1 behaviour and ambient-envelope scopes;
policy registration is documented in
[`policy-authoring.md`](policy-authoring.md#how-policies-are-registered) and
the bootstrap file shape in
[`worker-bootstrap-contract.md`](worker-bootstrap-contract.md).

> **Agent-side patterns — the initiator / non-initiator code, the
> `expected_sender` guardrail, and `session.cancel()` behaviour — are
> canonically documented in the SDK guides**, not here. See:
>
> - Python: [`macp-sdk-python/docs/guides/direct-agent-auth.md`](https://github.com/multiagentcoordinationprotocol/macp-sdk-python/blob/main/docs/guides/direct-agent-auth.md)
> - TypeScript: [`macp-sdk-typescript/docs/guides/authentication.md`](https://github.com/multiagentcoordinationprotocol/macp-sdk-typescript/blob/main/docs/guides/authentication.md)
>   and [`macp-sdk-typescript/docs/guides/agent-framework.md`](https://github.com/multiagentcoordinationprotocol/macp-sdk-typescript/blob/main/docs/guides/agent-framework.md)
>
> For onboarding an agent of your own (sender ids, `MACP_RUNTIME_TOKEN`), see
> [`multiagentcoordinationprotocol/docs/onboarding-an-agent.md`](https://github.com/multiagentcoordinationprotocol/multiagentcoordinationprotocol/blob/main/docs/onboarding-an-agent.md).

## Why

Before this change, every spawned agent emitted envelopes by POSTing to the
control-plane's `/runs/:id/messages` route, and the control-plane forged
`SessionStart` on the agent's behalf. That violates
[RFC-MACP-0004 §3–§4](https://github.com/multiagentcoordinationprotocol/multiagentcoordinationprotocol/blob/main/rfcs/RFC-MACP-0004-security.md#3-authentication)
and the "no MACP bypass" rule of
[RFC-MACP-0001 §5.3](https://github.com/multiagentcoordinationprotocol/multiagentcoordinationprotocol/blob/main/rfcs/RFC-MACP-0001-core.md#53-session-scoped-communication-rule).
The change re-homes envelope emission to agents themselves and narrows the
control-plane to a read-only observer.

## Architectural invariants

1. **Agents authenticate to the runtime directly** using a JWT minted per spawn.
2. **The initiator agent opens the session** with its own identity (the SDK emits `SessionStart` from the bootstrap's `initiator` block).
3. **The control-plane is scenario-agnostic** — it does not inspect policy hints, kickoff templates, roles, or commitments.
4. **Control-plane never calls `Send`.** Observer-only.
5. **session_id is owned by the macp-playground** (UUID v4 allocated at compile time).
6. **Cancellation stays with the initiator** — only the session initiator may cancel by default ([RFC-MACP-0001 §7.3](https://github.com/multiagentcoordinationprotocol/multiagentcoordinationprotocol/blob/main/rfcs/RFC-MACP-0001-core.md#73-termination)); see the cancel note under "CP-1 run registration".
7. **Scenario policies are registered with the runtime at startup** by `PolicyRegistrarService`, using a separate admin JWT.

For the runtime-side enforcement of invariants 1–4 (authenticated sender
derivation, observer-identity passive-subscribe, `policy_version` lookup,
rate limits) see
[`macp-runtime/docs/getting-started.md` § Authentication configuration](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/getting-started.md#authentication-configuration)
and
[`macp-runtime/docs/API.md`](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/API.md).

## Compile output (twin artifacts)

`CompilerService.compile()` produces (`src/contracts/launch.ts`):

```ts
interface CompileLaunchResult {
  sessionId: string;                 // UUID v4 — shared by every agent + control-plane
  mode: 'live' | 'sandbox';
  runDescriptor: RunDescriptor;      // generic POST /runs body (no scenario-specific fields)
  initiator?: InitiatorPayload;      // SessionStart + kickoff for exactly one participant
  scenarioMeta: ScenarioMeta;        // policyHints, sessionContext, initiatorParticipantId
  display: { title: string; scenarioRef: string; templateId?: string; expectedDecisionKinds?: string[] };
  participantBindings: ParticipantAgentBinding[];
}
```

`runDescriptor.session` intentionally carries no `policyHints`,
`initiatorParticipantId`, participant roles or kickoff; those live only on
`initiator`, on `scenarioMeta` (internal to this service), and in the per-agent
bootstrap files.

## Agent bootstrap schema

The canonical definition lives at `src/hosting/contracts/bootstrap.types.ts`.
For the field-by-field reference see
[`docs/worker-bootstrap-contract.md`](worker-bootstrap-contract.md), which
itself defers to the SDK `fromBootstrap()` docs for the SDK-owned fields.

Summary of the fields the macp-playground is responsible for populating:

- `runtime_url` — gRPC endpoint (from `MACP_RUNTIME_ADDRESS`).
- `auth_token` — the Bearer JWT minted for this specific agent (always present).
- `secure` / `allow_insecure` — TLS flags (TLS is required by [RFC-MACP-0004 §2](https://github.com/multiagentcoordinationprotocol/multiagentcoordinationprotocol/blob/main/rfcs/RFC-MACP-0004-security.md#2-transport-security)).
- `initiator` — `session_start` + `kickoff` (present on exactly one agent's bootstrap).
- `cancel_callback` — host/port/path the SDK binds a local cancel listener on.

## End-to-end flow

The sequence (compile → concurrent CP-1 submit + agent attach, initiator spawned
first, 502 on an unconfirmed attached agent) is documented once, in
[`architecture.md` § Run Example](architecture.md#4-run-example-full-showcase-flow).
What is specific to direct-agent-auth: each spawn mints its own JWT
(see [AUTH-2](#auth-2--on-demand-jwt-minting)), the Bearer is baked into that
agent's bootstrap file, and every agent then talks to the runtime over its own
gRPC channel — the control-plane only observes the session (read-only
`StreamSession`) and never sends on an agent's behalf.

## AUTH-2 — on-demand JWT minting

Every agent spawn mints a short-lived RS256 JWT against the standalone
auth-service (`POST /tokens`; wire format in
[`macp-auth-service/docs/API.md` § `POST /tokens`](https://github.com/multiagentcoordinationprotocol/macp-auth-service/blob/main/docs/API.md#post-tokens)).
There is no static-token fallback. `MACP_AUTH_SERVICE_URL` must be set to boot
([`deployment.md`](deployment.md)); minting happens on the spawn path, so only
`/examples/run` requests that bootstrap agents depend on the auth-service being reachable.

The runtime's accepted JWT algorithms and resolver configuration are
runtime-owned — see
[`macp-runtime/docs/getting-started.md` § JWT mode](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/getting-started.md#jwt-mode).
This stack is RS256 end-to-end.

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
- Consequence during an auth-service outage: a relaunch of a recently minted `(sender, scopes)` pair is served from cache and succeeds, while new participants fail with `AUTH_MINT_FAILED` — so failures can look intermittent.

### Lifecycle constraint — no mid-stream refresh

Both SDKs bind the Bearer token to the gRPC channel once at stream open
and the runtime captures `AuthIdentity` once per stream (see
[`macp-runtime/docs/architecture.md` § Layers](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/architecture.md#layers)).
There is no refresh callback in either SDK.

**Consequences:**

- `MACP_AUTH_TOKEN_TTL_SECONDS` must exceed the agent process's gRPC stream lifetime.
- auth-service `MACP_AUTH_MAX_TTL_SECONDS` caps the requested TTL — raise both knobs for long-running agents.
- A credentials-provider refresh hook (and a matching bootstrap field) is out of scope for AUTH-2.

### Observability

- Successful mints log `auth_mint_success sender=<id> expires_in=<s>s`.
- Failures log `auth_mint_failure sender=<id> reason=...` at warn level; the request surfaces `AUTH_MINT_FAILED` (HTTP 502).
- The token body is never logged (enforced by `auth-token-minter.service.spec.ts`).

## CP-1 run registration

`ExampleRunService.run()` submits the compiled `runDescriptor` to the
control-plane's `POST /runs` (CP-1; wire contract in
[`macp-control-plane/docs/API.md` § `POST /runs`](https://github.com/multiagentcoordinationprotocol/macp-control-plane/blob/main/docs/API.md#post-runs))
via `ControlPlaneRunClient` (`src/launch/control-plane-run-client.service.ts`).
This is **orthogonal to, not a replacement for**, the direct-agent-auth gRPC
path above: the initiator agent opens the runtime session itself regardless of
whether this call succeeds. Its only purpose is to let the control-plane's
observer stream learn about the run so UI Console projections have something
to subscribe to from the moment the run starts, not after the first envelope
arrives.

Configuration:

- `MACP_CONTROL_PLANE_URL` — control-plane base URL. **Unset by default** —
  when empty, submission is skipped entirely (`control_plane_submit_skipped`
  logged at `warn`) and `/examples/run` behaves exactly as it does with no
  control-plane at all.
- `MACP_CONTROL_PLANE_TIMEOUT_MS` (default `5000`) — bounds the `fetch` call
  via `AbortSignal.timeout()`.
- `MACP_CONTROL_PLANE_API_KEY` — sent as `Authorization: Bearer <key>` when
  set. Needed because control-plane's global `AuthGuard` requires an
  `Authorization` header on every route, including `POST /runs`, even when
  the control-plane's own `AUTH_API_KEYS` is unset (only the token-validity
  check is skipped in that case).

**Best-effort and non-fatal by design:** every failure mode (unset URL,
network error, timeout, non-2xx response, malformed JSON, a response missing
`runId`, `status` or `sessionId`, or a `sessionId` that doesn't match the one submitted — `reason=session_id_mismatch`) returns `null` from `submitRun()` and logs a
`warn` — `ControlPlaneRunClient` never throws. In `ExampleRunService.run()`,
the submission races agent bootstrap via `Promise.allSettled`; only
`hosting.attach()`'s own rejection can fail the request, so a control-plane
outage or misconfiguration never blocks or **fails** the demo — it just means
the run is invisible to the observer stream, which the `warn` log makes
diagnosable. It **can still delay** the HTTP response, though: `allSettled`
awaits both branches, so a slow or unreachable control-plane holds the
`/examples/run` response open for up to `MACP_CONTROL_PLANE_TIMEOUT_MS` even
once agent bootstrap has already finished. There is no circuit breaker — a
sustained control-plane outage means every launch pays the full timeout,
not just the first one. On success, the response is surfaced as
`controlPlaneRun` on the `/examples/run` result (see
[`docs/api-reference.md`](api-reference.md)).

**Known gap: control-plane-initiated cancel is not wired.** The submitted
`runDescriptor.session.metadata` carries neither `cancelCallback` nor
`cancellationDelegated` (both reserved keys per `RunDescriptor`'s docstring),
so a UI-initiated cancel through the control-plane's
[`POST /runs/:id/cancel`](https://github.com/multiagentcoordinationprotocol/macp-control-plane/blob/main/docs/API.md#post-runsidcancel)
fails closed because neither cancel option is configured. Both SDKs **do**
bind a listener on the bootstrap's `cancel_callback.{host,port,path}` (the
TypeScript SDK when `participant.run()` starts, the Python SDK inside
`from_bootstrap()`), but that listener is not yet usable as the
control-plane's **Option A** target:

- With the default `MACP_CANCEL_CALLBACK_PORT_BASE=0` the agent binds an
  ephemeral port that nothing reports back, and the default host
  `127.0.0.1` is unreachable from a control-plane in another container.
- The SDK listener's handler calls `participant.stop()` — it stops the local
  agent loop; it does not call `CancelSession` on the runtime, which is what
  the control-plane's Option A expects the initiator to do.
- The control-plane's Option A also sends an optional bearer secret; the SDK
  listeners do not check one.

**Option B** (`cancellationDelegated: true`, control-plane calls
`CancelSession` directly with its own runtime identity) would work, but
widens the control-plane's authority over a running session beyond
"observer" — a deliberate trust-boundary decision this repo hasn't made,
not a wiring gap to close casually. Until one of those changes, the only way
a session in this repo reaches a terminal `CANCELLED` state early is the
in-band path: the `risk-decider` coordinator
(`src/example-agents/runtime/risk-decider.worker.ts`) calling
`participant.client.cancelSession()` when the runtime rejects its commit
(typically `POLICY_DENIED`), or when its wait-all deadline
(`RISK_DECIDER_WAIT_ALL_TIMEOUT_MS`, default 60 s) passes with quorum unmet (see
[`policy-authoring.md` § Runtime Enforcement at Commit Time](policy-authoring.md#runtime-enforcement-at-commit-time)).

## Policy registration (startup)

At startup `PolicyRegistrarService` mints a separate **admin** JWT
(`sender=macp-playground`, scopes
`{ can_manage_mode_registry: true, is_observer: false, allowed_modes: ['*'] }`)
from the same auth-service and registers every non-default policy in
`policies/` with the runtime. It shares the auth-service dependency with
agent minting: if the admin mint fails, registration is aborted, the service
still boots, and later runs fail at the runtime with `UNKNOWN_POLICY_VERSION`.

The full flow (idempotent re-registration, `schema_version` drift check,
read-only registry verification, skip conditions and log lines) is documented
in [`policy-authoring.md` § How Policies Are Registered](policy-authoring.md#how-policies-are-registered),
with a checklist in
[`policy-authoring.md` § Troubleshooting](policy-authoring.md#troubleshooting).

## Ambient envelopes (Signal / Progress)

Agents can emit ambient envelopes that are not bound to any specific mode —
for example, `risk-decider.worker.ts` emits a `session.context` **Signal**
when the proposal is first observed. Ambient envelopes have:

- `mode = ""`
- `session_id = ""` (correlation id travels in the payload instead)

For the runtime's mode-authorization check to accept these, the agent's JWT
must include `""` in `allowed_modes`. The macp-playground does this
automatically in `deriveScopes()`
(`src/hosting/process-example-agent-host.provider.ts`) — every agent mint ends
with `allowed_modes: [context.modeName, '']`. Removing the empty string breaks
ambient emission at the runtime boundary with `FORBIDDEN`.

For the runtime-side handling (broadcast via `WatchSignals`, no session
history, authentication and back-pressure on the watch side) see
[`macp-runtime/docs/API.md` § WatchSignals](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/API.md#watchsignals).

## Deployment checklist

1. Run the auth-service (see `docker-compose.dev.yml` for a dev topology, or
   `docker-compose.fullstack.yml` for the whole stack).
2. Configure the runtime to trust it (`MACP_AUTH_ISSUER`, `MACP_AUTH_AUDIENCE`,
   `MACP_AUTH_JWKS_URL=<auth-service>/.well-known/jwks.json`) — see
   [`macp-runtime/docs/getting-started.md` § Authentication configuration](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/getting-started.md#authentication-configuration)
   and [`macp-auth-service/docs/integration.md` § Runtime wiring](https://github.com/multiagentcoordinationprotocol/macp-auth-service/blob/main/docs/integration.md#runtime-wiring).
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

- `macp-sdk-python` — PY-1..6 (secure default, `expected_sender`, cancel-callback binding). **Done upstream**; this repo pins `macp-sdk-python>=0.14.1,<0.15` (`agents/requirements.txt`).
- `macp-sdk-typescript` — TS-1..5 (secure default, `expectedSender`, cancel-callback binding). **Done upstream**; this repo pins `macp-sdk-typescript@^0.14.1` (`package.json`).
- `macp-control-plane` — CP-1..15 (RunDescriptor contract, sessionId response, delete forged-envelope paths, observer-mode). **CP-1 landed** — the macp-playground submits `runDescriptor` to `POST /runs` via `ControlPlaneRunClient`; see "CP-1 run registration" above.
- `macp-ui-console` — UI-1..5 (remove operator inject panel). Independent of macp-playground.

## Forward-compat notes

- The compiled `sessionId` is carried as `runDescriptor.session.sessionId` and as every bootstrap's `session_id`, so observer tooling sees the same id as the agents.
- `runDescriptor` is produced on every compile and returned in the `CompileLaunchResult`. Callers consume it directly — there is no legacy `executionRequest` shape.
- The write-side control-plane HTTP client removed during the direct-agent-auth rollout (`src/control-plane/control-plane.client.ts`) has **not** been revived — CP-1's `ControlPlaneRunClient` (`src/launch/control-plane-run-client.service.ts`) is a new, narrower client that only calls the observer-safe `POST /runs`, and deliberately does **not** live under `src/control-plane/`: `src/observer-invariant.spec.ts` forbids any import path containing that segment, guarding against exactly this kind of write-path client creeping back in.
