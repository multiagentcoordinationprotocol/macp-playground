# Absorb macp-runtime v0.5.0 / macp-proto 0.1.4–0.1.6 / spec changes

**Date:** 2026-07-05
**Scope:** `macp-playground` only. Maps the full upstream change inventory (runtime v0.5.0
CHANGELOG + `docs/change-review-phases-a-e.md`, macp-proto 0.1.4→0.1.6, spec updates) to
concrete work in this repo. No branches/commits are created by this plan — it is the work
specification.

---

## 1. Context — what this repo is and how it touches the runtime

`macp-playground` is a NestJS showcase service (scenario catalog + compiler + example-agent
hosting). It **never** speaks MACP gRPC from its own request path; all runtime traffic goes
through the two upstream SDKs, at exactly **three** code surfaces, plus one compose file that
*runs* the runtime image:

| # | Surface | Evidence | SDK |
|---|---------|----------|-----|
| S1 | **Boot-time policy registration** — `PolicyRegistrarService.onApplicationBootstrap()` mints an admin JWT and calls `client.registerPolicy(descriptor)` for every non-default policy in `policies/` | `src/policy/policy-registrar.service.ts:53-67` (MacpClient construction at 53–58, `registerPolicy` at 67); gated by `REGISTER_POLICIES_ON_LAUNCH` (`src/config/app-config.service.ts:86`) and `MACP_RUNTIME_ADDRESS` (`app-config.service.ts:95`) | macp-sdk-typescript |
| S2 | **Node coordinator worker** — `risk-decider.worker.ts` consumes `agent.fromBootstrap()`: session stream (passive subscribe), `vote`/`commit` actions, ambient `Signal` emission (`emitSessionContext`, lines 26–52), suspend/resume demo (lines 189–212), `cancelSession` fallback on commit denial (line 263) | `src/example-agents/runtime/risk-decider.worker.ts` | macp-sdk-typescript |
| S3 | **Python framework workers** — LangGraph/LangChain/CrewAI workers consume `macp_sdk.agent.from_bootstrap()` and emit Evaluation/Vote/Signal/Progress via the SDK; raw proto usage is limited to `core_pb2.ProgressPayload` / `SignalPayload` | `agents/{langgraph,langchain,crewai}_worker/main.py` (e.g. `agents/langgraph_worker/main.py:13,127`) | macp-sdk-python |
| S4 | **Fullstack compose** — `docker-compose.fullstack.yml` runs the runtime **image** itself (`image: macp-runtime:0.1.3`, line 36) with JWT auth against the auth-service JWKS | `docker-compose.fullstack.yml:36-51` | — |

The playground *produces* the SessionStart/kickoff payloads that the initiator worker emits:
`CompilerService.compile()` builds `InitiatorPayload.sessionStart`
(`src/compiler/compiler.service.ts:93-105`), which is threaded through
`ExampleRunService.run()` (`src/launch/example-run.service.ts:45`) into
`ProcessExampleAgentHostProvider.buildBootstrapPayload()`
(`src/hosting/process-example-agent-host.provider.ts:194-217`) and written to the
`MACP_BOOTSTRAP_FILE` the SDK consumes.

The other two compose files do **not** run the runtime:
- `docker-compose.yml` — playground only.
- `docker-compose.dev.yml` — playground + dev auth-service; `MACP_RUNTIME_ADDRESS` is unset,
  so agents cannot connect and the policy registrar skips itself (warning).

Integration tests (`test/integration/*.integration.spec.ts`) exercise the HTTP surface with a
mock control-plane only; nothing in `test/` opens a gRPC channel
(`test/helpers/integration-test-app.ts:84-86` defaults `runtimeAddress` to `''`).

### Current dependency / image versions (verified)

| Dependency | Declared | Locked / resolved | Proto era |
|------------|----------|-------------------|-----------|
| `macp-sdk-typescript` | `^0.4.1` (`package.json:40`) | 0.4.1 (package-lock) | bundles `@multiagentcoordinationprotocol/proto` **0.1.3** (transitive, package-lock) |
| `macp-sdk-python` | `>=0.4.1,<0.5` (`agents/requirements.txt:9`) | latest on PyPI is **0.4.1** | 0.1.3 era |
| runtime image (fullstack) | `macp-runtime:0.1.3` locally built (`docker-compose.fullstack.yml:36`) | — | pre-v0.5.0 |
| other fullstack images | `macp-control-plane:0.1.3`, `macp-auth-service:0.1.3`, `macp-playground:0.4.0` | — | — |

**The single most important structural fact:** this repo has **no direct macp-proto
dependency**. Every proto-level change (items 1–3 of the inventory) reaches the playground
only through new SDK releases. As of 2026-07-05, **no published SDK (TS 0.4.1 / Py 0.4.1)
has absorbed proto 0.1.4–0.1.6** — so all proto-surface work here is gated on upstream SDK
releases (tracked in §4 Sequencing).

---

## 2. Impact matrix

Every inventory item mapped to impacted / not-impacted, with evidence and action.

| # | Change | Impact | Evidence | Action |
|---|--------|--------|----------|--------|
| 1 | multi_round `ContributePayload` proto (0.1.4); JSON client path deprecated | **No impact** | Zero references to `multi_round` / `Contribute` anywhere in `src/`, `agents/`, `packs/`, `scripts/`, `test/` (grep). All three scenario packs bind `modeName: macp.mode.decision.v1` (`packs/fraud/.../scenario.yaml:50`, `packs/lending/.../scenario.yaml:56`, `packs/claims/.../scenario.yaml:49`). The playground drives no multi-round sessions and constructs no multi-round payloads. | None. If a multi-round scenario is ever authored, its kickoff `payloadEnvelope.proto.typeName` must be `macp.modes.multi_round.v1.ContributePayload` (the pack format already supports proto typeNames — see `packs/fraud/.../scenario.yaml:87`). Noted in §3 T9 backlog. |
| 2 | `SessionStartPayload.max_suspend_ms` (0.1.5) | **Impacted — SDK-gated enhancement** | The suspend/resume demo exists (`risk-decider.worker.ts:189-212`, gated on a `suspend` sentinel in `customerId`, hold `RISK_DECIDER_SUSPEND_HOLD_MS` default 8000). The compile pipeline has no `maxSuspendMs` field (`src/contracts/launch.ts:58-69`, `src/hosting/contracts/bootstrap.types.ts:41-53`). SDK 0.4.1 cannot set it: `Participant.emitInitiatorEnvelopes()` (`dist/agent/participant.js:292-305`) passes only `intent/participants/ttlMs/contextId/extensions/roots` to `session.start()`. | §3 T8: after SDK bump, add `maxSuspendMs` to scenario YAML `launch` schema → `InitiatorPayload.sessionStart` → bootstrap `session_start.max_suspend_ms`; demo template with a small cap (e.g. 15000) so the suspend demo can also demonstrate cap-bounded suspension. Runtime treats 0/absent as default (7 days) — no compatibility risk meanwhile. |
| 3 | `HandoffAcceptPayload.implicit` + `ListSessions` pagination (0.1.6) | **No impact** | No handoff usage anywhere (grep for `handoff`/`Handoff` in `src/`, `agents/`, `packs/` — only SDK-internal files). Playground never calls `ListSessions` (grep for `listSessions` in `src/`, `agents/`, `scripts/` — zero hits; the only session RPCs used are `cancelSession`/`suspendSession`/`resumeSession` in `risk-decider.worker.ts`). | None. Both arrive silently via the SDK bump (T7). If a handoff scenario is authored later, client code must never set `implicit: true` (runtime rejects). |
| 4 | Dev mode: runtime refuses to start without auth unless `MACP_ALLOW_INSECURE=1`; Docker image no longer bakes it in | **Impacted — verified safe, but image bump + docs required** | Compose audit: `docker-compose.yml` and `docker-compose.dev.yml` do **not** run a runtime service (read in full). `docker-compose.fullstack.yml` runs the runtime **with JWT auth configured** (`MACP_AUTH_ISSUER` line 44, `MACP_AUTH_JWKS_URL` line 46) so the no-auth refusal path never triggers, and it *already* sets `MACP_ALLOW_INSECURE: '1'` (line 41) for plaintext gRPC. So nothing breaks — but the image tag is stale (item 18) and the docs tell operators to run their own runtime (`docs/deployment.md:13`) without mentioning the new startup requirement. | §3 T1 (image bump) + T5 (docs: local no-auth runtime now requires explicit `MACP_ALLOW_INSECURE=1`). |
| 5 | HS256 removed from default JWT allowlist | **No impact** | All JWTs in this stack are RS256: dev auth-service comment (`docker-compose.dev.yml:23-25`), fullstack header (`docker-compose.fullstack.yml:8`), `docs/direct-agent-auth.md:108`. Grep for `HS256` across `src/`, `agents/`, `test/`, `docs/`, compose files: zero hits. Runtime default allowlist is RS256/ES256 — RS256 stays valid. | None. T5 adds one doc line so nobody introduces HS256 later. |
| 6 | Passive-subscribe `after_sequence`: 1-based exclusive ordinal; compacted-base resume → FAILED_PRECONDITION; no subscribe-window duplicates | **Indirect — behavior improves, verify only** | All workers consume the stream via SDK `GrpcTransportAdapter`, which calls `sendSubscribe(sessionId)` with the default `afterSequence = 0` (SDK `dist/agent/transports.js:32`, `dist/client.js:149`). `0` = "from start" under both old and new semantics, so no code change. The duplicate-removal is a strict improvement; worker handlers were already idempotent by construction (`signals.set(sender, …)` keyed map, `if (!proposalId)` first-proposal guard in `risk-decider.worker.ts:88,118`). No playground code passes a non-zero `after_sequence`, so the compacted-base FAILED_PRECONDITION path is unreachable from here. | §3 T6: acceptance run against v0.5.0 asserting no duplicate Proposal/Evaluation handling in worker logs. |
| 7 | Watch streams: lag → RESOURCE_EXHAUSTED; `WatchSignals` requires auth; six lifecycle states | **No code impact** | The playground never calls `WatchSignals`/`WatchSessions` (grep — the only mentions are comments: `risk-decider.worker.ts:94`, `docs/worker-bootstrap-contract.md:130`). It *emits* Signals via authenticated `Send` (`risk-decider.worker.ts:47`, Python `_safe_emit` in `agents/*/main.py`) — sending is unaffected. The watch-side consumer is `macp-control-plane` (separate repo; it already authenticates with an observer JWT per `docker-compose.fullstack.yml:8-10`). | None here. T5: one-line note in `docs/worker-bootstrap-contract.md` §Ambient envelopes that `WatchSignals` consumers must now authenticate. Cross-repo flag: control-plane must handle RESOURCE_EXHAUSTED reconnects — out of scope for this repo, called out in §5 risks. |
| 8 | Commitment `policy_version` echo: empty now matches bound policy | **No breaking impact — relaxation** | The SDK echoes `bootstrap.policy_version ?? 'policy.default'` on every commit (`macp-sdk-typescript dist/agent/runner.js:101`, `dist/agent/participant.js:232`, `dist/constants.js:7`). Scenarios that bind a policy thread the exact version through compile → bootstrap (`compiler.service.ts:102`, `process-example-agent-host.provider.ts:203`); scenarios without one echo `policy.default`, which the runtime resolves the session to anyway (RFC-0012 §6.1). Both continue to match; the new empty-matches rule only widens acceptance. | None. T5: update `docs/policy-authoring.md` (§Runtime Enforcement) to note clients need not echo `policy.default`. |
| 9 | Task mode: external orchestrator allowed | **No impact (opportunity)** | No task-mode scenarios exist (all packs are decision-mode, see item 1 evidence). | §3 T9 (backlog): a task-mode scenario pack demonstrating an external orchestrator (initiator not in `participants`) is now possible and would be a good showcase. Not required for absorption. |
| 10 | Quorum policy: `threshold` strictly approval bar; `percentage` = integer 0–100 | **No direct impact + one adjacent latent bug to fix** | No quorum-mode policies: all six files in `policies/` are `"mode": "macp.mode.decision.v1"` or `"*"` (read in full). Decision-mode `voting.threshold` (0–1 ratio) is untouched by v0.5.0. **However**, verifying against the runtime evaluator exposed a pre-existing playground bug: `policies/policy.fraud.unanimous.json` sets `"quorum": { "type": "percentage", "value": 1.0 }` while the runtime computes percentage on a **0–100 scale** (`macp-runtime crates/macp-policy/src/evaluator.rs:294-300`; its own tests use `value: 100.0`). `1.0` therefore means 1% — quorum is satisfied by a single voter, defeating the "all participants must vote" intent. | §3 T3: change to `"value": 100`; document the 0–100 scale in `docs/policy-authoring.md`. |
| 11 | Extension modes: descriptors must declare `Commitment` terminal; promote-to-`macp.mode.*` rejected; empty mode_version binds descriptor version | **No impact** | The playground registers **policies**, never extension modes: grep for `RegisterExtMode`/`registerExtMode`/`PromoteMode` across `src/`, `agents/`, `scripts/` — zero hits. All sessions bind explicit `mode_version` from scenario YAML (`compiler.service.ts:100`, strict `SessionStart` requires it anyway). | None. |
| 12 | `MACP_POLICIES_DIR` makes policy registry wire-read-only (mutating policy RPCs → FAILED_PRECONDITION); `Initialize` roots `list_changed:false` | **Impacted — registrar hardening + deployment option** | S1 registers policies via RPC at every boot (`policy-registrar.service.ts:67`). Against a runtime configured with `MACP_POLICIES_DIR`, each `registerPolicy` returns FAILED_PRECONDITION; the registrar's only special case is messages containing `"already"` (`policy-registrar.service.ts:101-104`), so every policy logs `policy_register_failed` and — if the dir doesn't contain the playground's policies — every launch fails with `UNKNOWN_POLICY_VERSION`. `Initialize` roots capability change: playground never calls `Initialize`/`ListRoots`/`WatchRoots` (grep) — no impact. | §3 T2: (a) detect the read-only precondition and downgrade to an informative skip; (b) verify presence via `client.getPolicy()`/`listPolicies()` (both exist in SDK 0.4.1, `dist/client.js:405,410`) and log which required policies are missing; (c) T1/T5: document the recommended prod-style alternative — mount `./policies` into the runtime as `MACP_POLICIES_DIR` and set `REGISTER_POLICIES_ON_LAUNCH=false`. |
| 13 | Prometheus endpoint (`MACP_METRICS_ADDR`) | **Impacted — demo enhancement** | Fullstack compose has no metrics wiring (read in full). | §3 T1: add `MACP_METRICS_ADDR: 0.0.0.0:9464` + port mapping `9464:9464` to the runtime service; mention in compose header + `docs/deployment.md` as an observability demo surface. |
| 14 | New runtime env vars (`MACP_POLICIES_DIR`, `MACP_SESSION_DISK_RETENTION_SECS`, `MACP_SHUTDOWN_DRAIN_SECS`, tonic limits, `MACP_AUTH_JWT_ALGS`, `MACP_METRICS_ADDR`) | **Doc-only impact** | The playground documents runtime configuration by linking to `macp-runtime` docs (`docs/deployment.md:13,21`) rather than duplicating tables — correct pattern, nothing stale. The concrete surface is the fullstack compose runtime service env block. | §3 T1 adds `MACP_METRICS_ADDR` (item 13); the rest are optional operator knobs — no compose defaults needed (`MACP_MEMORY_ONLY=1` makes retention/checkpoint knobs moot in the demo). No playground-side env vars change (its own `MACP_*` namespace is unrelated: see `src/config/app-config.service.ts:95-102`). |
| 15 | Session IDs: 36-char base64url with `-` accepted | **No impact** | The playground always allocates hyphenated lowercase UUID v4 (`compiler.service.ts:2,85` `randomUUID()`; fallback `example-run.service.ts:28`), which was and remains valid. The change only *widens* runtime acceptance. | None. |
| 16 | Conformance fixtures: spec repo `schemas/conformance/` canonical | **No impact** | The playground neither replays nor generates runtime conformance vectors or transcripts. Its fixtures are scenario-pack YAML for its own compiler (`test/fixtures/packs/`), and `expectedDecisionKinds` is display metadata only (`compiler.service.ts:164`). Grep for `conformance`, `expected_error_code`, `payload_type` fixture patterns: zero hits outside pack kickoff typeNames. | None. |
| 17 | Upcoming: handoff synthetic accepts (runtime-emitted, sender = target, `implicit: true`) in histories | **No impact** | No handoff sessions (item 3). No playground code replays session histories. | None. If T9's backlog ever adds a handoff scenario, workers must tolerate runtime-emitted `HandoffAccept` envelopes they didn't send. |
| 18 | Runtime Docker image published at ghcr v0.5.0/latest | **Impacted** | Fullstack compose pins locally-built `macp-runtime:0.1.3` (`docker-compose.fullstack.yml:36`) and the header (lines 1–14) describes a "0.1.3" stack. The runtime's docker workflow publishes `ghcr.io/multiagentcoordinationprotocol/macp-runtime:{0.5.0,latest}` (semver tags, verified in `macp-runtime/.github/workflows/docker.yml:41-46`). | §3 T1: bump to `ghcr.io/multiagentcoordinationprotocol/macp-runtime:0.5.0` (or keep local-build convention and bump the tag — decide per team preference; plan recommends ghcr so the harness no longer requires a local Rust build); rewrite the header comment. |
| 19 | Spec: `SessionStartPayload.context` bytes field gone (now `context_id` + `extensions`) | **Impacted — dead-field cleanup** | The playground still plumbs a `context` object through the initiator SessionStart chain: `src/contracts/launch.ts:65`, `src/contracts/example-agents.ts:96`, `src/compiler/compiler.service.ts:103`, `src/hosting/contracts/bootstrap.types.ts:48`, `src/hosting/process-example-agent-host.provider.ts:204`, `docs/worker-bootstrap-contract.md` shows it in the bootstrap shape, and — found in Pass 1 — the **public** `/launch/compile` response example documents it (`docs/api-reference.md:234`), so the UI console may read it. It is **already dead on the wire**: SDK 0.4.1's `fromBootstrap` reads only `context_id` and `extensions` from `session_start` (`dist/agent/runner.js:80-82`), and `session.start()` accepts no `context`. The *scenario* context is delivered to agents via `metadata.session_context` (`provider:227`), which is consumed (`risk-decider.worker.ts:27,177`) — that path stays. | §3 T4: delete `sessionStart.context` from the four TS types + two construction sites + doc; keep `contextTemplate → scenarioMeta.sessionContext → metadata.session_context` untouched. |
| 20 | `max_suspend_ms` usable for suspend/resume demos | **Impacted — same work as item 2** | Suspend demo evidence in item 2. With a session-bound cap, a demo can show a suspended session expiring against the cap. | Folded into §3 T8. |

**Cross-cutting note (not an inventory item):** the runtime v0.5.0 decision-mode
"decline resolves" semantics were already absorbed by this repo — see
`plans/decision-negative-committed-outcomes.md` and the updated fallback comment at
`risk-decider.worker.ts:249-259`. No further work; T6 re-verifies it against the released
image.

---

## 3. Work plan

Ordered, mergeable tasks. Effort: S ≈ ≤2h, M ≈ half-day, L ≈ 1–2 days.

### T1 — Fullstack compose: runtime v0.5.0 + metrics (S/M) — **riskiest change, expanded**

**Files:** `docker-compose.fullstack.yml`, `CLAUDE.md` (§Docker), `docs/deployment.md`.

Steps, in order:

1. **Pre-flight (cross-repo):** confirm `macp-control-plane` compatibility with v0.5.0 watch
   semantics — it must (a) authenticate its `WatchSignals` observer (it already mints an
   observer JWT, `docker-compose.fullstack.yml:8-10`, so likely fine), (b) treat
   RESOURCE_EXHAUSTED on watch streams as reconnect-not-crash, (c) tolerate the six-state
   lifecycle event set. If unverified, run T1's smoke with the old CP first and watch its
   logs for stream errors before touching CP pins.
2. Change `runtime.image` (line 36) to
   `ghcr.io/multiagentcoordinationprotocol/macp-runtime:0.5.0` (published semver tag,
   verified in `macp-runtime/.github/workflows/docker.yml:41-46`).
3. Rewrite the header comment (lines 1–14): drop the "0.1.3 stack" framing; list current
   image prereqs; note the runtime image no longer bakes `MACP_ALLOW_INSECURE=1` (we set it
   explicitly — keep line 41; it is required for plaintext gRPC regardless of auth mode).
4. Add to the runtime service: `MACP_METRICS_ADDR: 0.0.0.0:9464` + port mapping
   `9464:9464`; comment pointing at the Prometheus text endpoint as a demo surface.
5. Add a **commented-out** read-only-registry variant on the runtime service
   (`MACP_POLICIES_DIR: /policies` + `./policies:/policies:ro` volume) with a pointer to
   T2's registrar behavior and `REGISTER_POLICIES_ON_LAUNCH=false` on the playground side.
6. Leave `macp-control-plane:0.1.3` / `macp-auth-service:0.1.3` pins as-is unless their own
   absorption releases exist (cross-repo; see §5 risk R2). Update the `macp-playground:0.4.0`
   prereq comment when this repo cuts its next image.

**Test plan (staged):**
- Stage 1 — runtime alone: `docker compose -f docker-compose.fullstack.yml up auth-service runtime`;
  assert the runtime container reaches listening state (JWT config path, no
  insecure-refusal), and `curl :9464/metrics` responds.
- Stage 2 — full stack: `OPENAI_API_KEY=… docker compose -f docker-compose.fullstack.yml up`;
  run the fraud scenario via `POST /examples/run`; assert (a) session resolves with a
  Commitment, (b) CP observer shows the run completing (no watch-stream crash loops),
  (c) a `suspend`-sentinel run still suspends/resumes, (d) metrics counters incremented.

**Definition of done:** both stages green + T6 acceptance matrix items 1, 2, 4, 6 recorded.

**Rollback:** revert the image tag and env additions (single-file change); nothing else in
the repo depends on the compose pin. If only the metrics addition misbehaves, drop
`MACP_METRICS_ADDR` independently.

### T2 — PolicyRegistrarService: read-only registry awareness (M)

**Files:** `src/policy/policy-registrar.service.ts`, `src/policy/policy-registrar.service.spec.ts`,
`docs/policy-authoring.md`, `docs/deployment.md`.

- Detect FAILED_PRECONDITION / "read-only" on `registerPolicy` (v0.5.0 with
  `MACP_POLICIES_DIR` set). On detection: stop mutating, switch to verification — for each
  required policy call `client.getPolicy(policyId)` and log present/missing; summary line
  distinguishes `registered / already / managed_by_runtime / missing / failed`.
- Missing policies in read-only mode: log ERROR naming the exact files to drop into the
  runtime's policies dir (launches will fail `UNKNOWN_POLICY_VERSION`).
- Keep current behavior for writable registries unchanged.
- Unit tests: mock `MacpClient` returning read-only errors; assert no further register calls
  and correct summary logging.

**Test plan:** unit tests + live check: run runtime v0.5.0 with `MACP_POLICIES_DIR` mounted
to `./policies` (T1 step 5 provides the compose variant), boot playground, assert registrar
logs `managed_by_runtime` and a fraud run completes.

**Definition of done:** unit specs cover writable, read-only-present, read-only-missing;
live read-only boot logs the new summary and a run resolves.

**Rollback:** behavior for writable registries is unchanged, so reverting the commit restores
today's exact semantics; no data or wire-format migration involved.

### T3 — Fix `policy.fraud.unanimous.json` percentage scale (S)

**Files:** `policies/policy.fraud.unanimous.json`, `docs/policy-authoring.md`.

- `"quorum": { "type": "percentage", "value": 1.0 }` → `"value": 100`.
- Doc note: percentage quorum/threshold values are on a **0–100 scale** (runtime evaluator
  divides by 100), matching v0.5.0's clarified quorum-mode semantics.

**Test plan:** against live v0.5.0 — run the fraud scenario with the unanimous template with
one specialist forced silent (kill one worker or use the wait-all deadline path): commit must
now be POLICY_DENIED (quorum unmet → coordinator cancels), whereas before it passed with one
voter. Then a normal all-vote run resolves.

**Definition of done:** both live behaviors observed and recorded in T6 item 5.

**Rollback:** single-value revert in one JSON file; the old value is lax, not wrong-on-the-wire,
so rollback carries no protocol risk (only restores the demo-quorum bug).

### T4 — Remove dead `sessionStart.context` plumbing (S/M)

**Files:** `src/contracts/launch.ts` (line 65), `src/contracts/example-agents.ts` (line 96),
`src/compiler/compiler.service.ts` (line 103), `src/hosting/contracts/bootstrap.types.ts`
(line 48), `src/hosting/process-example-agent-host.provider.ts` (line 204),
`docs/worker-bootstrap-contract.md`, `docs/api-reference.md` (line 234 — public compile
response example). Spec churn is minimal: no spec asserts `initiator.sessionStart.context`
(verified — `bootstrap-loader.spec.ts:82` fixture omits it;
`process-example-agent-host.provider.spec.ts:322` asserts `intent` only).

- Delete the `context` member from `InitiatorPayload.sessionStart` and
  `BootstrapPayload.initiator.session_start`; stop emitting it in compile and bootstrap
  construction. Rationale: the spec removed `SessionStartPayload.context` (bytes); the SDKs
  already ignore the field; carrying it invites someone to rely on it.
- **Do not touch** the consumed path: scenario `contextTemplate` → `scenarioMeta.sessionContext`
  (`compiler.service.ts:160`) → `metadata.session_context` (`provider:227`) →
  `risk-decider.worker.ts:27` / `PolicyStrategy`.

**Test plan:** `npm run build && npm test && npm run test:e2e` (compiler/launch/hosting specs
cover the compile output shape); one fullstack fraud run to confirm the initiator still
starts sessions (field was unused, so behavior must be identical).

**Risk:** external consumers of `POST /launch/compile` (UI console) might read
`initiator.sessionStart.context` — it is documented in the public API reference
(`docs/api-reference.md:234`). Check `macp-ui-console` before merging; if it reads the
field, deprecate (keep emitting + mark deprecated in the doc) for one release instead of
deleting.

**Definition of done:** field absent from types, compile output, bootstrap files, and both
docs; full local test matrix green; one fullstack fraud run resolves identically.

**Rollback:** revert the commit — the field is additive/unused on the wire, so re-adding it
is behavior-neutral.

### T5 — Documentation refresh (S)

**Files:** `docs/deployment.md`, `docs/policy-authoring.md`, `docs/direct-agent-auth.md`,
`docs/worker-bootstrap-contract.md`, `CLAUDE.md`.

- `deployment.md` §Required sidecars: local no-auth runtime now refuses to start without
  `MACP_ALLOW_INSECURE=1` (v0.5.0), and the published image no longer bakes it in; JWT algs
  default RS256/ES256 (HS256 needs `MACP_AUTH_JWT_ALGS=HS256` — we use RS256, don't opt in).
- `policy-authoring.md`: empty commitment `policy_version` now matches the bound policy
  (clients need not echo `policy.default`); percentage scale note (T3); read-only registry
  mode (T2); refresh the "proto 0.1.3 / SDK 0.4.0" version citation (line 145) and re-cite
  "macp-runtime PR #39" (line 151) as "macp-runtime v0.5.0" — the outcome-aware content
  itself stays accurate.
- `worker-bootstrap-contract.md`: drop `session_start.context` (T4); note `WatchSignals`
  consumers must authenticate (affects anyone pointing an observer at the runtime).
- `CLAUDE.md`: update the "proto 0.1.3 / SDK 0.4.0" citations in §Direct-agent-auth and the
  fullstack description once T1 lands.

### T6 — Acceptance verification against runtime v0.5.0 (M)

Not a code change — a recorded verification run gating this plan "absorbed" status:

1. Fullstack up with v0.5.0 image (T1).
2. Fraud majority-veto run → resolved with Commitment; worker logs show **no duplicate**
   Proposal/Evaluation deliveries (item 6).
3. Reject-majority run (BLOCK-heavy inputs) → decline **resolves** (no cancel fallback) —
   re-validates `plans/decision-negative-committed-outcomes.md` against the released build.
4. Suspend-sentinel run → SUSPENDED → RESUMED → resolved (control-plane observer still maps
   the six lifecycle states).
5. Unanimous-template run with a silent specialist → POLICY_DENIED → CANCELLED (T3).
6. `curl :9464/metrics` shows mode counters (T1).
7. Policies-dir variant boot (T2) → `managed_by_runtime` summary; run still resolves.

### T7 — SDK bumps (blocked upstream) (S here, after upstream ships)

**Files:** `package.json:40`, `package-lock.json`, `agents/requirements.txt:9`, Dockerfile
rebuild (no edit expected).

- Bump `macp-sdk-typescript` and `macp-sdk-python` to the first releases built on macp-proto
  ≥ 0.1.6 (not yet published as of this plan). Verify the transitive
  `@multiagentcoordinationprotocol/proto` entry in `package-lock.json` lands at ≥ 0.1.6.
- Re-run full test matrix; no API changes expected for existing surfaces (additive fields).

### T8 — `maxSuspendMs` demo plumbing (S/M, after T7)

**Files:** `src/contracts/registry.ts` (launch template types), `src/contracts/launch.ts`,
`src/contracts/example-agents.ts`, `src/compiler/compiler.service.ts`,
`src/hosting/contracts/bootstrap.types.ts`, `src/hosting/process-example-agent-host.provider.ts`,
one scenario template (e.g. `packs/fraud/.../templates/`), `docs/scenario-authoring.md`.

- Optional `maxSuspendMs` on scenario YAML `launch` → threaded exactly like `ttlMs` into
  `session_start.max_suspend_ms`. Requires the TS SDK's `session.start()` to accept it (check
  the SDK release notes; if absent, file upstream first).
- Demo: template with `maxSuspendMs: 15000` + suspend sentinel; document that holding past
  the cap expires the session against the bound cap (item 20).

**Test plan:** compile dry-run asserts the field lands in `initiator.sessionStart`; fullstack
run with hold < cap resolves; hold > cap demonstrates cap-driven expiry.

### T9 — Backlog (explicitly out of absorption scope)

- Task-mode scenario pack showcasing the external orchestrator (item 9).
- Multi-round scenario using proto `ContributePayload` (item 1) — only meaningful post-T7.
- Handoff scenario — must tolerate runtime-emitted synthetic accepts (item 17) and never set
  `implicit: true` (item 3).
- `ListSessions` pagination adoption if the playground ever grows a session-listing surface.

---

## 4. Sequencing

**Slice A — can land now (no upstream dependency):** merge order **T3 → T4 → T2 → T1 → T5**,
then T6 as the acceptance gate. Each of T3/T4/T2 is an independently mergeable PR (T3 and T4
have no ordering constraint between them); T2 must merge before T1 because T1's compose
carries the commented policies-dir variant that only makes sense with the hardened registrar;
T5 lands last so the docs describe the shipped state. Everything in Slice A works against
runtime v0.5.0 with the **current** SDK 0.4.1 (the runtime accepts 0.1.3-era payloads — the
new proto fields are additive and optional).

**Slice B — waits on upstream SDK releases** (macp-sdk-typescript > 0.4.1, macp-sdk-python
> 0.4.1, both on proto ≥ 0.1.6): T7 → T8. Neither exists on npm/PyPI as of 2026-07-05
(verified via `npm view` / `pip index`). Nothing in Slice A is blocked by this.

**Slice C — backlog:** T9 items, no timeline.

Cross-repo dependencies to watch (not this repo's work): `macp-control-plane` must absorb
WatchSignals auth + RESOURCE_EXHAUSTED lag semantics + six lifecycle states before the
fullstack harness is bumped (T1) — if the CP image predates that, T1's step 4 (suspend
lifecycle observation) may regress. Verify CP compatibility first or pin a CP release that
declares v0.5.0 support.

---

## 5. Risks

| # | Risk | Mitigation |
|---|------|-----------|
| R1 | v0.5.0 runtime behavior deltas surface mid-demo (stricter validation paths) | T6 acceptance matrix covers every flow the playground drives; rollback = revert image tag (T1 is one line) |
| R2 | Control-plane (0.1.3) incompatible with v0.5.0 watch-stream semantics | Check CP release notes before T1; fullstack harness is demo-only, staged rollout is trivial |
| R3 | UI console reads `initiator.sessionStart.context` (T4 deletion) | Pre-merge grep of `macp-ui-console`; deprecation fallback documented in T4 |
| R4 | T3 changes demo outcomes (unanimous template now genuinely requires full quorum) | That is the fix's purpose; note in release notes so demo scripts expecting the lax behavior are updated |
| R5 | SDK releases (Slice B) change `fromBootstrap` contract beyond additive fields | Bootstrap shape is SDK-owned (`docs/worker-bootstrap-contract.md:11-16`); review SDK changelogs at T7 |

---

## Revision log

- **Draft (2026-07-05):** initial plan from full repo walk: CLAUDE.md, README, package.json +
  lockfile, all three compose files, Dockerfile, `agents/`, `packs/`, `policies/`, `src/policy`,
  `src/compiler`, `src/hosting`, `src/example-agents/runtime`, `test/`, CI workflows, SDK dist
  inspection (macp-sdk-typescript 0.4.1), runtime ground truth (CHANGELOG, change-review doc,
  policy evaluator source), npm/PyPI version checks.
- **Pass 1 (completeness, 2026-07-05):** re-walked all 20 inventory items and re-grepped for
  runtime-facing surfaces (gRPC client constructions, `process.env`/`os.environ` reads,
  compose services, JSON payload construction, mode/policy registration, auth wiring).
  Findings added:
  - **Gap:** `docs/api-reference.md:234` documents `initiator.sessionStart.context` in the
    public `/launch/compile` response — item 19 / T4 upgraded from "internal cleanup" to
    "public API surface change"; file added to T4, risk R3 strengthened.
  - Confirmed only **one** `MacpClient` construction exists in app code
    (`policy-registrar.service.ts:53`); workers get clients exclusively via
    `fromBootstrap()` — no hidden gRPC surface.
  - Checked `packs/_shared/commitments/*.yaml`: `policyRef: policy.default` is playground
    display metadata (stripped from the runDescriptor), not a wire field — no impact.
  - Confirmed the SDK does **not** call `Initialize` implicitly (`dist/agent/participant.js`
    never invokes `client.initialize`), keeping item 12's roots-capability claim safe.
  - Env sweep found only playground-namespace `MACP_*` vars plus worker knobs
    (`RISK_DECIDER_*`) — no reads of runtime-side env names that changed in v0.5.0.
- **Pass 2 (adversarial verification, 2026-07-05):** re-read the code behind every file:line
  claim; re-verified dependency versions from `package-lock.json` (`macp-sdk-typescript`
  0.4.1, transitive `@multiagentcoordinationprotocol/proto` 0.1.3) and live registries
  (npm/PyPI latest = 0.4.1 for both SDKs). Corrections applied:
  - Item 2 cited `runner.js` for `emitInitiatorEnvelopes` — it lives in
    `dist/agent/participant.js:292-305`. Fixed.
  - `compiler.service.ts` line cites: `modeVersion` is line **100** (was 99),
    `policyVersion` line **102** (was 100). Fixed in items 8 and 11.
  - Fullstack `MACP_AUTH_JWKS_URL` is line **46** (was cited 47). Fixed.
  - `docs/policy-authoring.md` has exactly one "proto 0.1.3 / SDK 0.4.0" citation
    (line 145) — T5's claim of a second at line 258 was wrong; replaced with the
    "PR #39" re-cite at line 151.
  - `docs/worker-bootstrap-contract.md` SDK-ownership blockquote starts at line **11**
    (was cited 12-16). Fixed in R5.
  - Verified negative claims survived re-checking: no spec asserts
    `initiator.sessionStart.context` (checked `bootstrap-loader.spec.ts:82` fixture and
    `process-example-agent-host.provider.spec.ts:322`); `check_quorum` percentage math
    re-read at `macp-runtime crates/macp-policy/src/evaluator.rs:292-301` (divides voter
    ratio ×100, compares to `value`) — the `policy.fraud.unanimous.json` 1.0-means-1% claim
    stands.
- **Pass 3 (executability, 2026-07-05):** restructured for mergeability: explicit PR order
  for Slice A with the T2-before-T1 constraint justified; per-task **Definition of done**
  and **Rollback** notes added to T1–T4; expanded the riskiest change (T1, cross-repo
  control-plane exposure) into a staged pre-flight → runtime-alone → full-stack procedure
  with independent rollback of the metrics addition; moved the policies-dir compose variant
  concretely into T1 step 5 so T2's live test has a definite harness.
