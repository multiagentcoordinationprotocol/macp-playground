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

Authentication is optional. When `AUTH_API_KEYS` is configured, pass a valid key via the `x-api-key` header.

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

List all agent profiles with scenario coverage and metrics.

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
    ],
    "metrics": {
      "runs": 0,
      "signals": 0,
      "averageLatencyMs": 0,
      "averageConfidence": 0
    }
  }
]
```

The `scenarios` array is computed by scanning all packs in the registry for participant references to this agent. The `metrics` object is best-effort; values are zero when the control plane is unavailable.

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

**Errors:** `404 SCENARIO_NOT_FOUND | VERSION_NOT_FOUND | TEMPLATE_NOT_FOUND`

### `POST /launch/compile`

Validate user inputs and produce the twin outputs needed to run the scenario:
`runDescriptor` (the scenario-agnostic payload sent to the control-plane),
`executionRequest` (scenario-layer bookkeeping retained for agent bootstraps),
`initiator` (SessionStart + kickoff for the one initiator agent), and the
pre-allocated `sessionId` (UUID v4).

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
      "metadata": { "source": "example-service", "scenarioRef": "fraud/high-value-new-device@1.0.0" }
    },
    "execution": { "tags": ["example","fraud"], "requester": { "actorId": "example-service", "actorType": "service" } }
  },
  "initiator": {
    "participantId": "risk-agent",
    "sessionStart": { "intent": "...", "participants": ["fraud-agent","risk-agent"], "ttlMs": 300000, "modeVersion": "1.0.0", "configurationVersion": "config.default", "policyVersion": "policy.default", "context": { "transactionAmount": 3200 } },
    "kickoff": { "messageType": "Proposal", "payload": { "option": "review" } }
  },
  "executionRequest": {
    "mode": "sandbox",
    "runtime": { "kind": "rust", "version": "v1" },
    "session": {
      "modeName": "macp.mode.decision.v1",
      "policyVersion": "policy.default",
      "policyHints": { "type": "majority", "threshold": 0.5 },
      "participants": [ /* scenario-layer detail, incl. role, metadata */ ],
      "commitments": [
        {
          "id": "fraud-risk-assessed",
          "title": "Fraud risk assessed",
          "description": "Fraud specialist has evaluated transaction signals and recorded a risk verdict.",
          "requiredRoles": ["fraud"],
          "policyRef": "policy.default"
        },
        {
          "id": "decision-finalized",
          "title": "Decision finalized",
          "requiredRoles": ["risk"]
        }
      ]
    },
    "kickoff": [ /* ... */ ]
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

`session.commitments[]` — optional commitment definitions declared by the scenario. Each entry: `{ id, title, description?, requiredRoles?, policyRef? }`. The control plane uses these to populate `PolicyProjection.expectedCommitments` at `binding_session` time so UIs can render the expected commitment list before the first evaluation fires. Scenarios without commitments omit the field entirely.

**Errors:** `400 VALIDATION_ERROR | INVALID_SCENARIO_REF`, `404 SCENARIO_NOT_FOUND | VERSION_NOT_FOUND | TEMPLATE_NOT_FOUND`

## Examples

### `POST /examples/run`

Full showcase flow: compile scenario, bootstrap example agents, and optionally submit to the control plane.

**Request body:**
```json
{
  "scenarioRef": "fraud/high-value-new-device@1.0.0",
  "templateId": "strict-risk",
  "mode": "sandbox",
  "inputs": { "transactionAmount": 3200 },
  "bootstrapAgents": true,
  "submitToControlPlane": false,
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
| `bootstrapAgents` | boolean | `true` | Resolve and bootstrap example agent bindings |
| `submitToControlPlane` | boolean | `true` | Submit the compiled request to the control plane |
| `tags` | string[] | _(none)_ | Additional tags merged into `execution.tags` |
| `requester` | object | _(none)_ | Override `execution.requester` with `{ actorId, actorType }` |
| `runLabel` | string | _(none)_ | Human-readable label stored in `session.metadata.runLabel` |

**Response:** `201`
```json
{
  "compiled": { "executionRequest": { ... }, "display": { ... }, "participantBindings": [ ... ] },
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
      "status": "resolved"
    }
  ],
  "controlPlane": {
    "baseUrl": "http://localhost:3001",
    "validated": false,
    "submitted": false
  }
}
```

When `submitToControlPlane` is `true` and the control plane is available, the response includes `runId`, `status`, and `traceId` in the `controlPlane` object, and hosted agents have `status: "bootstrapped"`.

**Errors:** `400 VALIDATION_ERROR | INVALID_SCENARIO_REF | AGENT_NOT_FOUND`, `502 AUTH_MINT_FAILED | CONTROL_PLANE_UNAVAILABLE`, `500 INVALID_CONFIG`

`AUTH_MINT_FAILED` surfaces when the per-agent JWT mint against the
auth-service fails (non-2xx response or timeout). `INVALID_CONFIG` surfaces
if `MACP_AUTH_SERVICE_URL` is not set at boot — the service fails startup,
so this should only be seen in misconfigured environments.

## Swagger UI

Available at `GET /docs` when `NODE_ENV=development`.
