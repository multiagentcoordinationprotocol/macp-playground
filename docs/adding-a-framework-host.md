# Adding a Framework Host

This guide explains how to add support for a new agent framework (e.g., AutoGen, Semantic Kernel, OpenAI Agents SDK).

> Worker-side details — the `Participant` lifecycle, `ctx.actions` API,
> handler dispatch, and `fromBootstrap()` semantics — are canonically
> documented in the SDK guides
> ([Python](https://github.com/multiagentcoordinationprotocol/macp-sdk-python/blob/main/docs/guides/agent-framework.md),
> [TypeScript](https://github.com/multiagentcoordinationprotocol/macp-sdk-typescript/blob/main/docs/guides/agent-framework.md)).
> This guide only covers the macp-playground wiring (adapter, catalog
> entry, manifest, tests).

## Step 1: Create a Host Adapter

Create `src/hosting/adapters/<framework>-host-adapter.ts`. The shape below mirrors
`src/hosting/adapters/langgraph-host-adapter.ts`, the simplest Python adapter:

```typescript
import { AgentHostAdapter, PrepareLaunchInput, PreparedLaunch } from '../contracts/host-adapter.types';
import { AgentFramework, AgentManifest, ManifestValidationResult } from '../contracts/manifest.types';
import { buildAgentEnv } from './agent-env';

const DEFAULT_STARTUP_TIMEOUT_MS = 30000;

export class MyFrameworkHostAdapter implements AgentHostAdapter {
  readonly framework: AgentFramework = 'myframework'; // add to the AgentFramework union first (Step 2)

  validateManifest(manifest: AgentManifest): ManifestValidationResult {
    const errors: string[] = [];
    if (manifest.framework !== 'myframework') {
      errors.push(`expected framework "myframework", got "${manifest.framework}"`);
    }
    if (!manifest.entrypoint?.value) {
      errors.push('entrypoint.value is required');
    }
    const entrypointType = manifest.entrypoint?.type;
    if (entrypointType && entrypointType !== 'python_module' && entrypointType !== 'python_file') {
      errors.push(`myframework entrypoint type must be python_module or python_file, got "${entrypointType}"`);
    }
    if (manifest.frameworkConfig && typeof manifest.frameworkConfig.myRequiredField !== 'string') {
      errors.push('frameworkConfig.myRequiredField is required and must be a string');
    }
    return { valid: errors.length === 0, errors };
  }

  prepareLaunch(input: PrepareLaunchInput): PreparedLaunch {
    const { manifest, bootstrap } = input;
    // The provider has already merged EXAMPLE_AGENT_PYTHON_PATH into manifest.host.python
    // (unless the manifest pins its own), so 'python3' is only a last resort.
    const pythonCmd = manifest.host?.python ?? 'python3';
    const entrypoint = manifest.entrypoint.value;
    const args =
      manifest.entrypoint.type === 'python_module'
        ? ['-m', entrypoint, ...(manifest.host?.args ?? [])]
        : [entrypoint, ...(manifest.host?.args ?? [])];

    return {
      command: pythonCmd,
      args,
      env: {
        ...(process.env as Record<string, string>),
        ...(manifest.host?.env ?? {}),
        PYTHONUNBUFFERED: '1',
        // MACP_PARTICIPANT_ID, MACP_RUN_ID, MACP_SESSION_ID, MACP_RUNTIME_ADDRESS,
        // MACP_RUNTIME_TOKEN, TLS + cancel-callback vars — all derived from the flat
        // BootstrapPayload (src/hosting/contracts/bootstrap.types.ts).
        ...buildAgentEnv(bootstrap, 'myframework'),
        EXAMPLE_AGENT_ENTRYPOINT: entrypoint
      },
      cwd: manifest.host?.cwd ?? process.cwd(),
      startupTimeoutMs: manifest.host?.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS
    };
  }
}
```

`BootstrapPayload` is **flat and snake_case** (`bootstrap.participant_id`,
`bootstrap.session_id`, `bootstrap.metadata?.run_id`, …) — there is no nested
`participant` / `run` object. Prefer `buildAgentEnv()` over reading fields
yourself. `buildAgentEnv` sets `MACP_BOOTSTRAP_FILE: ''`; `LaunchSupervisor`
overwrites it with the real path at spawn time, so do not set it in the adapter.
Field reference: [`worker-bootstrap-contract.md`](worker-bootstrap-contract.md).

## Step 2: Update the Framework Type

Add your framework to the union in `src/hosting/contracts/manifest.types.ts`:

```typescript
export type AgentFramework = 'langgraph' | 'langchain' | 'crewai' | 'custom' | 'myframework';
```

Also add it to `ExampleAgentFramework` in `src/contracts/example-agents.ts`, which
types the catalog entry in Step 6.

## Step 3: Register the Adapter

In `src/hosting/host-adapter-registry.ts`, add:

```typescript
import { MyFrameworkHostAdapter } from './adapters/myframework-host-adapter';

// In constructor:
this.register(new MyFrameworkHostAdapter());
```

## Step 4: Create a Worker Package

Create `agents/myframework_worker/` with:

- `__init__.py`
- `main.py` — entry point that uses the SDK
- `<framework_specific>.py` — framework setup (graph, chain, crew, etc.)
- `mappers.py` — input/output mappers

Example `main.py` using the upstream `macp_sdk` Participant abstraction (the
local `macp_worker_sdk` was removed in April 2026; Python workers now depend
on [`macp-sdk-python`](https://github.com/multiagentcoordinationprotocol/macp-sdk-python)
from PyPI directly — pinned in `agents/requirements.txt`, imported as `macp_sdk`):

```python
#!/usr/bin/env python3
import json, logging, os

from macp_sdk.agent import from_bootstrap

from my_framework import build_model
from mappers import map_kickoff_to_inputs

logger = logging.getLogger("macp.agent")


def _session_context() -> dict:
    path = os.environ.get("MACP_BOOTSTRAP_FILE", "")
    if not path:
        return {}
    with open(path) as f:
        data = json.load(f)
    return (data.get("metadata") or {}).get("session_context") or {}


def main() -> int:
    participant = from_bootstrap()
    model = build_model()
    session_context = _session_context()

    def handle_proposal(message, ctx):
        output = model.invoke(map_kickoff_to_inputs(session_context))
        ctx.actions.evaluate(
            message.proposal_id or "",
            output.get("recommendation", "REVIEW"),
            confidence=output.get("confidence", 0.5),
            reason=output.get("reason", "model evaluation"),
        )
        logger.info("evaluation sent proposalId=%s", message.proposal_id)
        participant.stop()

    participant.on("Proposal", handle_proposal)
    participant.run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

See the SDK agent-framework guides linked at the top of this doc for the
full `Participant` / `ctx.actions` surface. The macp-playground itself
does not own that contract.

### Emitting ambient Signal / Progress envelopes (optional)

For diagnostics or session-level metadata, a worker can emit ambient
envelopes (`mode=""`, `session_id=""`). The JWT minted for every spawn
includes `""` in `allowed_modes` for this purpose — see
[`direct-agent-auth.md` § Ambient envelopes](direct-agent-auth.md#ambient-envelopes-signal--progress).

Use the SDK's ambient helpers rather than building envelopes yourself:
`MacpClient.send_signal()` / `send_progress()` in
[`macp-sdk-python`](https://github.com/multiagentcoordinationprotocol/macp-sdk-python/blob/main/src/macp_sdk/client.py)
and `client.sendSignal()` / `sendProgress()` in
[`macp-sdk-typescript`](https://github.com/multiagentcoordinationprotocol/macp-sdk-typescript/blob/main/docs/api/client.md#sendsignaloptions).
They enforce the RFC-MACP-0001 shape rules (empty envelope `session_id`/`mode`
for Signal; Progress either fully ambient or fully session-scoped) that a
hand-built envelope gets wrong silently. The shipped Python workers' `emit_signal`
/ `emit_progress` helpers predate that guidance and still call
`macp_sdk.envelope.build_envelope` + `ctx.actions.send_envelope` directly — do
not copy them into a new worker.

## Step 5: Create a Manifest

Create `agents/manifests/my-agent.json`. Manifests are required — `loadManifest()` throws `INVALID_CONFIG` at service startup if the file is missing or unparseable.

```json
{
  "id": "my-agent",
  "name": "My Agent",
  "framework": "myframework",
  "version": "1.0.0",
  "entrypoint": {
    "type": "python_file",
    "value": "agents/myframework_worker/main.py"
  },
  "host": {
    "cwd": ".",
    "env": { "PYTHONUNBUFFERED": "1" },
    "startupTimeoutMs": 30000
  },
  "frameworkConfig": {
    "myRequiredField": "value"
  }
}
```

**Do not set `host.python` or `host.node`.** A manifest that names its own interpreter
silently beats the deployment-wide `EXAMPLE_AGENT_PYTHON_PATH` /
`EXAMPLE_AGENT_NODE_PATH`, and `src/hosting/shipped-manifests.spec.ts` fails CI for any
manifest in `agents/manifests/` that does.

## Step 6: Register in the Agent Catalog

Add an entry to `EXAMPLE_AGENT_DEFINITIONS` in `src/example-agents/example-agent-catalog.service.ts`.

## Step 7: Add Tests

- Unit test for the adapter in `src/hosting/adapters/adapters.spec.ts`
- `src/hosting/shipped-manifests.spec.ts` picks up the new manifest automatically
  (it must not pin an interpreter — see Step 5)
- Mapper unit tests in `agents/tests/` (run with `pytest agents/tests`), and keep
  `ruff check agents/` clean
- Add the agent to an existing scenario or create a new one
- Run `npm test`, `npm run test:e2e`, and `npm run test:integration`

## Key Rules

1. **Never let framework code leak into controllers or compiler** — all framework logic stays in adapters and worker packages
2. **Outbound envelopes go through the SDK** — mode messages via the handler context's `ctx.actions.{evaluate,vote,commit,...}` (both SDKs), ambient Signal/Progress via the client's `send_signal`/`sendSignal` helpers. Do NOT construct envelopes by hand; do NOT POST to any control-plane `/runs/:id/messages` route (deleted).
3. **Workers never call the control plane** — the control plane is an
   observer-only projection. All read and write traffic flows through the
   per-agent gRPC channel to the runtime, authenticated with
   `bootstrap.auth_token`.
4. **Validate manifests before spawn** — bad config should fail fast with clear errors
5. **Framework workers must gracefully fall back** when framework libraries aren't installed
6. **Respect direct-agent-auth invariants** — identity flows through `bootstrap.auth_token` (mirrored to the `MACP_RUNTIME_TOKEN` env var by `src/hosting/adapters/agent-env.ts`); the SDK enforces `expectedSender` matching the authenticated sender (RFC-MACP-0004 §4). See `docs/direct-agent-auth.md` for the end-to-end flow.
