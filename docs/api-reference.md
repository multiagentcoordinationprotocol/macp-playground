# API Reference

All endpoints return JSON. Error responses follow the format:

```json
{
  "statusCode": 400,
  "errorCode": "VALIDATION_ERROR",
  "message": "Input validation failed",
  "metadata": { ... }
}
```

`metadata` is **omitted entirely** when the error carries none (`src/errors/app-exception.ts`) — it is not emitted as `null` or `{}`. `statusCode`, `errorCode` and `message` are always present on errors raised by the service itself (`AppException`). Errors raised by Nest's own machinery before a handler runs keep Nest's shape instead — see [Error codes](#error-codes).

Authentication is optional. When `AUTH_API_KEYS` is configured, pass a valid key via the `x-api-key` header. The guard is global, so this includes `GET /healthz`. A missing or wrong key returns `401` in Nest's shape (`{ "statusCode": 401, "message": "Invalid or missing API key", "error": "Unauthorized" }`, no `errorCode`).

Rate limiting is global: 100 requests per 60 s per client (`@nestjs/throttler`). Excess requests return `429`.

## Health

### `GET /healthz`

Liveness probe.

**Response:** `200`
```json
{ "ok": true, "service": "macp-playground" }
```

## Catalog

### `GET /packs`

List all available scenario packs.

**Response:** `200`
```json
[
  {
    "slug": "fraud",
    "name": "Fraud",
    "description": "Fraud and risk decisioning demos",
    "tags": ["fraud", "risk", "growth", "demo"]
  }
]
```

### `GET /packs/:packSlug/scenarios`

List scenarios in a pack with versions, templates, and agent refs.

**Response:** `200`
```json
[
  {
    "scenario": "high-value-new-device",
    "name": "High Value Purchase From New Device",
    "summary": "Fraud Agent, Growth Agent, and Risk Agent discuss a transaction and produce a decision.",
    "versions": ["1.0.0"],
    "templates": ["default", "strict-risk"],
    "tags": ["fraud", "growth", "risk", "demo"],
    "runtimeKind": "rust",
    "agentRefs": ["fraud-agent", "growth-agent", "compliance-agent", "risk-agent"]
  }
]
```

**Errors:** `404 PACK_NOT_FOUND`

### `GET /scenarios`

List all scenarios across all packs. Each entry includes a `packSlug` field identifying its parent pack.

**Response:** `200`
```json
[
  {
    "packSlug": "fraud",
    "scenario": "high-value-new-device",
    "name": "High Value Purchase From New Device",
    "summary": "...",
    "versions": ["1.0.0"],
    "templates": ["default", "strict-risk"],
    "tags": ["fraud", "growth", "risk", "demo"],
    "runtimeKind": "rust",
    "agentRefs": ["fraud-agent", "growth-agent", "compliance-agent", "risk-agent"]
  },
  {
    "packSlug": "lending",
    "scenario": "loan-underwriting",
    "name": "Loan Underwriting Review",
    "versions": ["1.0.0"],
    "templates": ["default"],
    "agentRefs": ["fraud-agent", "growth-agent", "compliance-agent", "risk-agent"]
  }
]
```

## Agents

### `GET /agents`

List all agent profiles with scenario coverage.

**Response:** `200`
```json
[
  {
    "agentRef": "fraud-agent",
    "name": "Fraud Agent",
    "role": "fraud",
    "framework": "langgraph",
    "description": "Evaluates device, chargeback, and identity-risk signals using a LangGraph graph.",
    "transportIdentity": "agent://fraud-agent",
    "entrypoint": "agents/langgraph_worker/main.py",
    "bootstrapStrategy": "external",
    "bootstrapMode": "attached",
    "tags": ["fraud", "langgraph", "risk"],
    "scenarios": [
      "fraud/high-value-new-device@1.0.0",
      "lending/loan-underwriting@1.0.0",
      "claims/auto-claim-review@1.0.0"
    ]
  }
]
```

The `scenarios` array is computed by scanning all packs in the registry for participant references to this agent. There is no `metrics` field — the playground keeps no run statistics (`src/catalog/agent-profile.service.ts`).

### `GET /agents/:agentRef`

Get a single agent profile by ref.

**Response:** `200` — same shape as a single entry from `GET /agents`.

**Errors:** `404 AGENT_NOT_FOUND`

## Launch

### `GET /packs/:packSlug/scenarios/:scenarioSlug/versions/:version/launch-schema`

Get the launch form schema, defaults, agent previews, and runtime hints.

**Query params:**
- `template` (optional) — template slug to apply

**Response:** `200`
```json
{
  "scenarioRef": "fraud/high-value-new-device@1.0.0",
  "templateId": "default",
  "formSchema": { "type": "object", "properties": { ... } },
  "defaults": { "transactionAmount": 2400, "deviceTrustScore": 0.18 },
  "participants": [
    { "id": "fraud-agent", "role": "fraud", "agentRef": "fraud-agent" }
  ],
  "agents": [
    {
      "agentRef": "fraud-agent",
      "name": "Fraud Agent",
      "role": "fraud",
      "framework": "langgraph",
      "description": "Evaluates device, chargeback, and identity-risk signals using a LangGraph graph.",
      "transportIdentity": "agent://fraud-agent",
      "entrypoint": "agents/langgraph_worker/main.py",
      "bootstrapStrategy": "external",
      "bootstrapMode": "attached",
      "tags": ["fraud", "langgraph", "risk"]
    }
  ],
  "runtime": { "kind": "rust", "version": "v1" },
  "launchSummary": {
    "modeName": "macp.mode.decision.v1",
    "modeVersion": "1.0.0",
    "configurationVersion": "config.default",
    "policyVersion": "policy.default",
    "ttlMs": 300000,
    "initiatorParticipantId": "risk-agent"
  },
  "expectedDecisionKinds": ["approve", "step_up", "decline"]
}
```

**Errors:** `404 PACK_NOT_FOUND | SCENARIO_NOT_FOUND | VERSION_NOT_FOUND | TEMPLATE_NOT_FOUND`

### `POST /launch/compile`

Validate user inputs and compile them into a `CompileLaunchResult`
(`src/contracts/launch.ts`):

- `runDescriptor` — the scenario-agnostic payload; the only wire contract (the
  body of the optional CP-1 `POST /runs`, see
  [`macp-control-plane/docs/API.md`](https://github.com/multiagentcoordinationprotocol/macp-control-plane/blob/main/docs/API.md#post-runs)).
- `initiator` — `sessionStart` + `kickoff` for the one initiator agent; present
  only when the scenario has an identifiable initiator.
- `sessionId` — pre-allocated UUID v4, also in `runDescriptor.session.sessionId`.
- `mode` — the requested execution mode (`sandbox` by default).
- `scenarioMeta` — playground-internal metadata threaded into agent bootstraps
  (`policyHints`, `sessionContext`, `initiatorParticipantId`); never sent to the
  control plane or runtime.
- `display` and `participantBindings` — UI metadata and the participant → agent map.

There is no `executionRequest`; it was removed.

**Request body:**
```json
{
  "scenarioRef": "fraud/high-value-new-device@1.0.0",
  "templateId": "default",
  "mode": "sandbox",
  "inputs": {
    "transactionAmount": 3200,
    "deviceTrustScore": 0.12,
    "accountAgeDays": 5,
    "isVipCustomer": true,
    "priorChargebacks": 1
  }
}
```

**Response:** `201`
```json
{
  "sessionId": "7c7a8f4d-0d4d-4f2b-8a9e-1f3a6b2e0c11",
  "mode": "sandbox",
  "runDescriptor": {
    "mode": "sandbox",
    "runtime": { "kind": "rust", "version": "v1" },
    "session": {
      "sessionId": "7c7a8f4d-0d4d-4f2b-8a9e-1f3a6b2e0c11",
      "modeName": "macp.mode.decision.v1",
      "modeVersion": "1.0.0",
      "configurationVersion": "config.default",
      "policyVersion": "policy.default",
      "ttlMs": 300000,
      "participants": [{ "id": "fraud-agent" }, { "id": "risk-agent" }],
      "metadata": {
        "source": "macp-playground",
        "sourceRef": "fraud/high-value-new-device@1.0.0",
        "scenarioRef": "fraud/high-value-new-device@1.0.0",
        "templateId": "default",
        "environment": "development"
      }
    },
    "execution": {
      "tags": ["example", "fraud", "high-value-new-device"],
      "requester": { "actorId": "macp-playground", "actorType": "service" }
    }
  },
  "initiator": {
    "participantId": "risk-agent",
    "sessionStart": { "intent": "...", "participants": ["fraud-agent","risk-agent"], "ttlMs": 300000, "modeVersion": "1.0.0", "configurationVersion": "config.default", "policyVersion": "policy.default" },
    "kickoff": { "messageType": "Proposal", "payloadType": "macp.modes.decision.v1.ProposalPayload", "payload": { "option": "review" } }
  },
  "scenarioMeta": {
    "policyHints": { "type": "majority", "threshold": 0.5 },
    "sessionContext": { "transactionAmount": 3200, "deviceTrustScore": 0.12 },
    "initiatorParticipantId": "risk-agent"
  },
  "display": {
    "title": "High Value Purchase From New Device",
    "scenarioRef": "fraud/high-value-new-device@1.0.0",
    "templateId": "default",
    "expectedDecisionKinds": ["approve", "step_up", "decline"]
  },
  "participantBindings": [
    { "participantId": "fraud-agent", "role": "fraud", "agentRef": "fraud-agent" }
  ]
}
```

A scenario's `launch.commitments` block is **not** part of the compile output — it is
parsed and checked by `scenario:validate` / `scenario:lint`, but nothing emits it to the control plane or
the runtime. Likewise `launch.kickoffTemplate` surfaces only as `initiator.kickoff`
(its first entry).

**Errors:**

- `400 VALIDATION_ERROR` — inputs fail the scenario's JSON Schema; `metadata.errors` carries the ajv errors.
- `400 COMPILATION_ERROR` — an undefined `{{ inputs.* }}` placeholder, or a `launch.extensions` value that is not a map of strings (`src/compiler/extensions.ts`).
- `400 INVALID_SCENARIO_REF`
- `404 PACK_NOT_FOUND | SCENARIO_NOT_FOUND | VERSION_NOT_FOUND | TEMPLATE_NOT_FOUND`
- `500 INVALID_PACK_DATA` — a pack file on disk is malformed.

A malformed request body (e.g. missing `scenarioRef`, or `mode` not `live`/`sandbox`) is a Nest `400` without `errorCode` — see [Error codes](#error-codes).

## Examples

### `POST /examples/run`

Full showcase flow: compile scenario, bootstrap example agents, and (if `MACP_CONTROL_PLANE_URL` is
configured) submit the run to the control plane (CP-1). See
[`docs/direct-agent-auth.md` § "CP-1 run registration"](direct-agent-auth.md#cp-1-run-registration)
for the full design — there is no per-request toggle for this; it's controlled entirely by
whether `MACP_CONTROL_PLANE_URL` is set at deploy time.

**Request body:**
```json
{
  "scenarioRef": "fraud/high-value-new-device@1.0.0",
  "templateId": "strict-risk",
  "mode": "sandbox",
  "inputs": { "transactionAmount": 3200 },
  "bootstrapAgents": true,
  "tags": ["ui-launch", "experiment-42"],
  "requester": { "actorId": "user@example.com", "actorType": "user" },
  "runLabel": "My test run"
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `scenarioRef` | string | _(required)_ | `pack/scenario@version` format |
| `templateId` | string | _(none)_ | Template slug to apply |
| `mode` | `live` \| `sandbox` | `sandbox` | Execution mode |
| `inputs` | object | _(required)_ | User inputs, validated against scenario JSON Schema |
| `bootstrapAgents` | boolean | `AUTO_BOOTSTRAP_EXAMPLE_AGENTS` | Resolve and bootstrap example agent bindings. When `false`, the response is just `{ compiled, hostedAgents: [] }` — no agents are spawned, no JWTs are minted, no top-level `sessionId`, and the control plane is not called. |
| `tags` | string[] | _(none)_ | Additional tags merged into `execution.tags` |
| `requester` | object | _(none)_ | Override `execution.requester` with `{ actorId, actorType }` |
| `runLabel` | string | _(none)_ | Human-readable label stored in `runDescriptor.session.metadata.runLabel` |

Unknown body fields are silently dropped (`ValidationPipe` with `whitelist: true`), so
e.g. a `submitToControlPlane` flag has no effect.

When bootstrapping, agents are spawned **sequentially, initiator first** (only the
initiator's `SessionStart` opens the session — `src/hosting/hosting.service.ts`), and each
spawn is confirmed before the next starts. The CP-1 submission runs concurrently with the
spawns. `hostedAgents` is still returned in scenario-declaration order.

**Response:** `201`
```json
{
  "compiled": { "sessionId": "...", "mode": "sandbox", "runDescriptor": { ... }, "initiator": { ... }, "scenarioMeta": { ... }, "display": { ... }, "participantBindings": [ ... ] },
  "hostedAgents": [
    {
      "participantId": "fraud-agent",
      "agentRef": "fraud-agent",
      "name": "Fraud Agent",
      "role": "fraud",
      "framework": "langgraph",
      "description": "Evaluates device, chargeback, and identity-risk signals using a LangGraph graph.",
      "transportIdentity": "agent://fraud-agent",
      "entrypoint": "agents/langgraph_worker/main.py",
      "bootstrapStrategy": "external",
      "bootstrapMode": "attached",
      "status": "bootstrapped",
      "participantMetadata": { "processAttached": true, "pid": 41237, "launchMode": "adapter", "adapterFramework": "langgraph" }
    }
  ],
  "sessionId": "7c7a8f4d-0d4d-4f2b-8a9e-1f3a6b2e0c11",
  "controlPlaneRun": {
    "runId": "run_01hx...",
    "sessionId": "7c7a8f4d-0d4d-4f2b-8a9e-1f3a6b2e0c11",
    "status": "queued",
    "traceId": "trace_01hx..."
  }
}
```

`controlPlaneRun` is present **only** when `MACP_CONTROL_PLANE_URL` is configured and the
`POST /runs` submission succeeded; it is absent (not `null` — the key is simply omitted) when
the control plane is unconfigured, unreachable, times out, or rejects the request. Agent
bootstrap and the HTTP response's own success are entirely unaffected either way — a
control-plane failure never turns a successful run into an error response.

**Errors:** everything `POST /launch/compile` can return, plus `404 AGENT_NOT_FOUND`
(a participant's `agentRef` is not in the example-agent catalog), `502 AUTH_MINT_FAILED`,
`502 AGENT_ATTACH_FAILED`, `500 INVALID_CONFIG`.

- `AUTH_MINT_FAILED` — the per-agent JWT mint against the auth-service failed (network
  error, timeout, non-2xx, or no token in the body). There is no fallback; see
  [`direct-agent-auth.md` § AUTH-2](direct-agent-auth.md#auth-2--on-demand-jwt-minting).
- `AGENT_ATTACH_FAILED` — an agent with `bootstrapMode: "attached"` failed manifest
  validation, failed to spawn, or exited before attach was confirmed
  (`src/launch/example-run.service.ts`). `metadata` carries `sessionId` and
  `failedParticipants`. Agents in `mock` / `deferred` mode report `status: "bootstrapped"` with
  `processAttached: false` by design and never trigger it.
- `INVALID_CONFIG` — no host adapter or manifest for an agent's framework. (A missing
  `MACP_AUTH_SERVICE_URL` also raises it, but at startup — see [`deployment.md`](deployment.md).)

## Error codes

Every error the service raises itself is an `AppException` with the JSON shape at the
top of this page. Codes are defined in `src/errors/error-codes.ts`.

| Code | HTTP | When |
|------|------|------|
| `PACK_NOT_FOUND` | 404 | Pack slug doesn't exist |
| `SCENARIO_NOT_FOUND` | 404 | Scenario slug doesn't exist in the pack |
| `VERSION_NOT_FOUND` | 404 | Version doesn't exist for the scenario |
| `TEMPLATE_NOT_FOUND` | 404 | Template slug doesn't exist for the version |
| `AGENT_NOT_FOUND` | 404 | `agentRef` not in the example-agent catalog |
| `INVALID_SCENARIO_REF` | 400 | `scenarioRef` not in `pack/scenario@version` form |
| `VALIDATION_ERROR` | 400 | Inputs fail the scenario's JSON Schema |
| `COMPILATION_ERROR` | 400 | Undefined template placeholder, or malformed `launch.extensions` |
| `INVALID_PACK_DATA` | 500 | A pack file on disk is malformed (bad `apiVersion`/`kind`/`metadata.slug`, bad `!include`). A server-side fault, so 500 — not 400 |
| `INVALID_CONFIG` | 500 | Service misconfiguration (startup, or missing adapter/manifest at request time) |
| `AUTH_MINT_FAILED` | 502 | Auth-service mint failed; no fallback |
| `AGENT_ATTACH_FAILED` | 502 | An `attached`-mode agent failed to spawn or stay up |
| `INTERNAL_ERROR` | 500 | Unhandled exception |

`POLICY_NOT_FOUND`, `POLICY_REGISTRATION_FAILED` and `SESSION_ALREADY_EXISTS` exist in the
enum but nothing throws them; no endpoint returns them today.

**Errors without an `errorCode`.** Exceptions raised by Nest itself before a handler runs
pass through `GlobalExceptionFilter` unchanged (`src/errors/exception.filter.ts`), so they
keep Nest's shape:

- Request-body DTO validation (`ValidationPipe`): `400` with `message` as an array of
  strings and `"error": "Bad Request"`.
- API key guard: `401` with `"error": "Unauthorized"`.
- Rate limit: `429`, which — because the throttler's response is a plain string — is
  emitted as `{ "statusCode": 429, "errorCode": "INTERNAL_ERROR", "message": "ThrottlerException: Too Many Requests" }`.

## Swagger UI

Available at `GET /docs` when `NODE_ENV=development`.
