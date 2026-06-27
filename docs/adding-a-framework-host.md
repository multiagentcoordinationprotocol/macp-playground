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

Create `src/hosting/adapters/<framework>-host-adapter.ts`:

```typescript
import { AgentHostAdapter, PrepareLaunchInput, PreparedLaunch } from '../contracts/host-adapter.types';
import { AgentFramework, AgentManifest, ManifestValidationResult } from '../contracts/manifest.types';

export class MyFrameworkHostAdapter implements AgentHostAdapter {
  readonly framework: AgentFramework = 'myframework';  // add to AgentFramework union first

  validateManifest(manifest: AgentManifest): ManifestValidationResult {
    const errors: string[] = [];
    // Validate framework-specific requirements
    if (!manifest.frameworkConfig?.myRequiredField) {
      errors.push('frameworkConfig.myRequiredField is required');
    }
    return { valid: errors.length === 0, errors };
  }

  prepareLaunch(input: PrepareLaunchInput): PreparedLaunch {
    const { manifest, bootstrap } = input;
    return {
      command: manifest.host?.python ?? 'python3',
      args: [manifest.entrypoint.value],
      env: {
        ...process.env as Record<string, string>,
        MACP_BOOTSTRAP_FILE: '',
        MACP_CONTROL_PLANE_URL: bootstrap.runtime.baseUrl,
        MACP_FRAMEWORK: 'myframework',
        MACP_PARTICIPANT_ID: bootstrap.participant.participantId,
        MACP_RUN_ID: bootstrap.run.runId,
      },
      cwd: manifest.host?.cwd ?? process.cwd(),
      startupTimeoutMs: manifest.host?.startupTimeoutMs ?? 30000,
    };
  }
}
```

## Step 2: Update the Framework Type

Add your framework to the union in `src/hosting/contracts/manifest.types.ts`:

```typescript
export type AgentFramework = 'langgraph' | 'langchain' | 'crewai' | 'custom' | 'myframework';
```

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
on `macp-sdk` from PyPI directly):

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
`docs/direct-agent-auth.md` § "Ambient envelopes". Example (Python, matching
`agents/langchain_worker/main.py`):

```python
from macp_sdk.envelopes import build_envelope, build_signal_payload

payload = build_signal_payload(
    signal_type="worker.heartbeat",
    data=b"{}",
    confidence=1.0,
    correlation_session_id=participant.session_id,
)
envelope = build_envelope(
    mode="",
    message_type="Signal",
    session_id="",
    sender=participant.participant_id,
    payload=payload,
)
participant.client.send(envelope, auth=participant.auth)
```

## Step 5: Create a Manifest

Create `agents/manifests/my-agent.json`. Manifests are required — `loadManifest()` throws `INVALID_CONFIG` at service startup if the file is missing.



```json
{
  "id": "my-agent",
  "name": "My Agent",
  "framework": "myframework",
  "entrypoint": {
    "type": "python_file",
    "value": "agents/myframework_worker/main.py"
  },
  "frameworkConfig": {
    "myRequiredField": "value"
  }
}
```

## Step 6: Register in the Agent Catalog

Add an entry to `EXAMPLE_AGENT_DEFINITIONS` in `src/example-agents/example-agent-catalog.service.ts`.

## Step 7: Add Tests

- Unit test for the adapter in `src/hosting/adapters/adapters.spec.ts`
- Add the agent to an existing scenario or create a new one
- Run `npm test`, `npm run test:e2e`, and `npm run test:integration`

## Key Rules

1. **Never let framework code leak into controllers or compiler** — all framework logic stays in adapters and worker packages
2. **Outbound envelopes go through the SDK mode-helpers** — use `macp_sdk.DecisionSession.{evaluate,vote,commit,...}` (Python) or `macp-sdk-typescript` `DecisionSession` (Node). Do NOT construct envelopes by hand; do NOT POST to any control-plane `/runs/:id/messages` route (deleted).
3. **Workers never call the control plane** — the control plane is an
   observer-only projection. All read and write traffic flows through the
   per-agent gRPC channel to the runtime, authenticated with
   `bootstrap.auth_token`.
4. **Validate manifests before spawn** — bad config should fail fast with clear errors
5. **Framework workers must gracefully fall back** when framework libraries aren't installed
6. **Respect direct-agent-auth invariants** — identity flows through `bootstrap.runtime.bearerToken`; the SDK enforces `expectedSender` matching the authenticated sender (RFC-MACP-0004 §4). See `docs/direct-agent-auth.md` for the end-to-end flow.
