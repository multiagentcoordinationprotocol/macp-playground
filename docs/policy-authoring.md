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
  "schema_version": 3,
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

### Shape validation: closed keys, annotations, and `voting.weights`

Every level of a policy's `rules` object is a **closed schema** —
`additionalProperties: false` at every nesting level (`voting`,
`voting.quorum`, `objection_handling`, `evaluation`, `commitment`). An
unrecognized key anywhere (a typo like `veto_threshhold`) is rejected, not
silently ignored. This repo validates policies against the real vendored
schemas at `schemas/policy/` (see its `README.md` for provenance) in three
places:

- **CI gate** — `src/policy/policies-on-disk.spec.ts` validates every shipped
  `policies/*.json` file's `rules` *and* full descriptor (including the
  `schema_version` enum).
- **Authoring** — `npm run scenario:lint` validates the `rules` of each policy
  a scenario's `policyVersion` references, reporting failures as errors (see
  [`scenario-cli.md`](scenario-cli.md)).
- **Load time** — `PolicyLoaderService` logs non-blocking warnings (see
  [Local validation warnings](#local-validation-warnings)).

Two exceptions to the closed-key rule:

- **Annotation keys** — any key matching `^[_$]` (e.g. `$comment`, `_note`)
  is legal at every nesting level, for documenting a rule block inline
  without the schema rejecting it.
- **`voting.weights`** — its **keys** are open (they're participant IDs,
  not fixed field names), but its **values** are still constrained
  (greater than `0`, no zero or negative weights) and the map itself
  requires **at least one entry**, unconditionally, at every
  `voting.algorithm` — not only `weighted`. A weights map is meaningless
  outside the `weighted` algorithm, so an empty or zero-valued one is
  treated as an authoring error wherever it appears, not just there.

`voting.algorithm` also accepts `plurality` (most votes wins, no majority
required) alongside `none`/`majority`/`supermajority`/`unanimous`/`weighted`
— not yet used by any policy shipped in this repo, but a legal value.

### Wildcard-mode policies

A policy whose `mode` is `"*"` binds to sessions of every mode, so its
`rules` are checked against all five standards-track mode schemas
(`decision`, `quorum`, `proposal`, `task`, `handoff`) rather than Decision's
alone — the runtime does the same at registration (see
[`macp-runtime/docs/policy.md` § What registration checks](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/policy.md#what-registration-checks)).
Locally, `PolicyRulesValidator` (`src/policy/policy-rules-validator.ts`)
validates **per top-level key**: each key must be valid under at least one
mode schema that declares it, and a key no mode declares (a typo) is an
error. So a Decision-shaped wildcard such as the shipped `policy.default.json`
passes, while a malformed Quorum `threshold` inside a wildcard policy is
caught. `policy.default.json` is the only wildcard policy shipped here.

## Included Policies

These are the policies shipped in `policies/` for the demo scenarios:

| Policy ID | Algorithm | Threshold | Quorum | Veto | Min Confidence | Commit Authority |
|-----------|-----------|-----------|--------|------|----------------|-------------------|
| `policy.default` | none | - | 0 | No | 0.0 | initiator_only |
| `policy.fraud.majority-veto` | majority | 50% | 2 count | Yes (1) | 0.0 | initiator_only |
| `policy.fraud.supermajority` | supermajority | 67% | 2 count | No | 0.0 | initiator_only |
| `policy.fraud.unanimous` | unanimous | - | 100% | Yes (1) | 0.7 | initiator_only |
| `policy.lending.conservative` | supermajority | 67% | 3 count | Yes (1) | 0.6 | **designated_role** (`risk-agent`, `compliance-agent`) |
| `policy.claims.majority` | majority | 50% | 2 count | No | 0.0 | initiator_only |

All declare `"mode": "macp.mode.decision.v1"` except `policy.default`, which
is `"*"` (see above).

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
| `designatedRoles` | **not derived from `rules.commitment.designated_roles`** — see the callout below; the two fields hold different value kinds and are unrelated in practice |

> **`policyHints.designatedRoles` is informational only — nothing in this repo
> reads it.** `PolicyStrategy` (`src/example-agents/runtime/policy-strategy.ts`)
> declares the field on its `PolicyHints` type but never consumes it; the
> coordinator commits unconditionally and lets the runtime arbitrate authority.
> Commitment authority is enforced solely by the **runtime**, against
> `rules.commitment.designated_roles` (participant identities, see the callout
> under "Creating a Custom Policy" below) — a completely separate field with a
> different value domain (role labels vs. participant IDs) that happens to
> share a similar name. Setting `policyHints.designatedRoles` in a scenario
> template has zero effect on what the runtime will actually authorize.

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
   success (the runtime signals a duplicate) — but "already registered"
   only means the runtime holds *a* descriptor under that `policy_id`, not
   that it's the one on disk right now. The registrar follows up with a
   `getPolicy` read and compares `schema_version`; a mismatch (a runtime
   that was never restarted after a local policy edit, a rolling deploy
   that skipped re-registration) is logged at ERROR as `policy_schema_drift`
   rather than silently counted as a clean match. The same comparison runs
   on the read-only verification path (step 5 below).
5. On completion, logs
   `policy_registration_complete registered=<n> already=<n> managed_by_runtime=<n> missing=<n> failed=<n> schema_drift=<n> read_only=<bool> total=<n>`.
   A nonzero `schema_drift` gets its own summary ERROR line naming the
   affected policies (see the per-policy `policy_schema_drift` lines above it)
   and the fix (restart the runtime, or clear its registry, to pick up the
   local `schema_version`).

**Read-only registry.** A runtime started with `MACP_POLICIES_DIR`
owns its registry from disk and rejects `RegisterPolicy` with
`FAILED_PRECONDITION`. The registrar detects this on the first rejection,
**stops mutating**, and switches to **verification**: it calls `getPolicy` for
each required policy, counts `managed_by_runtime` vs `missing`, and logs any
missing policy at ERROR with the `<policy_id>.json` file to mount into the
runtime's policies dir. For this deployment shape, mount `./policies` into the
runtime and set `REGISTER_POLICIES_ON_LAUNCH=false` to skip the probe entirely
(see [`deployment.md`](deployment.md) § Read-only registry).

Registration is skipped (never an error) when:

- `REGISTER_POLICIES_ON_LAUNCH=false` — explicit opt-out (logged at info).
- `MACP_RUNTIME_ADDRESS` is unset — typically CI/test (logged as a warning).

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
`risk-decider` coordinator catches any rejected commit (typically
`POLICY_DENIED`) and drives the session to a terminal **`CANCELLED`** state via
`participant.client.cancelSession()`. It does the same when its wait-all
deadline (`RISK_DECIDER_WAIT_ALL_TIMEOUT_MS`, default 60 s) passes with quorum
unmet, so no commit is attempted at all. The control-plane observer maps the
resulting `CANCELLED` lifecycle event to a `cancelled` run status — distinct
from a TTL `EXPIRED` run.

An empty `policy_version` resolves to the runtime's built-in default policy;
see [`macp-runtime/docs/policy.md` § Default policy](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/policy.md#default-policy).

### Outcome-aware commits: a decline can *resolve* instead of being denied

The runtime's Decision evaluator is **outcome-aware**, so `POLICY_DENIED` →
`CANCELLED` is **not** the universal result in this demo. The coordinator
commits with `outcomePositive` inferred from its decision; when that is a
**decline** backed by at least one decisive explicit reject vote — the common
reject-majority fraud/lending/claims path — the runtime accepts it and the
session **resolves**. No `POLICY_DENIED` occurs, the `cancelSession` fallback
does not fire, and the control-plane observer records a declined outcome with
run status **`completed`** (not `cancelled`). The fallback above therefore
handles only genuine denials (for example an approve-side commit short of
quorum or confidence, or a decline with no decisive reject).

The exact rules — the decline guard, `allow_decline_over_approval`,
`critical_objection_action` (`deny` / `hold` / `finalize_decline`), and how
they interact with quorum — are runtime-owned; see
[`macp-runtime/docs/policy.md` § Voting algorithm semantics](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/policy.md#voting-algorithm-semantics)
and [RFC-MACP-0007 §6.2](https://github.com/multiagentcoordinationprotocol/multiagentcoordinationprotocol/blob/main/rfcs/RFC-MACP-0007-decision-mode.md#62-negative-committed-outcomes-vote-gated-and-objection-gated-decline).

> **`schema_version`: use `3` for new policies.** What each version means
> (`2` additive, `3` semantic: an empty decisive tally denies a positive
> commitment whatever `require_vote_quorum` says) is defined in
> [RFC-MACP-0012 §3](https://github.com/multiagentcoordinationprotocol/multiagentcoordinationprotocol/blob/main/rfcs/RFC-MACP-0012-policy.md#3-policy-descriptor)
> and explained in
> [`macp-runtime/docs/policy.md` § What registration checks](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/policy.md#what-registration-checks).
> Playground-specific facts:
>
> - All six bundled `policies/*.json` declare `schema_version: 3`. Each already
>   set `require_vote_quorum: true` or uses `algorithm: "none"`, so moving them
>   to `3` changed no shipped behaviour.
> - `policy.default` is never registered (`listRegistrablePolicies()` excludes
>   it; the id is the runtime's own built-in), so its file's `schema_version`
>   is never sent anywhere.
> - The runtime's **evaluator** supports `{1, 2, 3}` and denies every commitment
>   under any other version at commit time. Its registration step rejects only
>   `0`, so a `4` would register cleanly and then fail every run. This repo
>   catches it earlier — see
>   [Local validation warnings](#local-validation-warnings) for where.

## Creating a Custom Policy

1. **Create the JSON file** in `policies/` — the shape is the runtime's
   `PolicyDescriptor`. Example:

```json
{
  "policy_id": "policy.myteam.custom",
  "mode": "macp.mode.decision.v1",
  "schema_version": 3,
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
      "authority": "designated_role",
      "require_vote_quorum": true,
      "designated_roles": ["risk-agent", "compliance-agent"]
    }
  }
}
```

Refer to [`macp-runtime/docs/policy.md`](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/policy.md)
for the legal values of each rule field.

> **`rules.commitment.designated_roles` holds sender identities, not role
> labels**, despite the name. The runtime matches each entry against the
> authenticated envelope `sender` (see
> [`macp-runtime/docs/policy.md` § Commitment authority](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/policy.md#commitment-authority))
> — which in this repo is the scenario roster's participant `id`
> (e.g. `risk-agent`, `compliance-agent` from `packs/_shared/participants/`),
> **not** its cosmetic `role:` field (`risk`, `compliance`). A policy that puts
> role labels here instead of participant IDs will reject every commit
> from every participant once `authority: "designated_role"` is set — the
> runtime rejects it at commitment time (as `FORBIDDEN`, a sender-authorization
> failure, not `POLICY_DENIED`), not at registration, so the runtime will not
> flag the mistake before a real run. This repo's CI gate does
> (`policies-on-disk.spec.ts` checks shipped `designated_roles` against real
> participant ids). This is unrelated to the
> `policyHints.designatedRoles` field above, which *is* free-form and
> role-labeled — it's advisory-only: nothing in this repo reads it (see the
> callout above), and it is never sent to or enforced by the runtime.

> **Quorum scale.** A `percentage`-type `voting.quorum.value` is on a **0–100
> scale**, not 0–1: write `"value": 100` for "all participants must vote", as
> `policy.fraud.unanimous` does — `1.0` would mean 1%. A `count`-type value is
> an absolute voter count. The evaluation rules are runtime-owned; see
> [`macp-runtime/docs/policy.md` § Decision Mode](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/policy.md#decision-mode).

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
   [`macp-runtime/docs/getting-started.md` § JWT mode](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/getting-started.md#jwt-mode)
   for the full JWT setup, and
   [`macp-auth-service/docs/integration.md` § Runtime wiring](https://github.com/multiagentcoordinationprotocol/macp-auth-service/blob/main/docs/integration.md#runtime-wiring)
   for the auth-service side.
4. **Manual re-register.** Restart the macp-playground once the
   auth-service is healthy — registration is idempotent, so any
   already-registered policies come back as `already` in the log summary.

### `AUTH_MINT_FAILED` on `/examples/run`

The spawn-time JWT mint hit the auth-service and got a non-2xx response
(or timed out). Check `MACP_AUTH_SERVICE_URL`, `MACP_AUTH_SERVICE_TIMEOUT_MS`,
and the auth-service logs.

## Local validation warnings

`PolicyLoaderService` runs a structural check on load and warns
(non-blocking) for missing `policy_id`, out-of-range values, or
obviously invalid combinations. As of #81, this check includes real
**shape** conformance against the vendored upstream rule schemas
(`schemas/policy/`, see its `README.md` for provenance) — the canonical
JSON Schema definitions published in the spec repo — so an unknown key
or an empty `designated_roles` under `designated_role` authority is now
caught locally, with a logged warning, before registration is even
attempted. Wildcard-mode policies are checked as described under
[Wildcard-mode policies](#wildcard-mode-policies).

**Where `schema_version` is enforced.** The load path does not run the
descriptor schema; it applies its own bound instead, warning when
`schema_version` is below `1` or above `3` (`MAX_SUPPORTED_SCHEMA_VERSION`
in `src/policy/policy-loader.service.ts`, mirroring the runtime evaluator).
The schema's closed `{1, 2, 3}` enum itself — via
`PolicyRulesValidator.validateDescriptor()` — is enforced only by the CI gate
`src/policy/policies-on-disk.spec.ts`, which validates each shipped file's
full descriptor. `scenario:lint` validates `rules` only, not
`schema_version`.

This local check is still non-blocking (a bad file
loads anyway, matching this repo's existing warn-and-load design) and it
is not a proxy for the runtime's own validation: the runtime's
`RegisterPolicy` enforcement is a **separate, hand-written Rust
implementation**, not generated from these JSON schemas, and it has
documented divergence from them (for example, in Quorum mode the runtime
accepts `count` as a `threshold.type` value even though the schema's
canonical enum for that field is the closed pair `n_of_m`/`percentage` —
`count` is a documented runtime-side alias for `n_of_m` that both the
mode and its evaluator already treat as one; and — at least as of this
writing — the runtime does not enforce closed objects the way these
schemas' `additionalProperties: false` does). In practice that
means this repo's local check is *stricter* than the runtime for #81's
exact bug class (unknown keys), so a file can pass local load with no
warning yet still be exactly the shape the runtime would reject, and
vice versa. If a descriptor passes local load but fails at the runtime,
the registrar logs `policy_register_exception` with the runtime's
`INVALID_POLICY_DEFINITION` reason. See
[`macp-runtime/docs/policy.md` § Registering a policy](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/policy.md#registering-a-policy)
for the validation rules the runtime actually enforces.
