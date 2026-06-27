# Policy Authoring Guide

Policies define the governance rules that control how specialist agent signals (evaluations and objections) are aggregated into final decisions during MACP coordination runs. This guide explains how the **macp-playground** loads policies, how they flow to spawned agents, and how to author new ones for demo scenarios.

> **Canonical rule schema, voting algorithms, veto/confidence/ABSTAIN
> mechanics, and commitment-authority semantics live in the runtime docs
> — not here.** See [`macp-runtime/docs/policy.md`](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/policy.md)
> for the full schema and behavioural reference. This guide covers only
> the macp-playground-specific plumbing (loading, registration, hints
> mapping, scenario wiring).

## Policy JSON Schema (at a glance)

Every policy under `policies/*.json` follows the runtime's
`PolicyDescriptor` shape:

```json
{
  "policy_id": "policy.<domain>.<variant>",
  "mode": "macp.mode.decision.v1",
  "schema_version": 1,
  "description": "Human-readable description of this policy",
  "rules": { "voting": { ... }, "objection_handling": { ... },
             "evaluation": { ... }, "commitment": { ... } }
}
```

For the full field reference (voting algorithms, thresholds, quorum
shapes, objection handling, evaluation confidence, commitment authority,
rule-level validation errors) see the canonical runtime doc linked
above. The macp-playground does not re-document or alter any of those
semantics — it just registers whatever descriptors live on disk.

## Included Policies

These are the policies shipped in `policies/` for the demo scenarios:

| Policy ID | Algorithm | Threshold | Quorum | Veto | Min Confidence |
|-----------|-----------|-----------|--------|------|----------------|
| `policy.default` | none | - | 0 | No | 0.0 |
| `policy.fraud.majority-veto` | majority | 50% | 2 count | Yes (1) | 0.0 |
| `policy.fraud.supermajority` | supermajority | 67% | 2 count | No | 0.0 |
| `policy.fraud.unanimous` | unanimous | - | 100% | Yes (1) | 0.7 |
| `policy.lending.conservative` | supermajority | 67% | 3 count | Yes (1) | 0.6 |
| `policy.claims.majority` | majority | 50% | 2 count | No | 0.0 |

## Connecting Policies to Scenarios

Policies are referenced in scenario templates via the `policyVersion` field:

```yaml
# In a scenario template (e.g., templates/unanimous.yaml)
spec:
  overrides:
    launch:
      policyVersion: policy.fraud.unanimous
      policyHints:
        type: unanimous
        threshold: 1.0
        vetoEnabled: true
        minimumConfidence: 0.7
        designatedRoles: []
```

The default template uses `policy.default` which requires no registration.

### Policy Hints

`policyHints` are an macp-playground-specific denormalized projection
of the policy's rules that agents consume at bootstrap time. They are
never sent to the runtime or the control-plane — only to the in-tree
`PolicyStrategy` used by the Risk coordinator. The runtime evaluates
governance against the registered `policy_id` directly.

| Hint Field | Maps From (canonical) |
|------------|-----------------------|
| `type` | `rules.voting.algorithm` |
| `threshold` | `rules.voting.threshold` |
| `vetoEnabled` | `rules.objection_handling.critical_severity_vetoes` |
| `vetoThreshold` | `rules.objection_handling.veto_threshold` |
| `minimumConfidence` | `rules.evaluation.minimum_confidence` |
| `designatedRoles` | `rules.commitment.designated_roles` |

## How Policies Are Loaded

`PolicyLoaderService` reads all `*.json` files from the `policies/`
directory at startup:

1. Parses each file and extracts `policy_id`
2. Validates structure (non-blocking warnings)
3. Caches policies in memory
4. Excludes `policy.default` from the registrable set (auto-resolved by the runtime)

## How Policies Are Registered

When `REGISTER_POLICIES_ON_LAUNCH=true` (the default) and
`MACP_RUNTIME_ADDRESS` is set, `PolicyRegistrarService.onApplicationBootstrap()`
registers every non-default policy with the **runtime** once per process
start. Registration happens at service boot — not per-run — so that
`/examples/run` requests never hit an `UNKNOWN_POLICY_VERSION` from the
runtime.

Flow (`src/policy/policy-registrar.service.ts`):

1. `PolicyLoaderService.listRegistrablePolicies()` returns every policy whose
   `policy_id` is not `policy.default`.
2. `AuthTokenMinterService.mintToken("macp-playground", { can_manage_mode_registry: true, is_observer: false, allowed_modes: ["*"] })`
   mints an admin JWT from the auth-service.
3. The registrar opens a short-lived gRPC channel to the runtime using that
   JWT and calls `MacpClient.registerPolicy(descriptor)` for each policy.
   (For the wire contract of `RegisterPolicy`, see
   [`macp-runtime/docs/API.md`](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/API.md#registerpolicy).)
4. Errors whose message contains `"already"` are treated as idempotent
   success (the runtime signals a duplicate).
5. On completion, logs
   `policy_registration_complete registered=<n> already=<n> failed=<n> total=<n>`.

Registration is skipped (with a warning, not an error) when:

- `REGISTER_POLICIES_ON_LAUNCH=false` — explicit opt-out.
- `MACP_RUNTIME_ADDRESS` is unset — typically CI/test.

If the admin JWT mint fails (e.g. auth-service unreachable), the
registrar **aborts the entire registration pass** and logs an ERROR.
The service still starts, but downstream `/examples/run` requests will
fail at the runtime with `UNKNOWN_POLICY_VERSION`. See
"Troubleshooting" below.

## Runtime Enforcement at Commit Time

The runtime's policy engine is **authoritative**. The coordinator's local
`PolicyStrategy` (`src/example-agents/runtime/policy-strategy.ts`) is only an
*advisory* mirror used to decide when to attempt a commit — it can legitimately
disagree with the runtime. When the coordinator emits its `commit`, the runtime
re-evaluates the registered policy against the **actual** votes and evaluations
and may reject it with `POLICY_DENIED`, e.g.:

- `"majority vote failed: 25.0% approve, need >= 50.0%"`
- `"no qualifying evaluation meets minimum confidence threshold: 0.60"`

A rejected commit produces no terminal commitment, so the session would
otherwise linger until TTL expiry. To keep the demo deterministic, the
`risk-decider` coordinator catches `POLICY_DENIED` and drives the session to a
terminal **`CANCELLED`** state via `participant.client.cancelSession()`
(proto 0.1.3 / `macp-sdk-typescript` 0.4.0). The control-plane observer maps the
resulting `CANCELLED` lifecycle event to a `cancelled` run status — distinct
from a TTL `EXPIRED` run. This means a run whose real-agent inputs don't satisfy
the governance thresholds finalizes promptly as `cancelled` rather than hanging.

## Creating a Custom Policy

1. **Create the JSON file** in `policies/` — the shape is the runtime's
   `PolicyDescriptor`. Example:

```json
{
  "policy_id": "policy.myteam.custom",
  "mode": "macp.mode.decision.v1",
  "schema_version": 1,
  "description": "Custom policy for my team's use case",
  "rules": {
    "voting": {
      "algorithm": "supermajority",
      "threshold": 0.75,
      "quorum": { "type": "count", "value": 3 }
    },
    "objection_handling": { "critical_severity_vetoes": true, "veto_threshold": 1 },
    "evaluation": { "minimum_confidence": 0.6, "required_before_voting": true },
    "commitment": {
      "authority": "designated_roles",
      "require_vote_quorum": true,
      "designated_roles": ["risk", "compliance"]
    }
  }
}
```

Refer to [`macp-runtime/docs/policy.md`](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/policy.md)
for the legal values of each rule field.

2. **Reference it in a scenario template:**

```yaml
spec:
  overrides:
    launch:
      policyVersion: policy.myteam.custom
      policyHints:
        type: supermajority
        threshold: 0.75
        vetoEnabled: true
        vetoThreshold: 1
        minimumConfidence: 0.6
        designatedRoles: ["risk", "compliance"]
```

3. **Restart the service** — `PolicyLoaderService` will discover the new
   file on next load, and `PolicyRegistrarService` will register it with
   the runtime during `onApplicationBootstrap`.

## Troubleshooting

### `UNKNOWN_POLICY_VERSION` at run time

Symptom: `/examples/run` compiles successfully but the runtime rejects
the session with `UNKNOWN_POLICY_VERSION`.

Checklist:

1. **Startup logs.** Look for `policy_registration_complete` on the most
   recent macp-playground boot. If you see
   `policy registration aborted: failed to mint admin JWT`, fix the
   auth-service connection (`MACP_AUTH_SERVICE_URL`, network reachability,
   JWKS on the runtime).
2. **Scope.** The admin mint uses `can_manage_mode_registry`. If the
   runtime's auth config does not accept this scope, `registerPolicy`
   returns an error and the policy stays unregistered.
3. **Runtime trust chain.** The runtime must have
   `MACP_AUTH_JWKS_URL=<auth-service>/.well-known/jwks.json` and the
   matching `MACP_AUTH_ISSUER` / `MACP_AUTH_AUDIENCE`. A mismatch rejects
   the admin JWT at the runtime boundary, which logs as
   `policy_register_exception`. See
   [`macp-runtime/docs/getting-started.md` § Authentication](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/getting-started.md#authentication)
   for the full JWT setup.
4. **Manual re-register.** Restart the macp-playground once the
   auth-service is healthy — registration is idempotent, so any
   already-registered policies come back as `already` in the log summary.

### `AUTH_MINT_FAILED` on `/examples/run`

The spawn-time JWT mint hit the auth-service and got a non-2xx response
(or timed out). Check `MACP_AUTH_SERVICE_URL`, `MACP_AUTH_SERVICE_TIMEOUT_MS`,
and the auth-service logs.

## Local validation warnings

`PolicyLoaderService` runs a light structural check on load and warns
(non-blocking) for missing `policy_id`, out-of-range values, or
obviously invalid combinations. The **authoritative** schema validation
happens at the runtime during `RegisterPolicy` — if a descriptor passes
local load but fails at the runtime, the registrar logs
`policy_register_exception` with the runtime's `INVALID_POLICY_DEFINITION`
reason. See
[`macp-runtime/docs/policy.md` § Registering a policy](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/policy.md#registering-a-policy)
for the validation rules the runtime enforces.
