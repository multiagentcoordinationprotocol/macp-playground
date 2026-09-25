# ASSUMPTIONS

Logged during `/drive`/`/implement` runs. Each entry tags the plan it belongs to.
Resolved by `/reconcile`; see `DECISIONS.md` once that's run.

This worktree carries only the one assumption logged for `plans/policy-rule-schema-validation.md`
(issue #81) — the shared main-directory `ASSUMPTIONS.md` also carries entries for other,
unrelated plans (`absorb-runtime-v0.8.0`, `example-agent-domain-scoring`) that belong to other
branches/worktrees, not this one. See this branch's own `PROGRESS.md` for why this worktree
keeps a self-contained copy rather than referencing the shared file.

## `mode: "*"` validated against the Decision rules schema
- **Plan:** `plans/policy-rule-schema-validation.md`, Phase 1, Open Question 1
- **Assumed:** Every policy this repo has ever shipped that uses the wildcard mode string
  (`"*"`, only `policy.default.json`) uses the exact same `rules` sub-object shape as
  `macp.mode.decision.v1`, and every scenario pack in this repo runs `macp.mode.decision.v1`
  exclusively (confirmed: exactly 4 occurrences of that mode string across `packs/`, no
  others) — so validating a `"*"`-mode policy against the decision rules schema is the correct
  choice, not an arbitrary default.
- **Chose:** `PolicyRulesValidator.validateRules()` (`src/policy/policy-rules-validator.ts`)
  dispatches `mode === '*'` to the `macp.mode.decision.v1` schema (`WILDCARD_MODE` /
  `WILDCARD_MODE_SCHEMA` constants), documented inline at the class's construction site.
- **Alternatives:** (a) skip validation entirely for wildcard-mode policies — rejected, would
  leave `policy.default.json` with zero real schema coverage, defeating the point of this
  plan for the one file that most needs it (`veto_threshold: 0` was one of the 3 originally
  non-conformant files, and it uses `"*"`). (b) add a dedicated "wildcard" schema — rejected as
  unfounded; the upstream spec repo defines no such schema, and there is no evidence any
  wildcard-mode `rules` object would ever need a shape different from decision's.
- **Blast radius if wrong:** `policy.default.json` would validate against the wrong schema and
  either false-pass or false-fail — caught immediately by Phase 2's CI gate
  (`policies-on-disk.spec.ts`'s real-schema-conformance assertion), so the blast radius is a
  build failure surfaced in CI, not a silent runtime issue. Cheap to reverse: a one-line
  dispatch change in `PolicyRulesValidator`.
- **Status:** UNCONFIRMED (2026-09-25) — logged for `/reconcile` to close out later; not
  settled during Phase 1 implementation itself per the plan's own Open Questions note (`/plan`
  records the decision and its reasoning, `/implement` writes the tracked assumption).
