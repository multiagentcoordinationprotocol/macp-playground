# PROGRESS — policy-rule-schema-validation (issue #81)

Plan: `plans/policy-rule-schema-validation.md`
Driven via `/plan` + `/implement` (user request: "Are there any pending tasks in plan or
git hub issues if there are can we /plan and /implement" — user selected both #81 and #21
to plan/implement this session; #21 was implemented separately, by a concurrent fork, on its
own branch `feat/example-agent-domain-scoring` — not tracked in this file. This worktree and
this branch carry only the #81 work end to end, self-containedly, per the isolation fix
described in Phase 1's checkpoint below.)

Plan written by Opus, reviewed once by a fresh Opus subagent against live code (including
compiling the real vendored schemas with ajv and running them against all 6 shipped policy
files) — verdict REVISE, 5 blocking items + 11 tightenings, all applied in the plan's own
Round 1 revision. See the plan's own "Plan review" section for the full accounting.

## Repo map

(Carried over from `plans/policy-rule-schema-validation.md`'s own "Repo map" section.)

| Area | Files | Purpose |
|------|-------|---------|
| Policy contracts | `src/contracts/policy.ts` | TS shape for `PolicyDefinition`/`rules` — narrower than upstream schema, over-strict on `veto_threshold` |
| Policy loading | `src/policy/policy-loader.service.ts` | Reads `policies/*.json`, hand-rolled `validatePolicy()`, warn-and-cache-anyway |
| Policy registration | `src/policy/policy-registrar.service.ts` | Pure passthrough, no shape validation (out of scope) |
| Ajv precedent (do not reuse) | `src/compiler/ajv-factory.ts` | Draft-07, scenario inputs only — throws on 2020-12 schemas |
| Shipped policies | `policies/*.json` (6 files) | Only `rules` ingress in this repo; 3 currently fail real upstream schema |
| Hard CI gate (extend) | `src/policy/policies-on-disk.spec.ts` | Real-file tests; home for the new schema-conformance assertion |
| Loader unit tests | `src/policy/policy-loader.service.spec.ts` | `:263-269` must be inverted, not extended |
| Scenario CLI | `scripts/scenario/lint.ts` | `loadKnownPolicies()` needs `Set`→`Map` signature change |
| CLI integration tests (extend) | `test/integration/scenario-cli.integration.spec.ts` | Already has `runLint` test scaffolding |
| Docs | `docs/policy-authoring.md` | Stale at `:38-41`, `:207`, `:338-348` |
| Build/deploy | `Dockerfile` (`:33-36`), `nest-cli.json`, `tsconfig.json` | COPY list omits `schemas/`; no `resolveJsonModule` |
| Upstream schema source (read-only) | `../multiagentcoordinationprotocol/schemas/json/policy/*.schema.json` + `../multiagentcoordinationprotocol/schemas/json/macp-policy-descriptor.schema.json` @ `4f15b96` | Vendor source for Phase 1 |
| Not in scope | `src/example-agents/runtime/policy-strategy.ts` (`PolicyHints`) | Separate projection, never sent to runtime |

## Phase checkpoint log

### Phase 1 — Vendor upstream rule schemas + build a real ajv-based validator
- Status: DONE (2026-09-25)
- Concurrency note: this fork and the concurrent #21 fork were both dispatched into the same
  shared working directory (`/Users/Shared/multiagentcoordinationprotocol/macp-playground`)
  without worktree isolation. Discovered mid-phase via unexpected file modifications
  (`agents/*.py` etc.) showing up under this fork's `git status`, and confirmed via `git
  reflog` that both forks had independently run `git checkout -b` in the same directory,
  flipping HEAD between the two feature branches (no data loss — both branches pointed at the
  identical commit `5a6681e` throughout, so the checkouts were no-ops on the working tree).
  Mitigated by creating an isolated `git worktree` at `../macp-playground-worktree-81` on
  `feat/policy-rule-schema-validation`, copying over exactly this phase's own files (verified
  zero overlap with the other fork's files via `git status --short`), symlinking
  `node_modules`, and re-verifying the full suite green there before committing. All Phase 1
  work from this point forward happened exclusively inside that worktree. Leftover duplicate
  uncommitted edits in the shared directory (four modified files, four untracked
  files/dirs — confirmed byte-for-byte identical to what was already safely committed in the
  worktree, and confirmed to contain none of the other fork's content) were reverted/removed
  from the shared directory afterward so as not to risk the other fork accidentally sweeping
  them into its own commit via `git add -A`.
  A second, related isolation gap was found and fixed later, during Phase 2: this plan file
  and PROGRESS.md are gitignored repo-wide, so they never actually lived inside this worktree
  at all — my Phase 1/2 `Status: DONE`/checkpoint edits had been landing only in the *shared*
  main-directory copies (which the concurrent #21 fork was also editing its own section of),
  never committed to this branch. Fixed by writing this worktree its own self-contained copies
  of `plans/policy-rule-schema-validation.md` and this `PROGRESS.md` (force-added past
  `.gitignore`, and an `ASSUMPTIONS.md` carrying just this plan's one entry), so that
  `feat/policy-rule-schema-validation` is fully self-consistent on its own — a reviewer
  checking out this branch alone sees the plan, this checkpoint log, and the one assumption
  entry, without needing the shared main directory or the other fork's branch. All further
  writes to plan/progress/assumptions tracking happen only in this worktree from this point on.
- Files touched: `schemas/policy/{decision,quorum,proposal,task,handoff}-rules.schema.json`,
  `schemas/policy/policy-descriptor.schema.json`, `schemas/policy/README.md`,
  `scripts/schemas-sync.ts`, `package.json` (`schemas:sync` script),
  `.github/workflows/ci.yml` (non-blocking drift-check step), `Dockerfile` (`COPY schemas/
  schemas/`), `src/contracts/policy.ts` (widened `PolicyDefinition['rules']`), **new**
  `src/policy/policy-rules-validator.ts`, **new** `src/policy/policy-rules-validator.spec.ts`.
- Verifier: fresh Opus subagent (general-purpose, model opus) — PASS on all 8 acceptance
  criteria, independently re-derived rather than trusted: drove the compiled validator itself
  from its own script for every AC, ran build/lint/format:check/tests itself, spot-checked
  vendored schema JSON shape claims directly, and positively proved the constructor-scoped
  `schemasDir` fix (not just via the spec's throw test) by `process.chdir()`-ing to a scratch
  dir with a mutated-but-valid schema and observing a different validation result. Two
  bookkeeping gaps flagged (both closed same-session, no code impact): the `mode: "*"`
  UNCONFIRMED assumption hadn't been written to `ASSUMPTIONS.md` yet, and this checkpoint log
  entry / plan `Status:` line hadn't been updated yet — both fixed immediately after the
  verifier's report, which is this entry.
- Verification: `npm run build`/`lint`/`format:check` clean; `policy-rules-validator.spec.ts`
  12/12; full unit suite 454/454 across 43 suites; `npm run test:cov` 87.96/75.31/90.68/88.99
  vs. floor 83/67/85/84 (new validator file itself at 96.77% stmt).
- Assumption logged: `mode: "*"` → decision-schema dispatch — see this worktree's own
  `ASSUMPTIONS.md` (UNCONFIRMED, for `/reconcile`).
- What's next: Phase 2 (wire `PolicyRulesValidator` into `PolicyLoaderService`, remove 4
  redundant hand-rolled checks, fix the veto-threshold-off check, fix the 3 non-conformant
  policy JSON files, add a permanent schema-conformance assertion to
  `policies-on-disk.spec.ts`, invert `policy-loader.service.spec.ts:263-269`) — inside the
  isolated worktree.

### Phase 2 — Wire the validator into the loader + CI gate; fix the 3 non-conformant policies
- Status: DONE (2026-09-25). Committed as `535d23d`.
- Verifier: fresh Opus subagent (general-purpose, model opus) — PASS on all 6 acceptance
  criteria, independently re-derived: re-ran the AC #1 reintroduce-then-revert sanity check
  itself (on a different file than the implementer used), confirmed the new CI gate fails with
  the schema's own message and reverts cleanly (sha256-verified, empty `git diff`); confirmed
  the zero-warnings test and all 7 `PolicyLoaderService` construction sites are untouched;
  confirmed the `:263-269` inversion is real; independently drove the compiled validator to
  confirm each of the 4 removed hand-rolled checks is exactly covered by the schema now, not
  approximately; confirmed coverage/build/lint/format/full-suite all clean. Two non-blocking
  notes: this bookkeeping hadn't been updated at verification time (expected, fixed here
  immediately after) and the spec's fs-mock dispatcher uses a `p.includes('schemas')`
  substring heuristic — cosmetic robustness gap, not fixed, noted for awareness only.
- Files touched: `src/policy/policy-loader.service.ts` (instantiate `PolicyRulesValidator`
  internally; removed 4 now-redundant hand-rolled checks — supermajority-threshold,
  weighted-requires-weights, minimum_confidence-range, designated_role; fixed the
  veto-threshold-off check to flag any presence of `veto_threshold`, including `0`, when
  `critical_severity_vetoes` is false; kept the stricter-than-upstream veto-threshold-on check
  with an explanatory comment), `src/policy/policy-loader.service.spec.ts` (inverted the
  `veto_threshold: 0`/`critical_severity_vetoes: false` test per the plan; updated 8 tests that
  exercised the 4 deleted checks to assert against the schema's own formatted messages instead
  of dropping the coverage; fixed a `jest.mock('node:fs')` interaction — `PolicyLoaderService`'s
  constructor now also builds a real `PolicyRulesValidator`, which reads real vendored schema
  files via `fs.readFileSync`, so three tests using an unconditional `mockReturnValue(...)`
  needed to switch to a delegating stand-in that forwards schema-path reads to the real
  filesystem), `policies/policy.default.json`, `policies/policy.claims.majority.json`,
  `policies/policy.fraud.supermajority.json` (removed `objection_handling.veto_threshold: 0`
  entirely — the schema-conformant way to say "vetoes off," not setting it to a different
  value), `src/policy/policies-on-disk.spec.ts` (new permanent CI-gate block calling
  `PolicyRulesValidator` directly against all 6 shipped files' `rules`, keyed by each file's
  own `mode` including `"*"`, plus the full-descriptor pass).
- Verification: `npm run build`/`lint`/`format:check` clean; full unit suite 467/467 (+13, up
  from 454) across 43 suites; `npm run test:cov` 87.91/74.95/90.68/88.94 vs. floor
  83/67/85/84; `npm run test:e2e` 31/31; `npm run test:integration` (mock) 78/78. Sanity-checked
  the new CI gate itself (plan AC #1) by temporarily reintroducing `veto_threshold: 0` into
  `policy.default.json`, confirming `policies-on-disk.spec.ts` went red (3 failures: the two
  new per-mode/wildcard assertions plus the descriptor pass), then reverting — first attempt
  at reverting used a blanket `git checkout -- <file>` which incorrectly discarded the
  legitimate Phase 2 fix along with the temporary probe (both were uncommitted at the time);
  caught immediately via the harness's own file-change diff and re-applied the real fix. Noted
  here as a self-correction, not a silent fix — no data was actually lost since the intended
  content was already known and simply re-applied.
- Pre-existing test `policies-on-disk.spec.ts`'s `'passes PolicyLoaderService.validatePolicy()
  with zero warnings for every shipped file'` confirmed unmodified in source, per plan AC #3 —
  the module-level/constructor-internal `PolicyRulesValidator` instantiation choice (not DI)
  is exactly what kept this call site, and the other 6 `new PolicyLoaderService()` sites
  across the spec files, untouched.
- What's next: fresh Opus verifier result for Phase 2 (pending); then Phase 3 (docs sweep +
  `scripts/scenario/lint.ts` CLI integration + new committed negative-fixture test in
  `test/integration/scenario-cli.integration.spec.ts`) — inside the isolated worktree.
