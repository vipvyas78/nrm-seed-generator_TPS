# BuildFlow TPS — Tender Preparation & Submission

A self-contained module that adds a 4-step tender preparation workflow to the BuildFlow suite. A completed take-off in the parent platform launches a workflow here automatically, over a queue. It plugs into the parent `nrm-seed-generator` app, sharing its PostgreSQL instance and Docker network.

## Services

| Service | Port | Description |
|---------|------|-------------|
| `web-tps` | 5175 | React/Vite UI served by nginx |
| `bff-tps` | 3200 | Node.js/Fastify backend-for-frontend |
| `api-tps` | 8200 | Python/FastAPI engine (no routes yet) |
| `worker-tps` | — | Consumes `buildflow_takeoff_completion_queue` and launches tender prep |
| `migrate-tps` | — | One-shot DB migration job |

The compose project is named `tps`, so containers come up as `tps-bff-tps-1` and so on. Pinning the project name matters: without it Compose derives the name from the `infra/docker/` directory — the same name the parent platform derives — and a `docker compose down -v` here would destroy the parent's database volume.

The TPS services join the parent's external Docker network `buildflow` and share the Postgres instance the parent app owns. TPS does **not** spin up its own database.

### Database ownership

The parent platform owns the `buildflow` database and its `public` schema. TPS keeps every one of its objects in its own **`tps` schema**, including its own `tps.schema_migrations` ledger — it never writes to the parent's `public.bf_schema_migrations`. The BFF connects with `search_path=tps,public`, so the parent's `bf_*` identity tables stay reachable and are referenced explicitly as `public.bf_*`.

TPS also **creates and migrates a second schema, `comms`** (migration `022`), which holds subcontractor and Client correspondence: threads, messages, attachments, forwards and notifications. It is a separate module rather than more `tps.` tables because it is fed by a Cloudflare Email Worker living in its own repository (`novamerx-comms-worker`) and read by two different front ends. It carries **no cross-schema foreign keys** — `workflow_id`, `shortlist_entry_id`, `organization_id` and `subcontractor_id` are bare UUIDs, the same rule TPS already follows for its own links out — so the store can move repositories without unpicking anything. `search_path` is deliberately **not** widened to include it: every reference is written `comms.`-qualified, the same way `public.bf_*` and `scms.*` are, and `apps/bff/src/commsDb.ts` is the only file that names a `comms.` table. Its migration is applied by TPS's runner and recorded in `tps.schema_migrations`, because a Cloudflare Worker cannot reach a private Postgres — it POSTs over HTTPS and holds no connection string.

Attachment **bytes** are not stored here at all. TPS has no object storage and no S3 client; a file goes to BuildFlow through `POST /internal/comms/attachments` and comes back as a durable link, because the primitive that serves a file to someone who is not a BuildFlow user lives where the bucket is. See `BUILDFLOW_COMMS_ATTACHMENTS_API.md` in the parent repo.

Links out of TPS (`package_id`, `organization_id`, `created_by`, and `subcontractor_id` → `scms.subcontractors`) are bare UUIDs with no cross-schema foreign keys, by design.

### Reading the SCMS schema

Step 1 (Tender Launch Pack) sources its shortlist candidates by querying the SCMS module's `scms` schema **directly** in the shared database, rather than calling the SCMS BFF over HTTP — same database, no extra hop, and no CORS/network change needed.

Every one of those queries lives in `apps/bff/src/scmsReadDb.ts` and nowhere else. They are `SELECT` only: TPS never writes to `scms`, because `nominations`, `gap_fill_queue` and `pqq_submissions` are outbound-correspondence paths where a row can trigger real contact with a subcontractor, and `pqq_tokens` holds credential hashes.

The trade-off is real — reading another module's physical tables means no contract and no compile-time signal, so a column renamed in SCMS breaks TPS at runtime. Confining it to one file, with the schema name configurable via `SCMS_SCHEMA`, is the mitigation.

**The register is not organisation-scoped.** The same firms are capable of the same work whichever tender is being priced, so a buyer's own organisation has no bearing on who belongs on a shortlist — the subcontractor register is treated as shared reference data. This is a deliberate divergence from SCMS, which scopes its own register by `organization_id` throughout, so TPS will offer firms that SCMS's UI hides.

TPS's own tables are scoped as strictly as before. Every workflow, shortlist, ITT and submission is filtered by `organization_id`, and `GET /shortlist/candidates` runs `assertWorkflowAccess` before it reads a single row from `scms` — so one tenant still cannot see another's tenders, and the register is only reachable by an authenticated caller.

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

# Schema owned by the SCMS module, read directly for Step 1 shortlist candidates
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

`migrate-tps` creates the `tps` schema, applies `database/migrations/*.sql`, and records them in `tps.schema_migrations` before `bff-tps` starts. It uses `restart: on-failure` instead of `depends_on: postgres`, because a `depends_on` cannot reach a service in the parent's compose project — it simply retries until Postgres accepts connections.

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

## Launching from a completed take-off

A completed take-off in BuildFlow is what makes a package ready to tender, so it starts the workflow here — over a queue, so neither module has to know the other is running.

```
BuildFlow markAnalysis('completed')
  └─ bf_queue_outbox row, same transaction as the status      (producer, parent repo)
      └─ dispatchOutbox → buildflow_takeoff_completion_queue  (BullMQ, parent's Redis)
          └─ worker-tps → tpDb.launchFromTakeoff              (this repo)
              └─ tps.workflows, current_step = 1 — Tender Launch Pack
```

**Steps 1–3 of the old 7-step wizard are gone.** Parsed Outputs, Employer RFIs and SoA RAG belong to the take-off module, so Tender Launch Pack is now step 1 — which means the consumer creates the workflow with the column's own `DEFAULT 1` and never sets a step.

The message carries the tender, package, project and pipeline detail (`packageId` and `organizationId` are the only two the workflow cannot be created without), and is stashed whole on `workflows.step_data.takeoff`. `tenderId` is genuinely nullable — a package need not belong to a tender.

The message is delivered **at least once**, and three things make that safe:

- `bf_queue_outbox` has a unique index on the take-off id, so a repeated completion callback writes one row;
- the BullMQ job id is the outbox row id, so a redelivered dispatch is deduplicated;
- `launchFromTakeoff` is `ON CONFLICT (package_id)` and merges into `step_data`.

**A take-off re-run is not a duplicate** — it mints a new take-off id, so it is a new message, and it refreshes `step_data.takeoff` while leaving `current_step` alone. Someone who has reached ITT Dispatch is not dragged back to the start.

Starting a workflow by hand still works and is unchanged; it simply carries no `step_data.takeoff`.

---

## The package list is derived, not configured

Step 1 used to work through `tps.package_config` — a list loaded once from the client's
spreadsheet through `PUT /api/tender-prep/config/packages`, with no UI, organisation-wide,
identical for every project. It is now built from the take-off.

```
BuildFlow: reviewer approves/ignores every TOQ item, presses "Tender Take off"
  └─ bf_queue_outbox 'takeoff.tendered', same transaction as the release stamp
      └─ buildflow_takeoff_tender_queue                        (BullMQ, parent's Redis)
          └─ worker-tps → tpDb.buildPackagesFromTakeoff        (this repo)
              └─ tps.package_config rows carrying wp_code, scoped to the project
```

Which packages are required comes from `public.nrm_sub_element_work_package.wp_scope_condition`:
`All` always · `TOQ` only where the take-off measured work under that code · `D&B` only when
`bf_projects.project_scope = 'design_and_build'` · `Manual` offered, badged, never
auto-selected. A code maps to many NRM1 sub-elements and they need not agree, so the widest
condition wins.

**The table is not dropped, and that is deliberate.** Package identity in this schema is a
bare string: `package_bill_lines` and `attendance_items` are FK'd to `package_config.id` and
cascade, while `shortlists`, `itt_line_overrides`, `tender_returns` and `precontract_minutes`
all join by `name`. Replacing the table would take Step 1's confirm flow, the ITT's sections
2b and 4, and every per-line override with it. So the rows become derived and the table
stays — rows with `wp_code` are generated and rebuilt on each release, rows without one are
the legacy list, still served to any project that has never been tendered
(`listPackageConfig` prefers project rows and falls back to the org default).

A package that falls out of scope is **deactivated, never deleted** — `replacePackageConfig`
already records a delete-then-reinsert that "silently wiped 890 lines of survey schedule".
`route_of_procurement` is deliberately absent from the upsert's `DO UPDATE` set: the
derivation proposes a route, it does not overrule the person who tendered the package. And
`seq` is bumped by 100000 before renumbering, because `package_config_seq_key` is unique on
`(organization_id, project_id, seq, sub_seq)` and the moment the package *set* changes every
seq after the new one shifts.

`trade_terms` is the work-package label — "Dry lining & partitions" is a trade name, which is
what `scmsReadDb`'s word-level matcher wants, so the shortlist column keeps working without a
second vocabulary to maintain.

### Which specification a package was measured against

The ITT names, per package, the specification documents that package's own take-off lines
were read from — for Reading's Flooring package, `01 - Employers Requirements 144.pdf`.

It comes from `takeoff_items.spec_source_files`, which holds `tender_documents.filename`
verbatim (`elemental_lines` reads those filenames out of `tender_documents` before parsing a
clause from each), so the join is exact.

**It cannot come from `spec_chunk_ids`, and that was the bug.** `nrm_chunks` keeps no path,
filename or usable document id for a `tender_spec` row — `embed_chunks.py` carries
`source_path` in memory and drops it from the INSERT — so BuildFlow's `/internal/spec-clauses`
answers *which clause* correctly and can never answer *which document*. On Reading,
`spec_chunk_ids` is set on 25 of 525 items and on **zero** items of every work package, while
`spec_source_files` is set on 213 — including 17 of Flooring's 18. Keying the ITT's
specification section on the chunk ids is why it came back empty for every package.

The list is a **subsection**, not a filter: section 3 still issues all documents to every
tenderer, because an Employer's Requirement binds a subcontractor whether or not its filename
mentions their trade. A cited filename matching no document is reported as `unresolved`
rather than dropped — it means the take-off named a document this tender pack does not
contain. Spec documents carry the same `'document'` ignore key as the schedule, so unticking
one removes it from both.

---

### Scope and Bill of Quantities come from the take-off

The ITT's section 2 reads `public.takeoff_items` filtered on `work_package`, not `boq_items`
attributed by NRM group-element prefix. Items with a quantity are the priceable bill; items
without are scope the take-off recorded but could not measure — which is what `is_priceable`
already distinguished. Quantities are the **reviewed** ones
(`COALESCE(latest.effective_quantity, ti.quantity)`, the same LATERAL the parent's own
`reaggregateReviewedBoq` uses), ignored items are gone, and rates are still never selected.

The NRM-code rule remains as a **second** mechanism for items the take-off resolved no
package for — 196 of Reading's 525 — and for items naming a code
`work_package_config` no longer holds (`WP-MEP`, `WP-FIN`, retired by the parent's migration
075). The two never overlap and every line carries `attributed_by`, so a thin bill and a
take-off that resolved nothing cannot be mistaken for each other.

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

A workflow launched from a take-off carries the take-off's detail in `workflows.step_data.takeoff`, which Step 1 renders as a "Launched from take-off" panel — tender name and reference, package and version, take-off id, item count, GIFA — above a "View the take-off in BuildFlow →" link built from `VITE_MAIN_APP_URL`:

```
{VITE_MAIN_APP_URL}/packages/{packageId}
```

Set this to the parent app's origin when building the `web` container (see step 3 above).

### Dev identity must match the parent

Both repos provision actors through the issuer `buildflow-dev` and upsert on `(oidc_issuer, external_id)`, so `VITE_DEV_ORGANIZATION` **must be the same string in both** or you get two `bf_organizations` rows with different UUIDs. A workflow launched by `worker-tps` carries the parent's `organization_id`, and every TPS read filters on it — a mismatch does not raise an error, it just makes the workflow invisible.

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
| `SCMS_SCHEMA` | No | `scms` | Schema owned by the SCMS module, read (never written) for Step 1 shortlist candidates. Must be a bare SQL identifier. |
| `REDIS_URL` | Worker | — | The parent platform's Redis. Required by `worker-tps`; unused by the API and migrator. |
| `BUILDFLOW_BASE_URL` | No | — | BuildFlow's BFF as reachable from this container — `http://bff:3000` on the shared network, **not** localhost. Enables emailed document links and spec-clause text. |
| `BUILDFLOW_DOCUMENT_LINKS_TOKEN` | No | — | Shared secret for both BuildFlow internal routes. **Must equal `TPS_INTERNAL_TOKEN` on the BuildFlow side** (compose default `buildflow-tps-dev-token`) or every call 401s. Unset, the ITT still sends and says so in its review notes. |
| `ENGINE_INTERNAL_URL` | No | — | Internal URL of the Python API |
| `ENGINE_INTERNAL_TOKEN` | No | — | Bearer token for BFF→API calls |
| `LOG_LEVEL` | No | `info` | Fastify log level |

### Web (`apps/web`) — build-time args

| Variable | Default | Description |
|----------|---------|-------------|
| `VITE_API_URL` | `http://localhost:3200` | TPS BFF URL (baked into static build) |
| `VITE_MAIN_APP_URL` | `http://localhost:5173` | Parent app URL for the take-off back-link on Step 1 |
| `VITE_DEV_SUBJECT` | `local-user` | Dev auth header. **Must match the parent's** — see below |
| `VITE_DEV_ORGANIZATION` | `local-org` | Dev auth header. **Must match the parent's** — see below |
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
