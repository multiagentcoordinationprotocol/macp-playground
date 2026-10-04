# MACP Playground

File-backed showcase service for [Multi-Agent Coordination Protocol](https://github.com/multiagentcoordinationprotocol) demos, combining scenario catalog, compilation, and example-agent bootstrap in a single service.

> This service is a showcase/examples layer used to demonstrate scenarios and sample agents for MACP. It intentionally combines catalog, compilation, and sample agent hosting for simplicity. It is not the production system boundary.

## Quick Start

Requires Node **22.22.3+** (CI and the shipped image use Node 26). `npm install` pulls one transitive package (`@multiagentcoordinationprotocol/proto`) from GitHub Packages, so your npm config needs a GitHub token with `read:packages`.

```bash
npm install
MACP_AUTH_SERVICE_URL=http://localhost:3200 npm run start:dev
```

`MACP_AUTH_SERVICE_URL` must be set to boot (any value works for the catalog and compile routes) — see [docs/deployment.md](docs/deployment.md). The service does not read `.env` on its own; export variables or use your own loader.

The server starts on `http://localhost:3000`. Swagger docs are available at `/docs` in development mode.

### Try it

```bash
# List packs
curl http://localhost:3000/packs

# List scenarios in a pack
curl http://localhost:3000/packs/fraud/scenarios

# Get launch schema with agent previews
curl http://localhost:3000/packs/fraud/scenarios/high-value-new-device/versions/1.0.0/launch-schema

# Compile a launch (returns a CompileLaunchResult)
curl -X POST http://localhost:3000/launch/compile \
  -H 'Content-Type: application/json' \
  -d '{
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
  }'

# Run a full example (compile + spawn agents). Agents need a reachable runtime
# (MACP_RUNTIME_ADDRESS) and auth-service; see "Docker" below for the full stack.
# The control plane is contacted only when MACP_CONTROL_PLANE_URL is set.
curl -X POST http://localhost:3000/examples/run \
  -H 'Content-Type: application/json' \
  -d '{
    "scenarioRef": "fraud/high-value-new-device@1.0.0",
    "templateId": "strict-risk",
    "inputs": {
      "transactionAmount": 3200,
      "deviceTrustScore": 0.12,
      "accountAgeDays": 5,
      "isVipCustomer": true,
      "priorChargebacks": 1
    }
  }'
```

## API Endpoints

Health (`GET /healthz`), catalog (`/packs`, `/scenarios`, launch schemas), agent profiles (`/agents`), compile (`POST /launch/compile`), and the full showcase run (`POST /examples/run`). Swagger UI is served at `/docs` in development.

See [docs/api-reference.md](docs/api-reference.md) for every endpoint, request/response shape, and error code.

## Architecture

The service combines three concerns for demo simplicity:

- **Catalog** — browse packs and scenarios from YAML files on disk
- **Compiler** — validate inputs (AJV JSON Schema) and compile a `CompileLaunchResult` — a scenario-agnostic `runDescriptor`, an initiator-only `initiator` payload, and internal `scenarioMeta` — with `{{ inputs.* }}` template substitution
- **Hosting** — resolve example agents (fraud, growth, compliance, risk), mint each a JWT, and spawn them with a bootstrap file

See [docs/architecture.md](docs/architecture.md) for the full module structure and data flow.

## Example Agents

Four demo agents are included:

| Agent | Framework | Role |
|-------|-----------|------|
| Fraud Agent | LangGraph | Evaluates device, chargeback, and identity-risk signals |
| Growth Agent | LangChain | Assesses customer value and revenue impact |
| Compliance Agent | CrewAI | Applies KYC/AML policy checks |
| Risk Agent | Custom | Coordinates the final recommendation |

All agents use an **active process-backed** hosting strategy. Python and Node.js worker processes are spawned per run and authenticate directly to the MACP runtime over gRPC with their own bearer tokens ([RFC-MACP-0004 §4](https://github.com/multiagentcoordinationprotocol/multiagentcoordinationprotocol/blob/main/rfcs/RFC-MACP-0004-security.md)) — the control plane keeps observer-only responsibilities. Each agent receives its identity, token and session details in a bootstrap file; see [docs/direct-agent-auth.md](docs/direct-agent-auth.md) and [docs/worker-bootstrap-contract.md](docs/worker-bootstrap-contract.md).

## Authoring a scenario

Internal-only authoring workflow — no public CRUD surface. The fastest path uses the bundled CLI:

```bash
npm run scenario:new -- demo my-sample           # scaffold packs/demo/scenarios/my-sample/1.0.0/
$EDITOR packs/demo/scenarios/my-sample/1.0.0/scenario.yaml
echo '{"sampleField":"hello"}' > /tmp/inputs.json
npm run scenario:validate -- packs/demo/scenarios/my-sample/1.0.0/scenario.yaml
npm run scenario:dry-run  -- 'demo/my-sample@1.0.0' --inputs /tmp/inputs.json
npm run scenario:lint     -- packs                # static checks across every pack
```

Bulky data and shared fragments can live outside `scenario.yaml` via the `!include` tag (inlined at load time), with cross-pack fragments under `packs/_shared/`.

See [`docs/scenario-authoring.md`](docs/scenario-authoring.md) for the pack layout, full YAML reference, `!include` and `_shared/`, and [`docs/scenario-cli.md`](docs/scenario-cli.md) for the CLI reference (commands, exit codes, troubleshooting).

## Configuration

Configuration is entirely through environment variables. The only one required to boot is `MACP_AUTH_SERVICE_URL`; running sessions also needs `MACP_RUNTIME_ADDRESS`. See [docs/deployment.md § Environment Variables](docs/deployment.md#environment-variables) for the full reference, and [`.env.example`](.env.example) for a starting point.

## Deployment

This backend is designed to run alongside a Vercel-hosted frontend.

```
┌─────────────┐         ┌──────────────────────┐
│  Vercel      │  HTTPS  │  Railway / Render     │
│  (UI)        │────────▶│  (macp-playground)   │
└─────────────┘         └──────────────────────┘
```

### Deploy to Railway

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/template)

1. Connect your GitHub repo
2. Railway auto-detects the `Dockerfile`
3. Set environment variables:

```
NODE_ENV=production
MACP_AUTH_SERVICE_URL=https://your-auth-service.example.com
MACP_RUNTIME_ADDRESS=your-runtime.example.com:50051
CORS_ORIGIN=https://your-app.vercel.app,https://your-app-*.vercel.app
AUTH_API_KEYS=<generate-a-secret-key>
REGISTRY_CACHE_TTL_MS=60000
```

The auth-service and runtime must be deployed alongside — see [docs/deployment.md](docs/deployment.md#required-sidecars). Building the `Dockerfile` from source needs a `NODE_AUTH_TOKEN` build argument (a GitHub token with `read:packages`); deploying the prebuilt `ghcr.io/multiagentcoordinationprotocol/macp-playground` image avoids that.

### Deploy to Render

1. Create a new **Web Service** from your GitHub repo and choose the **Docker** runtime (Render builds the `Dockerfile`), or deploy the prebuilt GHCR image
2. Set the same environment variables as above

### Frontend (Vercel) setup

The UI console (`macp-ui-console`) proxies to this service server-side. Set in your Vercel project:

```
MACP_PLAYGROUND_BASE_URL=https://your-backend.railway.app
MACP_PLAYGROUND_API_KEY=<one of AUTH_API_KEYS>
```

### CORS for Vercel preview URLs

Vercel generates unique URLs per PR (e.g. `myapp-git-branch-name.vercel.app`). Use wildcards:

```
CORS_ORIGIN=https://your-app.vercel.app,https://your-app-*.vercel.app
```

## Development

```bash
npm run build              # Compile TypeScript (src/ only)
npm run typecheck          # Type-check src/ + scripts/ + test/ (CI gate)
npm run start:dev          # Dev mode with auto-reload
npm test                   # Unit tests
npm run test:e2e           # E2E tests
npm run test:integration   # Integration tests (mock control plane)
npm run test:cov           # Coverage report (global thresholds enforced)
npm run lint               # ESLint
npm run format             # Prettier (write)
npm run format:check       # Prettier check only (CI gate)
npm run schemas:sync       # Diff vendored policy schemas against the spec repo (report only)

# Python workers
pip install -r agents/requirements-dev.txt
ruff check agents/         # Lint the framework workers
pytest agents/tests        # Worker mapper unit tests

# Scenario authoring
npm run scenario:new       # Scaffold a new scenario directory tree
npm run scenario:validate  # Validate a scenario (includes, schema, fixtures, agentRefs)
npm run scenario:dry-run   # Compile a scenario offline and print the CompileLaunchResult
npm run scenario:lint      # Static checks across one or more packs
```

## Docker

```bash
# Development: playground + auth-service sidecar (built from ../auth-service). Start a runtime separately.
docker compose -f docker-compose.dev.yml up

# Full stack: runtime + auth-service + control-plane + postgres + playground, real LLM calls.
# Needs locally built :0.8.0 images of control-plane, auth-service and playground.
OPENAI_API_KEY=sk-... docker compose -f docker-compose.fullstack.yml up
```


`docker-compose.yml` and `docker-compose.dev.yml` build the image from the `Dockerfile`, which installs `@multiagentcoordinationprotocol/proto` from GitHub Packages: export `NODE_AUTH_TOKEN` (a GitHub token with `read:packages`) before `docker compose ... up --build`. Details and the plain `docker-compose.yml` defaults: [docs/deployment.md § Local Testing](docs/deployment.md#local-testing).

## License

Apache-2.0
