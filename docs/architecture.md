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
2. **Compiler** — validate user inputs and compile them into a `CompileLaunchResult`: a scenario-agnostic `RunDescriptor` (the only wire contract), an `initiator` payload for the one initiator agent, and playground-internal `scenarioMeta` (`policyHints`, `sessionContext`, `initiatorParticipantId`) that hosting threads into each agent's bootstrap. Shape: [`api-reference.md` § `POST /launch/compile`](api-reference.md#post-launchcompile).
3. **Hosting** — spawn real worker processes for each example agent binding (`ProcessExampleAgentHostProvider` is the bound provider in `app.module.ts`), each with a per-agent bootstrap file carrying its own Bearer token and the runtime's gRPC address ([RFC-MACP-0004](https://github.com/multiagentcoordinationprotocol/multiagentcoordinationprotocol/blob/main/rfcs/RFC-MACP-0004-security.md) §4). Bootstrap shape: [`worker-bootstrap-contract.md`](worker-bootstrap-contract.md).

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
  compiler/          → Input validation (AJV) + template substitution + RunDescriptor / initiator /
                         scenarioMeta assembly; extensions.ts (launch.extensions shape check)
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
  hosting/           → Two-phase agent hosting (resolve + attach) + pluggable host providers;
                         cancel-callback.ts allocates each agent's cancel-callback tuple
    adapters/        → Framework adapters (langgraph, langchain, crewai, custom)
                         + agent-env for convenience env vars
    contracts/       → AgentManifest, BootstrapPayload, AgentHostAdapter types
  launch/            → Launch schema generation + ExampleRunService (full showcase flow) +
                         ControlPlaneRunClient (optional, best-effort CP-1 POST /runs)
  middleware/        → Correlation ID + request logging + API key guard
  policy/            → PolicyLoaderService (reads policies/*.json, validates rules via
                         policy-rules-validator.ts) + PolicyRegistrarService (registers
                         policies with the runtime at bootstrap)
  registry/          → File-backed YAML loader (+ !include resolver) + in-memory cache index
  observer-invariant.spec.ts → Guardrail: fails if anything POSTs to the control-plane's
                         deleted write routes (/runs/:id/messages, signal, context)
```

Note: `src/control-plane/` was removed during the direct-agent-auth rollout
(April 2026). The macp-playground no longer *needs* the control-plane — runs
are initiated by spawning agents that connect directly to the MACP runtime
over gRPC. The only control-plane call left is the optional, best-effort CP-1
`POST /runs` observer registration, made only when `MACP_CONTROL_PLANE_URL` is
set; see [`direct-agent-auth.md` § CP-1 run registration](direct-agent-auth.md#cp-1-run-registration).

External dependencies (none is contacted at boot except as noted):

- **auth-service** — `MACP_AUTH_SERVICE_URL` must be *set* or startup fails with `INVALID_CONFIG`, but it is not contacted at boot. It is contacted when an agent is spawned (every uncached spawn mints a JWT, so `/examples/run` with bootstrapping returns `502 AUTH_MINT_FAILED` while it is down) and by the policy registrar below. See [`direct-agent-auth.md` § AUTH-2](direct-agent-auth.md#auth-2--on-demand-jwt-minting).
- **MACP runtime** — not needed to boot or to serve the catalog/compile routes. `PolicyRegistrarService.onApplicationBootstrap()` registers policies with it when `MACP_RUNTIME_ADDRESS` is set (and skips with a warning when it isn't); a failure there is logged, not fatal, but later runs then fail `UNKNOWN_POLICY_VERSION`. Spawned agents connect to it directly. See [`policy-authoring.md` § How Policies Are Registered](policy-authoring.md#how-policies-are-registered).

Env vars for all of the above: [`deployment.md` § Environment Variables](deployment.md#environment-variables).

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
    → Substitute {{ inputs.* }} in context/metadata/kickoff templates
    → Check launch.extensions shape (COMPILATION_ERROR on a non-string-map)
    → Pre-allocate sessionId (UUID v4) and build:
        runDescriptor      — scenario-agnostic wire payload (CP-1 POST /runs body)
        initiator          — SessionStart + kickoff payload for the one initiator agent
        scenarioMeta       — internal: policyHints, sessionContext, initiatorParticipantId
```

### 4. Run Example (Full Showcase Flow)

```
POST /examples/run
  → ExampleRunService
    1. Compile (same as above)
    2. Apply request overrides (tags, requester, runLabel) if provided
       (if bootstrapAgents resolves false: return { compiled, hostedAgents: [] } here)
    3. Resolve agents → HostingService.resolve() → ProcessExampleAgentHostProvider
       → Record hostedParticipants in runDescriptor.session.metadata
    4. Concurrently (Promise.allSettled):
       a. CP-1: ControlPlaneRunClient.submitRun(snapshot of runDescriptor)
          — only if MACP_CONTROL_PLANE_URL is set; failures are logged, never fatal
       b. Attach: HostingService.attach() → spawn worker processes one at a time,
          initiator first (only its SessionStart opens the session)
          → per spawn: mint JWT, write bootstrap file, spawn, confirm the process
            stayed up before moving on
          → agents open gRPC channels to the runtime directly (RFC-MACP-0004 §4)
    5. Any attached-mode agent not confirmed → 502 AGENT_ATTACH_FAILED
    6. Return compiled + hostedAgents + sessionId (+ controlPlaneRun if CP-1 succeeded)
```

### 5. Browse Agents

```
GET /agents
  → AgentProfileService.listProfiles()
    1. Load all definitions from ExampleAgentCatalogService.list()
    2. Scan registry: for each pack → scenario → participant, build agentRef → scenarioRef[] map
    3. Merge definition metadata with scenario coverage
    4. Return AgentProfileDto[]

GET /agents/:agentRef
  → AgentProfileService.getProfile(agentRef)
    → Same as above for a single agent (404 AGENT_NOT_FOUND if missing)
```

## Data Flow: Scenario Packs

Pack layout, `!include` and `_shared/` are documented in [`scenario-authoring.md`](scenario-authoring.md).

Templates override scenario defaults and launch configuration. The merge precedence is:

```
schema defaults < template defaults < user inputs
```

## Agent Hosting Strategy

The example agents use an **active process-backed** hosting strategy with direct-agent-auth (RFC-MACP-0004 §4):

- Service resolves agent definitions from a hard-coded catalog (fraud, growth, compliance, risk)
- Hosted-agent details (transport identity, status, pid, …) are recorded in `runDescriptor.session.metadata.hostedParticipants`
- The macp-playground pre-allocates a UUID v4 `sessionId` at compile time and threads it into every agent bootstrap
- Lightweight Python and Node worker processes are spawned with per-agent bootstrap files (`MACP_BOOTSTRAP_FILE`)
- Workers read the bootstrap to obtain their own runtime gRPC address + Bearer token and open a dedicated gRPC channel via `macp-sdk-python` / `macp-sdk-typescript` (shape: [`worker-bootstrap-contract.md`](worker-bootstrap-contract.md); minting: [`direct-agent-auth.md`](direct-agent-auth.md#auth-2--on-demand-jwt-minting))
- Workers emit envelopes (Proposal / Evaluation / Vote / Commitment / Objection / SessionStart / cancellation) via the SDK mode-helpers directly to the runtime — the control-plane never writes on their behalf
- Each framework is demonstrated: LangGraph (fraud), LangChain (growth), CrewAI (compliance), custom Node (risk)
- `InMemoryExampleAgentHostProvider` is a manifest-only provider that spawns nothing; it is not bound in `app.module.ts` and is used only by unit tests

## Caching

`RegistryIndexService` caches the loaded registry snapshot with a configurable TTL:

- `REGISTRY_CACHE_TTL_MS=0` — reload from disk on every request (development)
- `REGISTRY_CACHE_TTL_MS=60000` — cache for 60 seconds (production)

Call `invalidate()` to force a reload.
