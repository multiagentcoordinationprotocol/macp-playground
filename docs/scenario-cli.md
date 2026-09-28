# Scenario Authoring CLI

A small developer-facing CLI that lets you scaffold, validate, dry-run, and lint scenario packs without booting the HTTP server. Internal authoring tool — not exposed over HTTP.

> Authoring format reference: [`scenario-authoring.md`](./scenario-authoring.md).

## Quickstart

From nothing to a validated, dry-run-proven scenario in three commands:

```bash
npm run scenario:new demo my-sample
$EDITOR packs/demo/scenarios/my-sample/1.0.0/scenario.yaml
echo '{"sampleField":"hello"}' > /tmp/inputs.json
npm run scenario:validate -- packs/demo/scenarios/my-sample/1.0.0/scenario.yaml
npm run scenario:dry-run -- 'demo/my-sample@1.0.0' --inputs /tmp/inputs.json
```

> Note the `--` after the script name. npm passes everything after it through to the underlying script verbatim.

## Commands

### `scenario:validate`

```bash
npm run scenario:validate -- <path-to-scenario.yaml> [--packs-root <dir>]
```

Loads a scenario file (resolving any `!include` tags), checks structure, compiles `inputs.schema` with the same AJV instance the HTTP path uses, validates every fixture under the scenario's `fixtures/` directory, walks every `{{ inputs.* }}` placeholder to confirm it's reachable from the schema or a fixture, and cross-checks every `participants[].agentRef` against the example-agent catalog.

| Exit | Meaning |
|---|---|
| `0` | Pass (may include warnings). |
| `1` | At least one error. |

Example pass output:
```
scenario:validate  packs/fraud/scenarios/high-value-new-device/1.0.0/scenario.yaml
  OK
```

Example failure:
```
  FAIL  participant risk-agent agentRef "missing-agent" is not in the example-agent catalog
  FAIL  placeholder {{ inputs.unknown }} is not satisfied by schema defaults or any fixture
  FAILED (2 error(s), 0 warning(s))
```

### `scenario:dry-run`

```bash
npm run scenario:dry-run -- <scenarioRef> --inputs <file.json> [--template <slug>] [--mode live|sandbox] [--packs-root <dir>]
```

Runs `CompilerService.compile()` offline against `<scenarioRef>` and `<file.json>` and prints the resulting `ExecutionRequest` as pretty JSON. This is the **same code path** as `POST /launch/compile`, so the output matches byte-for-byte (the integration tests assert this).

| Exit | Meaning |
|---|---|
| `0` | Compile succeeded; ExecutionRequest printed to stdout. |
| `1` | Validation failure, missing scenario, or other compile error. Error code printed to stderr. |

### `scenario:new`

```bash
npm run scenario:new -- <pack> <scenario> [--version 1.0.0] [--from <scenarioRef>] [--packs-root <dir>]
```

Scaffolds `packs/<pack>/scenarios/<scenario>/<version>/` with a starter `scenario.yaml`, `templates/default.yaml`, and a `fixtures/sample.json`. Auto-creates `packs/<pack>/pack.yaml` if the pack doesn't exist yet.

With `--from fraud/high-value-new-device@1.0.0`, copies an existing scenario directory and rewrites the `pack` / `scenario` / `version` metadata. Useful for forking a scenario for a variant.

Refuses to overwrite an existing version directory. Slugs must be kebab-case (`[a-z0-9][a-z0-9-]*`).

> **`--version` now actually works.** From the CLI's first commit until September 2026 it did not:
> the program-level `-V, --version` flag shadowed this option, so `--version 1.2.3` printed the
> CLI's own version (`0.2.0`), exited **0**, and scaffolded **nothing** — while this page documented
> it as working. The program's flag is now `-V, --cli-version`, which frees `--version` for this
> subcommand. If you scripted around the bug by omitting `--version` and renaming the `1.0.0`
> directory afterwards, that workaround is no longer needed.

### Printing the CLI's own version

```bash
npm run scenario -- --cli-version      # -> 0.2.0
```

Deliberately **not** `--version`: that spelling belongs to `scenario:new`'s `--version <semver>`
option (see above), and commander resolves a program/subcommand collision in favour of the program.
A bare `npm run scenario -- --version` is now an unknown-option error rather than a silent no-op.

### `scenario:lint`

```bash
npm run scenario:lint -- <target> [--packs-root <dir>]
```

Static checks across one or more packs. Pass either a single pack directory (`packs/fraud`) or the packs root (`packs`).

Rules:
- Pack and scenario slugs are kebab-case.
- Every commitment has a non-empty `description`.
- `policyVersion` resolves to a file under `policies/` or to `policy.default`.
- Every `participants[].agentRef` exists in the example-agent catalog.
- Templates whose `overrides.launch.commitments` array is shorter than the scenario's commitments emit a warning (arrays REPLACE entirely; partial = probably a mistake).
- Files under `data/` that aren't referenced by any `!include` are flagged as orphans.

| Exit | Meaning |
|---|---|
| `0` | No errors. Warnings may still print. |
| `1` | At least one error. |

## CI integration

Add to `.github/workflows/ci.yml`:

```yaml
- name: Lint scenario packs
  run: npm run scenario:lint -- packs

- name: Validate every scenario
  run: |
    set -euo pipefail
    find packs -mindepth 4 -maxdepth 4 -name scenario.yaml | while read scenario; do
      npm run scenario:validate -- "$scenario"
    done
```

## Troubleshooting

**`!include path escapes PACKS_DIR`** — your relative path resolved outside the packs root. Adjust the `..`-segments. The error message shows which file contained the bad include.

**`!include cycle detected`** — A → B → A loop. Refactor so one of the two stops referencing the other.

**`!include target not found`** — typo or wrong relative path. Remember: paths are resolved relative to the file containing the `!include`, not relative to the scenario root.

**Dry-run output looks polluted** — the dry-run command silences Nest's logger to keep stdout clean JSON. If you're seeing log lines mixed in, you've probably wired a custom logger that bypasses `Logger.overrideLogger(false)` in `scripts/scenario/dry-run.ts`.

**`participant X agentRef "..." is not in the example-agent catalog`** — `agentRef` must match an entry in `src/example-agents/example-agent-catalog.service.ts`. Either fix the typo or add the agent to the catalog.

## Implementation notes

- The CLI re-uses `FileRegistryLoader`, `RegistryIndexService`, `CompilerService`, the AJV factory at `src/compiler/ajv-factory.ts`, and `ExampleAgentCatalogService` from the main service. There is no parallel implementation — drift between CLI and HTTP outputs is impossible by construction.
- All four subcommands lazy-load their handlers, so `scenario:dry-run` doesn't pay the cost of importing the lint/validate machinery.
- Source: `scripts/scenario.ts` (dispatcher) and `scripts/scenario/{validate,dry-run,new,lint}.ts`.
