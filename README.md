# BuildFlow TPS — Tender Preparation & Submission

A self-contained module that adds a 7-step tender preparation workflow to the BuildFlow suite. It plugs into the parent `nrm-seed-generator` app, sharing its PostgreSQL instance and Docker network.

## Services

| Service | Port | Description |
|---------|------|-------------|
| `web-tps` | 5175 | React/Vite UI served by nginx |
| `bff-tps` | 3200 | Node.js/Fastify backend-for-frontend |
| `api-tps` | 8200 | Python/FastAPI engine |
| `migrate-tps` | — | One-shot DB migration job |

The compose project is named `tps`, so containers come up as `tps-bff-tps-1` and so on. Pinning the project name matters: without it Compose derives the name from the `infra/docker/` directory — the same name the parent platform derives — and a `docker compose down -v` here would destroy the parent's database volume.

The TPS services join the parent's external Docker network `buildflow` and share the Postgres instance the parent app owns. TPS does **not** spin up its own database.

### Database ownership

The parent platform owns the `buildflow` database and its `public` schema. TPS keeps every one of its objects in its own **`tps` schema**, including its own `tps.schema_migrations` ledger — it never writes to the parent's `public.bf_schema_migrations`. The BFF connects with `search_path=tps,public`, so the parent's `bf_*` identity tables stay reachable and are referenced explicitly as `public.bf_*`.

Links out of TPS (`package_id`, `organization_id`, `created_by`, and `subcontractor_id` → `scms.subcontractors`) are bare UUIDs with no cross-schema foreign keys, by design.

### Reading the SCMS schema

Step 4 sources its shortlist candidates by querying the SCMS module's `scms` schema **directly** in the shared database, rather than calling the SCMS BFF over HTTP — same database, no extra hop, and no CORS/network change needed.

Every one of those queries lives in `apps/bff/src/scmsReadDb.ts` and nowhere else. They are `SELECT` only: TPS never writes to `scms`, because `nominations`, `gap_fill_queue` and `pqq_submissions` are outbound-correspondence paths where a row can trigger real contact with a subcontractor, and `pqq_tokens` holds credential hashes.

The trade-off is real — reading another module's physical tables means no contract and no compile-time signal, so a column renamed in SCMS breaks TPS at runtime. Confining it to one file, with the schema name configurable via `SCMS_SCHEMA`, is the mitigation.

---

## Prerequisites

- Docker & Docker Compose
- **The parent `nrm-seed-generator` app must be running first**, so its Postgres container and the `buildflow` network exist. TPS has no database of its own to fall back on.
- Node 24 + pnpm ≥ 10.18 (local dev only)
- Python 3.11 + Poetry (local dev only)

---

## Deploying as containers

### 1. Start the parent app first

```bash
# In the nrm-seed-generator directory
docker compose up -d
```

This creates the `buildflow` network and the shared Postgres instance that TPS depends on.

### 2. Configure environment variables

```bash
cp .env.example .env
```

Edit `.env` and set at minimum:

```dotenv
# Must match the parent app's Postgres credentials
DATABASE_URL=postgresql://buildflow:buildflow@postgres:5432/buildflow

# Schema TPS owns inside the parent's database
DATABASE_SCHEMA=tps

# The parent platform's Docker network, joined by TPS
PARENT_NETWORK=buildflow

# A random string of at least 32 characters
TOKEN_ENCRYPTION_KEY=your-secret-key-at-least-32-chars

# URL where the TPS web container will be served (used for CORS)
WEB_ORIGIN=http://localhost:5175

# Parent app URL — used by the TPS web app to link back to BuildFlow
VITE_MAIN_APP_URL=http://localhost:5173

# Schema owned by the SCMS module, read directly for Step 4 shortlist candidates
SCMS_SCHEMA=scms
```

For production, remove `AUTH_DISABLED=true` and add OIDC credentials:

```dotenv
OIDC_ISSUER=https://your-idp.example.com
OIDC_AUDIENCE=buildflow-tps
OIDC_JWKS_URI=https://your-idp.example.com/.well-known/jwks.json
```

> `AUTH_DISABLED=true` is intentionally blocked in production by the config validator.

### 3. Build and start TPS containers

```bash
docker compose --env-file .env -f infra/docker/docker-compose.yml up -d --build
```

The `web-tps` image bakes every `VITE_*` value into the static bundle at build time, so compose passes them through `build.args` rather than `environment`. Changing any of them requires a rebuild (`--build`), not just a restart.

`migrate-tps` creates the `tps` schema, applies `database/migrations/001_tender_prep.sql`, and records it in `tps.schema_migrations` before `bff-tps` starts. It uses `restart: on-failure` instead of `depends_on: postgres`, because a `depends_on` cannot reach a service in the parent's compose project — it simply retries until Postgres accepts connections.

### 4. Verify

```bash
# BFF health check
curl http://localhost:3200/health
# → {"status":"ok","service":"tps-bff"}

# Confirm TPS created its own schema and left the parent's alone
docker exec -it $(docker ps -qf name=postgres) \
  psql -U buildflow -d buildflow -c '\dt tps.*'

# Open the web UI
open http://localhost:5175
```

---

## Wiring the TPS frontend into the parent app

The TPS web app is a standalone SPA. The parent app links into it by navigating to:

```
http://<tps-web-host>/packages/{packageId}/tender-prep
```

### Option A — simple hyperlink / button

In the parent app, add a link wherever package actions are shown:

```tsx
<a
  href={`${TPS_WEB_URL}/packages/${packageId}/tender-prep`}
  target="_blank"
  rel="noreferrer"
>
  Tender Preparation →
</a>
```

Set `TPS_WEB_URL` in the parent app's env:

```dotenv
# nrm-seed-generator .env
VITE_TPS_URL=http://localhost:5175
```

### Option B — embedded iframe

If the parent app needs TPS inline, embed it as an iframe:

```tsx
<iframe
  src={`${TPS_WEB_URL}/packages/${packageId}/tender-prep`}
  style={{ width: '100%', height: '100vh', border: 'none' }}
  title="Tender Preparation"
/>
```

### Back-link (Step 1 in TPS)

The TPS web app already reads `VITE_MAIN_APP_URL` and renders a "View full analysis in BuildFlow →" link in Step 1 pointing to:

```
{VITE_MAIN_APP_URL}/packages/{packageId}
```

Set this to the parent app's origin when building the `web` container (see step 3 above).

---

## Environment variable reference

### BFF (`apps/bff`)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | Yes | — | PostgreSQL connection string (shared with parent) |
| `DATABASE_SCHEMA` | No | `tps` | Schema TPS owns; must be a bare SQL identifier |
| `TOKEN_ENCRYPTION_KEY` | Yes | — | Secret for token encryption |
| `WEB_ORIGIN` | Yes | `http://localhost:5175` | CORS allowed origin for the web container |
| `PORT` | No | `3200` | BFF listen port |
| `AUTH_DISABLED` | No | `false` | Set `true` in dev only — blocked in production |
| `OIDC_ISSUER` | Prod | — | Required when `AUTH_DISABLED=false` |
| `OIDC_AUDIENCE` | Prod | — | Required when `AUTH_DISABLED=false` |
| `OIDC_JWKS_URI` | Prod | — | Required when `AUTH_DISABLED=false` |
| `SCMS_SCHEMA` | No | `scms` | Schema owned by the SCMS module, read (never written) for Step 4 shortlist candidates. Must be a bare SQL identifier. |
| `ENGINE_INTERNAL_URL` | No | — | Internal URL of the Python API |
| `ENGINE_INTERNAL_TOKEN` | No | — | Bearer token for BFF→API calls |
| `LOG_LEVEL` | No | `info` | Fastify log level |

### Web (`apps/web`) — build-time args

| Variable | Default | Description |
|----------|---------|-------------|
| `VITE_API_URL` | `http://localhost:3200` | TPS BFF URL (baked into static build) |
| `VITE_MAIN_APP_URL` | `http://localhost:5173` | Parent app URL for the Step 1 back-link |
| `VITE_DEV_SUBJECT` | `dev-user-001` | Dev auth header, used when `AUTH_DISABLED=true` |
| `VITE_DEV_ORGANIZATION` | `dev-org-001` | Dev auth header, used when `AUTH_DISABLED=true` |
| `VITE_DEV_EMAIL` | `dev@example.com` | Dev auth header, used when `AUTH_DISABLED=true` |

### API (`api`)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | Yes | — | PostgreSQL connection string |
| `DATABASE_SCHEMA` | No | `tps` | Passed through for future use; `api/` has no DB code yet |

---

## Local development

```bash
# Install dependencies
pnpm install

# Copy and edit env
cp .env.example .env

# Run DB migrations — creates the `tps` schema in the parent's database.
# Requires the parent's Postgres to be up on localhost:5433.
pnpm migrate

# Start BFF in watch mode
pnpm dev:bff

# Start web dev server (separate terminal)
pnpm dev:web

# Start Python API
poetry install
uvicorn api.main:app --reload --port 8200
```

The web dev server runs on `http://localhost:5175`. It calls the BFF at `VITE_API_URL` (`http://localhost:3200`) directly over CORS — there is no Vite proxy — which is why `WEB_ORIGIN` on the BFF must match the dev server's origin.

---

## Docker network notes

The `docker-compose.yml` declares the parent's network as external:

```yaml
networks:
  parent:
    external: true
    name: ${PARENT_NETWORK:-buildflow}
```

This means the parent app's `docker compose up` must run before TPS containers start. The hostname `postgres` resolves inside the `buildflow` network because the parent app's Postgres container is attached to it.

To inspect the shared network:

```bash
docker network inspect buildflow
```

### Port allocation across the suite

TPS deliberately avoids every port the parent and SCMS already bind:

| | parent | SCMS | TPS |
|---|---|---|---|
| web | 5173 | 5174 | **5175** |
| bff | 3000 | 3101 | **3200** |
| api | 8000 | 8100 | **8200** |

The parent also holds 5433 (postgres), 6379 (redis), 9000/9001 (minio), 3100 (loki) and 3001 (grafana).
baseline
