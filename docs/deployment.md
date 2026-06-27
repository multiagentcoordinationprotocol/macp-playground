# Deployment

## Principle

The repo is **fully platform-agnostic**. The `Dockerfile` is the only deployment contract — no platform-specific config files in the repo. All platform settings live in each platform's dashboard.

## Required sidecars

The macp-playground does **not** run standalone. Before it will boot, two additional services must be reachable:

| Service | Why it's required | How to run it |
|---------|-------------------|---------------|
| **MACP runtime** (gRPC) | Agents open their own gRPC channels to the runtime (RFC-MACP-0004 §4). `MACP_RUNTIME_ADDRESS` must point to a live runtime. | See [`macp-runtime/docs/deployment.md`](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/deployment.md). |
| **auth-service** (HTTP) | Every agent spawn mints a short-lived JWT via `POST /tokens`. At startup, `PolicyRegistrarService` also mints an admin JWT to register scenario policies with the runtime. Missing `MACP_AUTH_SERVICE_URL` throws `INVALID_CONFIG` and the service fails startup. | `docker-compose.dev.yml` runs it as a sidecar; in production, deploy the `auth-service` image alongside the runtime. |

The runtime must be configured to accept JWTs minted by the same
auth-service — on the runtime set `MACP_AUTH_ISSUER`, `MACP_AUTH_AUDIENCE`,
and `MACP_AUTH_JWKS_URL=<auth-service>/.well-known/jwks.json`. For the
full JWT-mode setup (supported algorithms, `macp_scopes` claim shape,
JWKS caching) see
[`macp-runtime/docs/getting-started.md` § JWT mode](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/getting-started.md#jwt-mode).

### Startup order

```
auth-service up
  ↓
runtime up (with MACP_AUTH_JWKS_URL pointing at auth-service)
  ↓
macp-playground boots
  ├─ validates MACP_AUTH_SERVICE_URL is set (fails fast otherwise)
  └─ PolicyRegistrarService.onApplicationBootstrap()
       ├─ mints admin JWT from auth-service (can_manage_mode_registry)
       ├─ opens gRPC channel to runtime
       └─ registers each non-default policy (idempotent)
  ↓
ready to accept POST /examples/run
```

If any of these fail, `/examples/run` will surface `AUTH_MINT_FAILED` (502) or `CONTROL_PLANE_UNAVAILABLE` (502) at request time rather than at boot — watch the startup logs for `PolicyRegistrarService` warnings.

## Pipeline

```
push to main / PR
  │
  ├─ lint          ESLint
  ├─ build         TypeScript compile
  ├─ test          unit tests + e2e tests + Python validation
  │
  └─ docker        Build image → push to GHCR
                     main  → :latest + :sha-<commit>
                     PR    → :pr-<number>
```

## Image Tags

| Trigger | Tag | Purpose |
|---------|-----|---------|
| Push to `main` | `:latest` | Rolling production tag |
| Push to `main` | `:sha-<commit>` | Immutable, for rollback |
| Pull request | `:pr-<number>` | Preview / validation |

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

## PR Preview Environments

PR builds produce images tagged `:pr-<number>`. Platforms that support preview environments can pull these for ephemeral deployments:

```
ghcr.io/multiagentcoordinationprotocol/macp-playground:pr-42
```

## Environment Variables

The table below mirrors `AppConfigService` (`src/config/app-config.service.ts`) and `.env.example`. "Required" means the service either refuses to boot or the relevant feature will fail at request time.

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
| `PACKS_DIR` | No | `/app/packs` | Path to scenario pack YAML files |
| `REGISTRY_CACHE_TTL_MS` | No | `0` | Cache TTL; `0` reloads on every request |

### MACP runtime (gRPC)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `MACP_RUNTIME_ADDRESS` | **Yes (for runs)** | _(empty)_ | gRPC endpoint every agent dials. Required for `/examples/run`; if unset, `PolicyRegistrarService` logs a warning and skips registration. |
| `MACP_RUNTIME_TLS` | No | `true` | TLS flag written into each agent's bootstrap. RFC-MACP-0006 §3 requires `true` in production. |
| `MACP_RUNTIME_ALLOW_INSECURE` | No | `false` | Must be `true` when `MACP_RUNTIME_TLS=false` — local dev only. |

### auth-service (AUTH-2)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `MACP_AUTH_SERVICE_URL` | **Yes** | _(empty)_ | Base URL of the auth-service. Startup fails with `INVALID_CONFIG` if unset. |
| `MACP_AUTH_SERVICE_TIMEOUT_MS` | No | `5000` | HTTP timeout for `POST /tokens`. |
| `MACP_AUTH_TOKEN_TTL_SECONDS` | No | `3600` | TTL requested from auth-service on every mint. Must exceed the agent's gRPC stream lifetime (SDKs bind auth once at stream open). Capped by auth-service `MACP_AUTH_MAX_TTL_SECONDS`. |
| `MACP_AUTH_SCOPES_JSON` | No | _(empty)_ | Per-sender scope overrides, JSON `{"sender":{"can_start_sessions":true,...}}`. Deep-merged onto role-derived defaults; explicit `null` clears a key. |

### Control-plane (observer)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `CONTROL_PLANE_BASE_URL` | No | `http://localhost:3001` | Read-only observer endpoint used by the UI console. MACP Playground no longer writes here (RFC-MACP-0004 §4). |
| `CONTROL_PLANE_API_KEY` | No | — | Bearer token for control-plane reads. |
| `CONTROL_PLANE_TIMEOUT_MS` | No | `10000` | |

### Policy registration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `REGISTER_POLICIES_ON_LAUNCH` | No | `true` | When true, `PolicyRegistrarService` registers every non-default policy with the runtime at bootstrap. Set to `false` only in tests or when policies are pre-registered out-of-band. |

### Agent workers

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `AUTO_BOOTSTRAP_EXAMPLE_AGENTS` | No | `true` | Auto-resolve agent bindings on `/examples/run`. |
| `EXAMPLE_AGENT_PYTHON_PATH` | No | `python3` | Python interpreter for Python workers. |
| `EXAMPLE_AGENT_NODE_PATH` | No | _(process.execPath)_ | Node interpreter for Node workers. |
| `MACP_CANCEL_CALLBACK_HOST` | No | `127.0.0.1` | Host each agent binds for the cancel-callback HTTP server. Empty disables. |
| `MACP_CANCEL_CALLBACK_PORT_BASE` | No | `0` | Port base for deterministic per-agent ports; `0` = ephemeral. |
| `MACP_CANCEL_CALLBACK_PATH` | No | `/agent/cancel` | HTTP path for the cancel-callback server. |

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

`docker-compose.dev.yml` wires the macp-playground to the auth-service sidecar. Start the runtime separately, then:

```bash
docker compose -f docker-compose.dev.yml up
curl http://localhost:3000/healthz
```

For a single-container smoke test without auth-service, the service will refuse to start — that's by design. Run the auth-service first:

```bash
# In auth-service/
npm install && npm run build && npm start  # listens on :3200

# In macp-playground/
MACP_AUTH_SERVICE_URL=http://localhost:3200 \
MACP_RUNTIME_ADDRESS=runtime.local:50051 \
docker run -p 3000:3000 --env-file .env macp-playground
```
