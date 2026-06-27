# Architecture

> This page covers only the macp-playground internals (catalog, compiler,
> hosting). For the MACP runtime's own architecture — layer structure,
> request flow, durability model, and mode/policy registries — see the
> canonical doc:
> [`macp-runtime/docs/architecture.md`](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/architecture.md).
> For protocol-level concepts (sessions, modes, two-plane model) see the
> [protocol docs](https://www.multiagentcoordinationprotocol.io/docs).

## Overview

The MACP Playground is a single NestJS service that intentionally combines three responsibilities for demo simplicity:

1. **Catalog** — browse example scenario packs and their versions
2. **Compiler** — validate user inputs and compile them into two artifacts: a scenario-agnostic `RunDescriptor` for the control-plane and a scenario-specific payload (`scenarioSpec` + per-agent `AgentBootstrap`) for the agents themselves.
3. **Hosting** — resolve and bootstrap example agent bindings (manifest-only by default), populating each spawned agent's bootstrap file with a per-agent Bearer token and the runtime's gRPC address (RFC-MACP-0004 §4).

> This service is a showcase/examples layer used to demonstrate scenarios and sample agents for MACP. It intentionally combines catalog, compilation, and sample agent hosting for simplicity. It is not the production system boundary.

## Clean Demo Split

In a production deployment, these three things are separate:

| Concern | Demo (this service) | Production |
|---------|-------------------|------------|
| Scenario catalog | MACP Playground | Scenario Registry |
| Compilation | MACP Playground | Scenario Registry or Control Plane |
| Agent hosting | MACP Playground | Agent Platform / Runtime |
| Run lifecycle | Control Plane | Control Plane |
| Coordination | MACP Runtime | MACP Runtime |

## Module Structure

```
src/
  auth/              → AuthTokenMinterService (AUTH-2 JWT minting against auth-service)
  catalog/           → Pack/scenario listing + AgentProfileService (scenario coverage computation)
  compiler/          → Input validation (AJV) + template substitution + RunDescriptor + scenarioSpec assembly
  config/            → Environment-based configuration (global module; runtime gRPC address, TLS, auth-service URL)
  contracts/         → TypeScript interfaces — registry types, launch types, agent types
  controllers/       → REST endpoints (health, catalog, launch, examples, agents)
  dto/               → Swagger-annotated request/response DTOs
  errors/            → AppException, ErrorCode enum, GlobalExceptionFilter
  example-agents/    → Hard-coded example agent catalog (fraud, growth, compliance, risk)
    runtime/         → In-tree Node worker runtime for the custom Risk Agent:
                         bootstrap-loader, log-agent, policy-strategy,
                         risk-decider.worker (uses macp-sdk-typescript directly;
                         the SDK auto-binds the cancel-callback listener)
  hosting/           → Two-phase agent hosting (resolve + attach) + pluggable host providers
    adapters/        → Framework adapters (langgraph, langchain, crewai, custom)
                         + agent-env for convenience env vars
    contracts/       → AgentManifest, BootstrapPayload, AgentHostAdapter types
  launch/            → Launch schema generation + ExampleRunService (full showcase flow)
  middleware/        → Correlation ID + request logging + API key guard
  policy/            → PolicyLoaderService (reads policies/*.json) +
                         PolicyRegistrarService (registers policies with runtime at bootstrap)
  observability/     → Observer-invariant tests (prevents any HTTP write to deleted CP routes)
  registry/          → File-backed YAML loader + in-memory cache index
```

Note: `src/control-plane/` was removed during the direct-agent-auth rollout
(April 2026). The macp-playground no longer has a runtime dependency on the
control-plane's HTTP API — runs are initiated by spawning agents that connect
directly to the MACP runtime over gRPC.

Startup-time dependencies (both required to accept `/examples/run`):

- **auth-service** — every spawn mints a JWT via `POST /tokens`. Missing `MACP_AUTH_SERVICE_URL` fails startup with `INVALID_CONFIG`. See `docs/direct-agent-auth.md` § "AUTH-2".
- **MACP runtime** — `PolicyRegistrarService.onApplicationBootstrap()` mints an admin JWT and calls `MacpClient.registerPolicy()` for each non-default policy. When `MACP_RUNTIME_ADDRESS` is unset the registrar logs a warning and skips; when the mint fails it aborts with an ERROR and downstream runs fail `UNKNOWN_POLICY_VERSION`. See `docs/policy-authoring.md` § "Troubleshooting".

## Request Flow

```
HTTP Request
  → CorrelationIdMiddleware (X-Correlation-ID)
  → RequestLoggerMiddleware (timing/status)
  → Controller
    → Service
      → Registry / Compiler / Hosting
  → Response
  → GlobalExceptionFilter (catches errors)
```

## Key Flows

### 1. Browse Catalog

```
GET /packs             → CatalogService.listPacks() → RegistryIndexService → FileRegistryLoader → YAML files
GET /packs/:p/scenarios → CatalogService.listScenarios() → same path
GET /scenarios          → CatalogService.listAllScenarios() → scans all packs, adds packSlug to each
```

### 2. Get Launch Schema

```
GET /packs/:pack/scenarios/:scenario/versions/:version/launch-schema
  → LaunchService
    → Load scenario + optional template
    → Extract schema defaults, merge template defaults
    → Summarize participants with agent previews
    → Return form schema, defaults, runtime hints
```

### 3. Compile Scenario

```
POST /launch/compile
  → CompilerService
    → Parse scenarioRef (pack/scenario@version)
    → Load scenario + optional template
    → Merge defaults: schema < template < user inputs
    → Validate inputs against JSON Schema (AJV)
    → Substitute {{ inputs.* }} in context/metadata/kickoff/commitments templates
    → Pre-allocate sessionId (UUID v4) and build:
        runDescriptor      — scenario-agnostic payload sent to control-plane
        scenarioSpec       — internal bookkeeping (commitments, policyHints, kickoff)
        initiator          — SessionStart + kickoff payload for the one initiator agent
```

### 4. Run Example (Full Showcase Flow)

```
POST /examples/run
  → ExampleRunService
    1. Compile (same as above)
    2. Apply request overrides (tags, requester, runLabel) if provided
    3. Resolve agents → HostingService.resolve() → ProcessExampleAgentHostProvider
       → Inject transport identities into the scenarioSpec participants
    4. Attach agents → HostingService.attach() → Spawn Python/Node worker processes
       → Each agent's bootstrap carries its own auth_token + session_id;
         initiator's bootstrap also carries session_start + kickoff payload.
       → Agents open gRPC channels to the runtime directly (RFC-MACP-0004 §4);
         control-plane observes read-only (projection/SSE).
    5. Return compiled + hostedAgents + sessionId
```

### 5. Browse Agents

```
GET /agents
  → AgentProfileService.listProfiles()
    1. Load all definitions from ExampleAgentCatalogService.list()
    2. Scan registry: for each pack → scenario → participant, build agentRef → scenarioRef[] map
    3. Merge definition metadata with scenario coverage and metrics
    4. Return AgentProfileDto[]

GET /agents/:agentRef
  → AgentProfileService.getProfile(agentRef)
    → Same as above for a single agent (404 AGENT_NOT_FOUND if missing)
```

## Data Flow: Scenario Packs

```
packs/{pack-slug}/
  pack.yaml                              → PackFile (metadata)
  scenarios/{scenario-slug}/{version}/
    scenario.yaml                        → ScenarioVersionFile (inputs schema, launch config, runtime)
    templates/
      default.yaml                       → ScenarioTemplateFile (defaults + overrides)
      *.yaml                             → Additional template variants
```

Templates override scenario defaults and launch configuration. The merge precedence is:

```
schema defaults < template defaults < user inputs
```

## Agent Hosting Strategy

The example agents use an **active process-backed** hosting strategy with direct-agent-auth (RFC-MACP-0004 §4):

- Service resolves agent definitions from a hard-coded catalog (fraud, growth, compliance, risk)
- Transport identities are injected into the compiled `scenarioSpec` participants
- The macp-playground pre-allocates a UUID v4 `sessionId` at compile time and threads it into every agent bootstrap
- Lightweight Python and Node worker processes are spawned with per-agent bootstrap files (`MACP_BOOTSTRAP_FILE`)
- Workers read the bootstrap to obtain their own runtime gRPC address + Bearer token and open a dedicated gRPC channel via `macp-sdk` / `macp-sdk-typescript`
- Workers emit envelopes (Proposal / Evaluation / Vote / Commitment / Objection / SessionStart / cancellation) via the SDK mode-helpers directly to the runtime — the control-plane never writes on their behalf
- Each framework is demonstrated: LangGraph (fraud), LangChain (growth), CrewAI (compliance), custom Node (risk)
- The `InMemoryExampleAgentHostProvider` is available as a manifest-only fallback for environments without Python (test + dev only)

## Caching

`RegistryIndexService` caches the loaded registry snapshot with a configurable TTL:

- `REGISTRY_CACHE_TTL_MS=0` — reload from disk on every request (development)
- `REGISTRY_CACHE_TTL_MS=60000` — cache for 60 seconds (production)

Call `invalidate()` to force a reload.
