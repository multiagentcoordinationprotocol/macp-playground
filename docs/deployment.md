# Deployment

## Principle

The repo is **fully platform-agnostic**. The `Dockerfile` is the only deployment contract — no platform-specific config files in the repo. All platform settings live in each platform's dashboard.

## Required sidecars

The service **boots** with a single requirement: `MACP_AUTH_SERVICE_URL` must be set. `AppConfigService.onModuleInit` rejects an empty value with `INVALID_CONFIG`, but nothing contacts the URL at boot, so any syntactically valid value starts the process (CI's container boot probe uses `http://127.0.0.1:9/unused`). Note the failure happens *after* every route is mapped, so a missing URL looks like a startup that hangs rather than a config error.

To actually **run sessions** (`POST /examples/run` with agent bootstrap), two more services must be reachable:

| Service | Why it's required | How to run it |
|---------|-------------------|---------------|
| **MACP runtime** (gRPC) | Agents open their own gRPC channels to the runtime ([RFC-MACP-0004 §4](https://github.com/multiagentcoordinationprotocol/multiagentcoordinationprotocol/blob/main/rfcs/RFC-MACP-0004-security.md)). `MACP_RUNTIME_ADDRESS` must point to a live runtime. | See [`macp-runtime/docs/deployment.md`](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/deployment.md). |
| **auth-service** (HTTP) | Every agent spawn mints a short-lived JWT via `POST /tokens` ([wire format](https://github.com/multiagentcoordinationprotocol/macp-auth-service/blob/main/docs/API.md#post-tokens)); `PolicyRegistrarService` mints an admin JWT at startup to register scenario policies. | `docker-compose.dev.yml` runs it as a sidecar; in production, deploy the auth-service image alongside the runtime ([`macp-auth-service/docs/deployment.md`](https://github.com/multiagentcoordinationprotocol/macp-auth-service/blob/main/docs/deployment.md)). |

The control-plane is optional: set `MACP_CONTROL_PLANE_URL` to register each run with it (CP-1 `POST /runs`, best-effort and non-fatal — see [direct-agent-auth.md § CP-1 run registration](./direct-agent-auth.md#cp-1-run-registration)).

The runtime must be configured to accept JWTs minted by the same auth-service (`MACP_AUTH_ISSUER`, `MACP_AUTH_AUDIENCE`, `MACP_AUTH_JWKS_URL=<auth-service>/.well-known/jwks.json`). For the full setup see [`macp-runtime/docs/getting-started.md` § JWT mode](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/getting-started.md#jwt-mode) and [`macp-auth-service/docs/integration.md`](https://github.com/multiagentcoordinationprotocol/macp-auth-service/blob/main/docs/integration.md).

**Pinned versions.** `docker-compose.fullstack.yml` pins the runtime to `ghcr.io/multiagentcoordinationprotocol/macp-runtime:0.8.6` and uses locally built `:0.8.0` images for the control-plane, auth-service and playground. Runtime behaviour that matters to operators (`MACP_ALLOW_INSECURE`, JWT algorithm allowlist, `MACP_METRICS_ADDR`, image tags) is documented in [`macp-runtime/docs/deployment.md`](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/deployment.md#environment-variables) and [§ Published image tags](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/deployment.md#published-image-tags).

**Node.** The service needs Node **22.22.3+** (the NestJS 12 toolchain's floor; NestJS 12 is ESM-only and loaded via `require(esm)`). CI and the shipped image both use Node 26.

### Startup order

```
auth-service up
  ↓
runtime up (with MACP_AUTH_JWKS_URL pointing at auth-service)
  ↓
macp-playground boots
  ├─ validates MACP_AUTH_SERVICE_URL is set (fails fast otherwise; never contacted here)
  └─ PolicyRegistrarService.onApplicationBootstrap()
       ├─ skips with a warning if MACP_RUNTIME_ADDRESS is unset
       ├─ mints admin JWT from auth-service (can_manage_mode_registry)
       ├─ opens gRPC channel to runtime
       └─ registers each non-default policy (idempotent)
  ↓
ready to accept POST /examples/run
```

Neither the runtime nor the auth-service being down stops the process from booting — `PolicyRegistrarService` logs and carries on. The failures surface at request time instead: an unreachable auth-service makes uncached agent mints fail with `AUTH_MINT_FAILED` (502), and a policy that never got registered makes launches that reference it fail with `UNKNOWN_POLICY_VERSION`. Watch the startup logs for `PolicyRegistrarService` warnings.

## Pipeline

```
push to main / any PR / manual dispatch (superseded runs on the same ref are cancelled)
  │
  ├─ lint          ESLint + Prettier check + typecheck (src/ + scripts/ + test/)
  │                + npm audit (non-blocking) + schemas:sync drift check (non-blocking)
  ├─ build         TypeScript compile
  ├─ test          unit (coverage thresholds, report artifact) + e2e + integration (mock)
  ├─ python        pip --dry-run resolution of agents/requirements.txt + constraints.txt
  │                + ruff + pytest (fallback scorers only) + compileall
  │
  └─ docker        needs all four jobs above
                   PR       → build + load image locally (no registry push)
                   non-PR   → build + push to GHCR (:sha-<commit>, plus :latest on main)
                   then, on EVERY event, against that exact image:
                     framework import smoke  (HAS_LANGCHAIN / HAS_LANGGRAPH / HAS_CREWAI)
                     framework construct smoke (dummy key, no LLM call)
                     framework-installed pytest
                     container boot probe    (runs dist/main.js, GET /healthz)
                     Trivy vulnerability scan (non-blocking)
```

`agents/tests` outside the image installs no frameworks, so it exercises only the deterministic fallback scorers; the image gates are what fail the build when a framework import or constructor breaks.

Dependency updates are automated by Dependabot (`.github/dependabot.yml`): monthly, grouped PRs for four ecosystems — npm (root), pip (`agents/`), GitHub Actions, and the Dockerfile base image. A few packages are deliberately capped by `ignore` rules (enforced by `src/dependabot-policy.spec.ts`).

## Image Tags

| Trigger | Tag | Purpose |
|---------|-----|---------|
| Push to `main` | `:latest` | Rolling production tag |
| Push to `main` / manual dispatch | `:sha-<commit>` | Immutable, for rollback |

Pull requests build the image for validation but do not push it. A manual `workflow_dispatch` run pushes a `:sha-<commit>` tag only; `:latest` moves only on `main`.

Images live at:
```
ghcr.io/multiagentcoordinationprotocol/macp-playground
```

## Deploying

Point any container platform at the GHCR image. No platform config files needed — configure everything in the platform's dashboard. Remember to deploy the auth-service sidecar in the same network.

### Railway

1. Create a service → set source to **Docker Image**
2. Image: `ghcr.io/multiagentcoordinationprotocol/macp-playground:latest`
3. Set env vars in the Variables tab

### Render

1. Create a Web Service → type **Docker Image**
2. Image: `ghcr.io/multiagentcoordinationprotocol/macp-playground:latest`
3. Set env vars in the Environment tab

### Fly.io

```bash
flyctl apps create macp-playground
flyctl deploy --image ghcr.io/multiagentcoordinationprotocol/macp-playground:latest
flyctl secrets set \
  MACP_RUNTIME_ADDRESS=runtime.internal:50051 \
  MACP_AUTH_SERVICE_URL=http://auth-service.internal:3200
```

### AWS ECS

1. Create an ECR repo, push the GHCR image (or point the task definition at GHCR directly)
2. Create ECS cluster + service + task definition referencing the image
3. Deploy the auth-service alongside as a second task definition in the same cluster + VPC

### Any other platform

Any platform that can run a Docker image works. Point it at:
```
ghcr.io/multiagentcoordinationprotocol/macp-playground:latest
```

## Environment Variables

This is the canonical env-var reference. The tables mirror `AppConfigService` (`src/config/app-config.service.ts`) and `.env.example`. The service does not load `.env` itself — export the variables, or pass them with `docker run --env-file`. "Required" means the service either refuses to boot or the relevant feature will fail at request time.

### Core HTTP / logging

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `3000` | HTTP listen port |
| `HOST` | No | `0.0.0.0` | HTTP listen host |
| `CORS_ORIGIN` | No | `http://localhost:3000` | Comma-separated origins (supports `*` and wildcards) |
| `NODE_ENV` | No | `development` | `development` enables Swagger at `/docs` |
| `LOG_LEVEL` | No | `info` | |
| `AUTH_API_KEYS` | No | — | Comma-separated keys guarding the macp-playground HTTP surface |

### Scenario registry

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PACKS_DIR` | No | `./packs` (`/app/packs` in the image) | Path to scenario pack YAML files. The code default is `./packs`; the `Dockerfile` sets `ENV PACKS_DIR=/app/packs`. |
| `REGISTRY_CACHE_TTL_MS` | No | `0` | Cache TTL; `0` reloads on every request |

### MACP runtime (gRPC)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `MACP_RUNTIME_ADDRESS` | **Yes (for runs)** | _(empty)_ | gRPC endpoint every agent dials. Not needed to boot, but required for `/examples/run` to drive a session; if unset, every bootstrap carries an empty `runtime_url` and `PolicyRegistrarService` logs a warning and skips registration. |
| `MACP_RUNTIME_TLS` | No | `true` | TLS flag written into each agent's bootstrap. [RFC-MACP-0004 §2](https://github.com/multiagentcoordinationprotocol/multiagentcoordinationprotocol/blob/main/rfcs/RFC-MACP-0004-security.md#2-transport-security) requires `true` in production. |
| `MACP_RUNTIME_ALLOW_INSECURE` | No | `false` | Must be `true` when `MACP_RUNTIME_TLS=false` — local dev only. |

### auth-service (AUTH-2)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `MACP_AUTH_SERVICE_URL` | **Yes** | _(empty)_ | Base URL of the auth-service. Startup fails with `INVALID_CONFIG` if unset. Not contacted at boot, so any valid URL lets the process start. |
| `MACP_AUTH_SERVICE_TIMEOUT_MS` | No | `5000` | HTTP timeout for `POST /tokens`. |
| `MACP_AUTH_TOKEN_TTL_SECONDS` | No | `3600` | TTL requested from auth-service on every mint. Must exceed the agent's gRPC stream lifetime (SDKs bind auth once at stream open). Capped by auth-service `MACP_AUTH_MAX_TTL_SECONDS`. |
| `MACP_AUTH_SCOPES_JSON` | No | _(empty)_ | Per-sender scope overrides, JSON `{"sender":{"can_start_sessions":true,...}}`. Deep-merged onto role-derived defaults; explicit `null` clears a key. |

### Control-plane (CP-1, optional)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `MACP_CONTROL_PLANE_URL` | No | _(empty)_ | Control-plane base URL. When set, `/examples/run` registers each run via `POST /runs` concurrently with agent bootstrap; best-effort, failure is logged and never fails the run. Empty disables submission. Wire format: [`macp-control-plane/docs/API.md` § `POST /runs`](https://github.com/multiagentcoordinationprotocol/macp-control-plane/blob/main/docs/API.md#post-runs). |
| `MACP_CONTROL_PLANE_TIMEOUT_MS` | No | `5000` | HTTP timeout for `POST /runs`. An invalid value (non-integer, `<= 0`, too large) falls back to `5000` with a startup warning. |
| `MACP_CONTROL_PLANE_API_KEY` | No | _(empty)_ | Sent as `Authorization: Bearer <key>`. The control-plane's `AuthGuard` requires an `Authorization` header on every route, so set this to match its `AUTH_API_KEYS` (the fullstack compose uses `demo-key`). |

### Policy registration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `REGISTER_POLICIES_ON_LAUNCH` | No | `true` | When true, `PolicyRegistrarService` registers every non-default policy with the runtime at bootstrap. Set to `false` only in tests or when policies are pre-registered out-of-band. |

**Read-only registry (prod-style alternative).** Mount `./policies` into a runtime started with `MACP_POLICIES_DIR` and set `REGISTER_POLICIES_ON_LAUNCH=false`. Registrar behaviour in that shape (verification instead of mutation) is documented in [`policy-authoring.md`](policy-authoring.md#how-policies-are-registered). The fullstack compose ships a commented-out variant of this setup.

### Agent workers

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `AUTO_BOOTSTRAP_EXAMPLE_AGENTS` | No | `true` | Auto-resolve agent bindings on `/examples/run`. |
| `EXAMPLE_AGENT_PYTHON_PATH` | No | `python3` | Python interpreter for Python workers. A manifest's own `host.python` overrides it; the shipped manifests set none. |
| `EXAMPLE_AGENT_NODE_PATH` | No | _(process.execPath)_ | Node interpreter for Node workers. A manifest's own `host.node` overrides it. |
| `MACP_CANCEL_CALLBACK_HOST` | No | `127.0.0.1` | Host each agent binds for the cancel-callback HTTP server. Empty disables. |
| `MACP_CANCEL_CALLBACK_PORT_BASE` | No | `0` | Port base for deterministic per-agent ports; `0` = ephemeral. |
| `MACP_CANCEL_CALLBACK_PATH` | No | `/agent/cancel` | HTTP path for the cancel-callback server. |

Worker processes inherit the service's environment, so these are set on the playground itself and read by the spawned agents:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPENAI_API_KEY` | No | _(empty)_ | Used by the LangGraph / LangChain / CrewAI workers (`gpt-4o-mini`). Empty → each worker uses its deterministic fallback scorer and makes no LLM call. |
| `RISK_DECIDER_WAIT_ALL_TIMEOUT_MS` | No | `60000` | How long the risk-decider coordinator waits for every specialist before committing with the votes it has. |
| `RISK_DECIDER_SUSPEND_HOLD_MS` | No | `8000` | How long the suspend/resume demo (`suspend` customerId sentinel) holds the session suspended before resuming. |

## GHCR Visibility

If the package is private, set it to **Public** (simplest), or configure pull credentials in your platform's dashboard.

## Rollback

```bash
# Use an older immutable tag
ghcr.io/multiagentcoordinationprotocol/macp-playground:sha-abc1234
```

Or re-tag:
```bash
docker pull ghcr.io/…/macp-playground:sha-<old>
docker tag  ghcr.io/…/macp-playground:sha-<old> ghcr.io/…/macp-playground:latest
docker push ghcr.io/…/macp-playground:latest
```

## Local Testing

`docker-compose.dev.yml` wires the macp-playground to an auth-service sidecar built from the sibling `../auth-service` checkout. Start the runtime separately, then:

```bash
docker compose -f docker-compose.dev.yml up
curl http://localhost:3000/healthz
```


Both compose files forward `NODE_AUTH_TOKEN` (default empty) as a build arg, because `@multiagentcoordinationprotocol/proto` installs from GitHub Packages: `NODE_AUTH_TOKEN=<token with read:packages> docker compose -f docker-compose.dev.yml up --build`.

The plain `docker-compose.yml` defaults `MACP_AUTH_SERVICE_URL` to `http://host.docker.internal:3200` (override via the environment) and passes `MACP_RUNTIME_ADDRESS` through, so it boots on its own. To actually run sessions, start the auth-service (and a runtime) first:

```bash
# In auth-service/
npm install && npm run build && npm start  # listens on :3200

# In macp-playground/
# A transitive dependency (@multiagentcoordinationprotocol/proto) comes from GitHub Packages,
# so the build needs a token with read:packages.
docker build --build-arg NODE_AUTH_TOKEN="$GITHUB_TOKEN" -t macp-playground .
docker run -p 3000:3000 \
  -e MACP_AUTH_SERVICE_URL=http://host.docker.internal:3200 \
  -e MACP_RUNTIME_ADDRESS=host.docker.internal:50051 \
  -e MACP_RUNTIME_TLS=false -e MACP_RUNTIME_ALLOW_INSECURE=true \
  macp-playground
```
