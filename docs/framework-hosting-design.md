# Framework Hosting Design

## Overview

The MACP Playground uses a **framework-neutral hosting architecture** that allows heterogeneous agent frameworks (LangGraph, LangChain, CrewAI, custom) to participate in the same MACP run through a unified control-plane contract.

## Architecture

```
Service bootstrap (once per process):
  → PolicyRegistrarService.onApplicationBootstrap()
     → AuthTokenMinterService.mintToken("macp-playground", {can_manage_mode_registry})
     → MacpClient.registerPolicy(...) for each non-default policy

Per-run:
POST /examples/run
  → CompilerService.compile()              [framework-agnostic]
  → applyRequestOverrides(tags/requester)  [merge UI-provided fields]
  → HostingService.resolve()               [materializes agent metadata]
  → HostingService.attach()                [launches framework workers]
    → ProcessExampleAgentHostProvider
      → HostAdapterRegistry.get(framework)
      → ManifestValidator.validate(manifest)
      → AuthTokenMinterService.mintToken(sender, deriveScopes(...))
      → AgentHostAdapter.prepareLaunch()
      → LaunchSupervisor.writeBootstrapFile(BootstrapPayload) → /tmp/*.json
      → LaunchSupervisor.launch()          [spawns process with MACP_BOOTSTRAP_FILE env]
```

With direct-agent-auth (RFC-MACP-0004 §4), the macp-playground is no longer
in the envelope path. Each spawned agent opens its own authenticated gRPC
channel to the runtime using `bootstrap.auth_token`; the control-plane stays
in observer-only mode (read-only projection + SSE). Policies must be
registered with the runtime *before* the first run — that's why the
registrar runs at `onApplicationBootstrap` rather than per-request.

## Key Boundaries

### Compiler stays framework-agnostic

The compiler produces `ExecutionRequest` payloads with participants, runtime metadata, kickoff messages, and policy. It never references LangGraph, LangChain, or CrewAI.

### Hosting layer owns framework integration

All framework-specific launch logic lives in `src/hosting/adapters/`. Each adapter implements `AgentHostAdapter`:

```typescript
interface AgentHostAdapter {
  readonly framework: AgentFramework;
  validateManifest(manifest: AgentManifest): ManifestValidationResult;
  prepareLaunch(input: PrepareLaunchInput): PreparedLaunch;
}
```

### Runtime is the only message ingress/egress

Workers communicate exclusively with the MACP runtime over authenticated
gRPC — the control-plane never writes on an agent's behalf.
- Subscribe to the session via the runtime's bidirectional stream.
- Emit `Proposal` / `Evaluation` / `Vote` / `Commitment` / `Objection` / etc.
  through the SDK mode-helpers (`DecisionSession.vote()`, `.commit()`, …).
- Receive history replay + live envelopes on stream open (RFC-MACP-0006 §3.2 passive subscribe),
  so agent spawn order is irrelevant.

### Bootstrap contract

Every worker receives a flat `BootstrapPayload` via a temp JSON file
(`MACP_BOOTSTRAP_FILE`). Shape matches what both `macp_sdk` (Python) and
`macp-sdk-typescript` expect in their `fromBootstrap()` functions. For
the authoritative reference of the shape and its fields, see the SDK
agent-framework guides linked below and
[`docs/worker-bootstrap-contract.md`](worker-bootstrap-contract.md). The
example below shows the macp-playground additions
(`metadata.policy_hints`, `metadata.session_context`, etc.):

```json
{
  "participant_id": "risk-agent",
  "session_id": "7f3d....-....",
  "mode": "macp.mode.decision.v1",
  "runtime_url": "runtime.local:50051",
  "auth_token": "per-agent bearer",
  "secure": true,
  "allow_insecure": false,
  "participants": ["fraud-agent", "growth-agent", "compliance-agent", "risk-agent"],
  "mode_version": "1.0.0",
  "configuration_version": "config.default",
  "policy_version": "policy.fraud.majority-veto",
  "initiator": { "session_start": { ... }, "kickoff": { ... } },
  "cancel_callback": { "host": "127.0.0.1", "port": 9123, "path": "/agent/cancel" },
  "metadata": {
    "run_id": "run-abc",
    "trace_id": "trace-xyz",
    "scenario_ref": "fraud/high-value-new-device@1.0.0",
    "role": "coordinator",
    "framework": "custom",
    "agent_ref": "risk-agent",
    "policy_hints": { "type": "majority", "vetoEnabled": true, "vetoThreshold": 1 },
    "session_context": { "transactionAmount": 3200 }
  }
}
```

`initiator` is present on exactly one bootstrap per run — the initiator agent
emits `SessionStart` + the first mode-specific envelope (e.g. `Proposal`).

## Component Map

| Component | Path | Purpose |
|-----------|------|---------|
| Host Adapter Interface | `src/hosting/contracts/host-adapter.types.ts` | Framework adapter contract |
| Manifest Types | `src/hosting/contracts/manifest.types.ts` | Typed manifest schema |
| Bootstrap Types | `src/hosting/contracts/bootstrap.types.ts` | Bootstrap payload contract |
| LangGraph Adapter | `src/hosting/adapters/langgraph-host-adapter.ts` | LangGraph manifest validation + launch prep |
| LangChain Adapter | `src/hosting/adapters/langchain-host-adapter.ts` | LangChain manifest validation + launch prep |
| CrewAI Adapter | `src/hosting/adapters/crewai-host-adapter.ts` | CrewAI manifest validation + launch prep |
| Custom Adapter | `src/hosting/adapters/custom-host-adapter.ts` | Node/Python custom worker support |
| Adapter Registry | `src/hosting/host-adapter-registry.ts` | Maps framework → adapter |
| Manifest Validator | `src/hosting/manifest-validator.ts` | Pre-spawn validation |
| Launch Supervisor | `src/hosting/launch-supervisor.ts` | Process lifecycle management |
| Hosting Service | `src/hosting/hosting.service.ts` | Two-phase resolve + attach orchestration |
| Agent Profile Service | `src/catalog/agent-profile.service.ts` | Builds agent profiles with registry-scanned scenario coverage |
| Agent Catalog | `src/example-agents/example-agent-catalog.service.ts` | Hard-coded agent definitions (4 agents) |
| Python Agent SDK | upstream `macp_sdk` (PyPI) | Python workers call `macp_sdk.agent.from_bootstrap()` directly — no local worker SDK in this repo. Handlers receive the same `ctx.actions` surface (`evaluate`, `vote`, `commit`, etc.) as the TS SDK. |
| Node Worker Runtime | `src/example-agents/runtime/` | In-tree TS modules for the custom (Node) Risk Agent: `bootstrap-loader.ts`, `log-agent.ts`, `policy-strategy.ts`, and `risk-decider.worker.ts`. Runtime IO uses `macp-sdk-typescript` directly. Cancel-callback delivery is owned by the SDK (`fromBootstrap()` auto-binds the listener). |
| Policy Strategy | `src/example-agents/runtime/policy-strategy.ts` | Policy-aware decision logic for the coordinator (quorum, voting, veto, confidence filtering, designated-role commitment authority) |
| Policy Registrar | `src/policy/policy-registrar.service.ts` | Mints an admin JWT (`can_manage_mode_registry`) at service bootstrap and registers every non-default policy with the runtime via `MacpClient.registerPolicy()`. |
| Auth Minter | `src/auth/auth-token-minter.service.ts` | On-demand JWT minting against the standalone auth-service (`POST /tokens`). Single-flight cache keyed by `(sender, scope-hash)`. See `docs/direct-agent-auth.md`. |

## Framework Workers

| Agent | Framework | Worker Path | Manifest |
|-------|-----------|-------------|----------|
| Fraud Agent | LangGraph | `agents/langgraph_worker/` | `agents/manifests/fraud-agent.json` |
| Growth Agent | LangChain | `agents/langchain_worker/` | `agents/manifests/growth-agent.json` |
| Compliance Agent | CrewAI | `agents/crewai_worker/` | `agents/manifests/compliance-agent.json` |
| Risk Agent | Custom (Node) | `src/example-agents/runtime/risk-decider.worker.ts` | `agents/manifests/risk-agent.json` |

Each worker gracefully falls back when its framework library is not installed, preserving the same MACP message contract.

## SDK Participant Abstraction

All workers — Python and Node — share the same conceptual `Participant`
surface, provided by the respective upstream SDK:

| Language | Entry point | Canonical docs |
|----------|-------------|----------------|
| Python   | `macp_sdk.agent.from_bootstrap()` | [`macp-sdk-python/docs/guides/agent-framework.md`](https://github.com/multiagentcoordinationprotocol/macp-sdk-python/blob/main/docs/guides/agent-framework.md) |
| Node     | `agent.fromBootstrap()` from `macp-sdk-typescript` | [`macp-sdk-typescript/docs/guides/agent-framework.md`](https://github.com/multiagentcoordinationprotocol/macp-sdk-typescript/blob/main/docs/guides/agent-framework.md) |

Those guides own the handler-registration API, the `ctx.actions` surface
per mode, the gRPC event loop, cancel-callback auto-binding, strategies,
and terminal-notification semantics. The macp-playground **does not
redocument** any of that — if you're wiring a new worker, read the SDK
docs first.

The risk-agent coordinator is the one place the macp-playground adds
its own logic on top of the SDK Participant: it uses a local
**PolicyStrategy** (`createPolicyStrategy(policyHints)`) for
policy-driven:
- **Quorum**: `unanimous` waits for all; `majority`/`supermajority` needs threshold; `none` needs ≥1 response
- **Voting**: Approval rate vs threshold, with veto-blocking objections when `vetoEnabled` (configurable `vetoThreshold` per RFC-MACP-0012)
- **Confidence filtering**: Evaluations below `minimumConfidence` are disqualified from voting
- **Decision**: Maps signals to `approve` / `step_up` / `decline`
- **Commitment**: Includes `designatedRoles` for commitment authority tracking

## Policy Flow

```
Startup (once per macp-playground process):
  policies/*.json → PolicyLoaderService
    → PolicyRegistrarService.onApplicationBootstrap()
    → MacpClient.registerPolicy() for each non-default policy (runtime gRPC)

Per-run:
  scenario.yaml (policyVersion + policyHints)
    → template override (optional)
    → CompilerService → scenarioSpec.session.policyHints (internal bookkeeping)
    → BootstrapPayload.metadata.policy_hints (threaded into every agent bootstrap)
    → Worker reads policy_hints → PolicyStrategy.decide()
```

Note: `policyHints` do NOT travel to the control-plane. They live entirely
in the scenario layer (macp-playground) and are consumed by agent workers
via their bootstrap file. Only `policy_version` (the id) is looked up by the
runtime against the registrations performed at startup — that lookup is why
registration must complete before the first run. See `direct-agent-auth.md`
for the full flow and `policy-authoring.md` for the JSON schema.
