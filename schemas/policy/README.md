# Vendored policy rule schemas

These 6 files are byte-for-byte copies from the spec repo
`multiagentcoordinationprotocol/multiagentcoordinationprotocol`, vendored because this
repo has no submodule, npm package, or fetch step that pulls them in, and CI cannot depend
on a sibling checkout existing.

| File | Source path |
|------|-------------|
| `decision-rules.schema.json` | `schemas/json/policy/decision-rules.schema.json` |
| `quorum-rules.schema.json` | `schemas/json/policy/quorum-rules.schema.json` |
| `proposal-rules.schema.json` | `schemas/json/policy/proposal-rules.schema.json` |
| `task-rules.schema.json` | `schemas/json/policy/task-rules.schema.json` |
| `handoff-rules.schema.json` | `schemas/json/policy/handoff-rules.schema.json` |
| `policy-descriptor.schema.json` | `schemas/json/macp-policy-descriptor.schema.json` (note: one directory level up from the 5 rule schemas above, and renamed here for a consistent `*-*.schema.json` naming convention) |

Vendored at commit `579d49b82aff2c8441ab5dfcbd22d62666471b0a`.

## Re-syncing

There is no automated re-sync — this is a manually-triggered copy, not a submodule. To
check for drift or pull a newer version:

```bash
npm run schemas:sync
```

This fetches the same 6 files at the ref the script is pointed at into a scratch
directory and diffs them against this directory, reporting drift without modifying
anything. A **non-blocking** CI job runs the same check on every push, so staleness is
surfaced automatically — but nothing enforces a re-sync; a human has to act on the
signal. See `plans/policy-rule-schema-validation.md`'s "Long-term posture" for why this
level of automation (surfaced, not enforced) is the right scope for a demo-service-sized
policy set.

If the spec repo tightens or changes these schemas again, re-run the sync script, review
the diff, and update `src/policy/policy-rules-validator.ts` / `src/contracts/policy.ts`
for anything the new shape requires.
