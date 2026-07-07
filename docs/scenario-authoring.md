# Scenario Authoring Guide

## Directory Structure

Each scenario pack follows this layout:

```
packs/{pack-slug}/
  pack.yaml
  scenarios/{scenario-slug}/{version}/
    scenario.yaml
    templates/
      default.yaml
      *.yaml
```

## Pack File

`pack.yaml` defines the pack metadata:

```yaml
apiVersion: scenarios.macp.dev/v1
kind: ScenarioPack
metadata:
  slug: fraud                              # URL-safe identifier
  name: Fraud                              # Display name
  description: Fraud and risk decisioning demos
  tags: [fraud, risk, demo]
```

## Scenario Version File

`scenario.yaml` defines a single versioned scenario:

```yaml
apiVersion: scenarios.macp.dev/v1
kind: ScenarioVersion
metadata:
  pack: fraud
  scenario: high-value-new-device
  version: 1.0.0
  name: High Value Purchase From New Device
  summary: Description shown in the catalog
  tags: [fraud, demo]

spec:
  runtime:
    kind: rust
    version: v1

  inputs:
    schema:                                # Standard JSON Schema
      type: object
      properties:
        transactionAmount:
          type: number
          default: 2400
          minimum: 1
      required: [transactionAmount]

  launch:
    modeName: macp.mode.decision.v1
    modeVersion: 1.0.0
    configurationVersion: config.default
    policyVersion: policy.default          # optional
    ttlMs: 300000
    maxSuspendMs: 15000                     # optional — session-bound suspend cap (proto 0.1.5)
    initiatorParticipantId: risk-agent     # optional

    participants:
      - id: fraud-agent
        role: fraud
        agentRef: fraud-agent              # matches example-agent catalog

    commitments:                           # optional — propagated to session.commitments
      - id: fraud-risk-assessed
        title: Fraud risk assessed
        description: Fraud specialist has recorded a risk verdict.
        requiredRoles: [fraud]
        policyRef: policy.default

    contextTemplate:                       # {{ inputs.* }} substitution
      transactionAmount: "{{ inputs.transactionAmount }}"

    metadataTemplate:
      demoType: fraud-decision

    kickoffTemplate:
      - from: risk-agent
        to: [fraud-agent]
        kind: proposal
        messageType: Proposal
        payloadEnvelope:
          encoding: proto
          proto:
            typeName: macp.modes.decision.v1.ProposalPayload
            value:
              proposal_id: "{{ inputs.customerId }}-review"

  execution:
    tags: [demo, fraud]
    requester:
      actorId: macp-playground
      actorType: service

  outputs:
    expectedDecisionKinds: [approve, step_up, decline]
    expectedSignals: [suspicious_device]
```

> **`maxSuspendMs` (optional).** Binds a session-level suspension cap
> (proto 0.1.5 `SessionStartPayload.max_suspend_ms`) threaded into the
> initiator's `sessionStart` exactly like `ttlMs`. Omit it (or set `0`) to
> accept the runtime default (7 days). A small cap is useful for suspend/resume
> demos: hold a suspended session past the cap and the runtime expires it
> against the cap. See the `suspend-demo` template under the fraud pack, which
> pairs `maxSuspendMs: 15000` with the `suspend` customerId sentinel that
> triggers `risk-decider.worker.ts`'s initiator-driven suspend/resume flow.

## Template File

Templates provide default overrides and launch configuration variants:

```yaml
apiVersion: scenarios.macp.dev/v1
kind: ScenarioTemplate
metadata:
  scenarioVersion: fraud/high-value-new-device@1.0.0
  slug: strict-risk
  name: Strict Risk

spec:
  defaults:                                # Override scenario schema defaults
    deviceTrustScore: 0.08
    priorChargebacks: 2

  overrides:
    launch:                                # Deep-merged with scenario launch config
      ttlMs: 180000
      metadataTemplate:
        posture: strict-risk
    runtime:                               # Override runtime selection
      kind: rust
      version: v2
    execution:                             # Override execution config
      tags: [strict, fraud]
```

## Template Substitution

Use `{{ path.to.value }}` placeholders in `contextTemplate`, `metadataTemplate`, and `kickoffTemplate`. During compilation:

- **Exact match** (`"{{ inputs.amount }}"`) — preserves the original type (number, boolean, etc.)
- **Embedded** (`"Amount: {{ inputs.amount }}"`) — coerces to string
- **Nested paths** are supported: `{{ inputs.nested.field }}`
- **Undefined placeholders** throw a `COMPILATION_ERROR`

## Commitments

`launch.commitments` is an optional array of commitment definitions that declare the discrete governance steps the session is expected to produce. The compiler forwards them onto `ExecutionRequest.session.commitments`, and the control plane exposes them on the run-state projection so UIs can render the expected commitment list before the first evaluation fires.

Each entry:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | Stable commitment identifier (matches what agents will emit) |
| `title` | string | yes | Short human-readable label |
| `description` | string | no | One-line explanation of what the commitment represents |
| `requiredRoles` | string[] | no | Participant roles expected to contribute |
| `policyRef` | string | no | Policy version this commitment is evaluated under |

Template overrides that set `commitments` **replace** the scenario's array (array values are not merged element-wise).

Placeholder substitution (`{{ inputs.* }}`) applies inside commitment fields, same as other launch templates.

## Default Merge Precedence

```
JSON Schema defaults < Template defaults < User-provided inputs
```

## Adding a New Scenario

The fastest path is `npm run scenario:new <pack> <slug>` — see [`scenario-cli.md`](./scenario-cli.md). Manually:

1. Create the pack directory: `packs/{slug}/pack.yaml`
2. Create the scenario directory: `packs/{slug}/scenarios/{scenario-slug}/{version}/`
3. Write `scenario.yaml` with the schema above
4. Add at least a `default.yaml` template in `templates/`
5. Ensure `agentRef` values in participants match entries in the example agent catalog
6. The service auto-discovers new packs on the next request (when `REGISTRY_CACHE_TTL_MS=0`)
7. `npm run scenario:validate packs/{slug}/scenarios/{scenario-slug}/{version}/scenario.yaml` to confirm before booting the service.

## Splitting large scenarios with `!include`

Scenario YAML files can grow unwieldy when they carry bulky context data, long input schemas, or repeated participant blocks. The loader supports a custom `!include` tag that inlines a sibling YAML or JSON file at load time — keeping `scenario.yaml` readable while data lives next to it on disk.

```yaml
launch:
  participants: !include ../../../../_shared/participants/4-agent-fraud.yaml
  commitments:  !include ../../../../_shared/commitments/fraud.yaml
  contextTemplate:
    customers:  !include ./data/customers.json    # 200-row sample list
    priorCases: !include ./data/cases.json
```

**Path resolution.** `!include <path>` is resolved **relative to the file that contains the tag**. So an include from `templates/strict.yaml` resolves from inside the `templates/` directory, not from the scenario root.

**Supported targets.** `.yaml`, `.yml`, and `.json`. YAML files may themselves contain further `!include` tags (recursive includes are followed). Other extensions throw `INVALID_PACK_DATA`.

**Security bound.** Resolved paths must stay inside `PACKS_DIR`. Any include that escapes (`../../../etc/passwd`, absolute paths outside `PACKS_DIR`, etc.) throws `INVALID_PACK_DATA` at load time.

**Cycle detection.** `a.yaml → b.yaml → a.yaml` throws.

**When to reach for it.** Any time the same fragment is copy-pasted across two or more scenarios, or any time a single field crosses ~50 lines of inline data.

## Sharing fragments across scenarios

Conventionally, fragments live under `packs/_shared/` (the leading underscore tells the loader to skip the directory during pack discovery). The seeded layout:

```
packs/_shared/
  participants/
    4-agent-fraud.yaml          # fraud / growth / compliance / risk roster
    4-agent-lending.yaml
    4-agent-claims.yaml
  commitments/
    fraud.yaml                  # standard 3-commitment fraud set
    lending.yaml                # 4-commitment lending set
    claims.yaml                 # 3-commitment claims set
  policy-hints/
    default.yaml
    lending-conservative.yaml
    claims-majority.yaml
```

**Rule of thumb:** the third caller is when you promote a fragment to `_shared/`. Two scenarios that happen to share a participant list usually aren't worth the indirection; three is.

**`_`-prefix discovery rule.** Any directory directly under `PACKS_DIR` whose name starts with `_` is ignored for pack discovery. Use this for fragment libraries, generators, or any non-pack scaffolding.
