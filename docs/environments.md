# Environments

The platform runs in four environments, and they all deploy the _same_
service definition (`docker-compose.yml`). A production-like environment is
an overlay that refines the base file, never a second stack - so the database
a developer starts on a laptop cannot drift from the one staging runs.

Master Plan references: Section 30 (Phase 1 - environment configuration,
staging, preview builds), Section 53 (release path) and Section 61 (logging
and monitoring baseline).

## The environments at a glance

| Environment | Stack                                                       | Configuration                                                                                         | Lifetime                                     |
| ----------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `local`     | `docker-compose.yml`                                        | `.env`, created from `.env.example`                                                                   | Lives on a developer machine; reset freely.  |
| CI          | a `postgres` service container (`.github/workflows/ci.yml`) | workflow `env:`; only `TEST_DATABASE_URL` reaches the integration job                                 | One pipeline run.                            |
| `staging`   | base + `docker-compose.staging.yml`                         | `.env.staging`, created from `.env.staging.example`; secrets live in the GitHub `staging` environment | Persistent; the first stop of every release. |
| `preview`   | base + `docker-compose.staging.yml`                         | `.env.preview`, created from `.env.preview.example`; secrets live in the GitHub `preview` environment | One pull request; destroyed with it.         |

## Environment identity

`SLATE_ENV` is the authoritative name and `NODE_ENV` only a fallback, because
a container usually runs with `NODE_ENV=production` while still being staging
or a preview. `@slate/observability` resolves the identity in this order
(the full contract is in `docs/observability.md`):

1. `SLATE_ENV`
2. `NODE_ENV`
3. `development`

| Environment | `SLATE_ENV` | `NODE_ENV`    |
| ----------- | ----------- | ------------- |
| local       | _(unset)_   | `development` |
| CI          | _(unset)_   | _(unset)_     |
| staging     | `staging`   | `production`  |
| preview     | `preview`   | `production`  |

## Local development

```bash
npm run docker:up      # docker compose up -d
npm run docker:ps      # docker compose ps
npm run docker:logs    # docker compose logs -f postgres
npm run docker:down    # docker compose down (keeps data)
npm run docker:reset   # docker compose down -v (destroys data)
```

- Configuration comes from `.env` (copy `.env.example`; it is git-ignored).
- `infrastructure/postgres/init/01-init-databases.sql` bootstraps the `slate`
  database and the isolated `slate_test` database on first start.
- Integration tests connect to `TEST_DATABASE_URL` (`slate_test`), never to
  `DATABASE_URL`; every suite runs in its own schema
  (`@slate/testing/postgres`).
- The base file binds PostgreSQL to `0.0.0.0:${POSTGRES_PORT:-5432}`: a
  laptop database is reachable by local tooling. Production-like
  environments override this (see below).

## Staging

Staging is production-like: `restart: always`, a memory ceiling, a graceful
60s stop window and bounded log rotation. Start it with the overlay:

```bash
docker compose --env-file .env.staging \
  -f docker-compose.yml -f docker-compose.staging.yml up -d
```

What the overlay changes, and why:

| Change                                                              | Reason                                                                                                                       |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `ports: !override` -> `127.0.0.1:${POSTGRES_HOST_PORT:-55432}:5432` | The database must never be reachable from the public internet: loopback only, in a deployment-specific port range.           |
| volume `slate_staging_postgres_data`, network `slate_staging`       | Predictable, deployment-specific identity; staging never shares storage or DNS with a preview.                               |
| `mem_limit: 1g`, `stop_grace_period: 60s`                           | A runaway query cannot take the host down; a checkpoint is not cut off mid-flight.                                           |
| `logging: json-file, max-size 10m, max-file 5`                      | Container logs stay bounded and carry no application context - structured application logs come from `@slate/observability`. |

`SLATE_APP_URL`, `SLATE_CONTROL_PLANE_URL` and `SLATE_PUBLIC_URL` keep
`.invalid` placeholders until the first app is deployable in Phase 4.
`SENTRY_DSN` is empty until the staging monitoring project exists: fill it
in, never point staging at production monitoring.

## Preview

A preview is a disposable copy of the stack for one pull request:

1. `cp .env.preview.example .env.preview` and replace every `<pr>`.
2. Start with the same overlay command and `--env-file .env.preview`.
3. Tear down with `down -v` - the per-preview volume _is_ the database.

Every `<pr>` placeholder exists so a preview can never collide with staging
or with another preview: its own host port (`55<pr>`), volume
(`slate_preview_pr<pr>_postgres_data`) and network (`slate_preview_pr<pr>`).
Previews log at `debug` (they are debugging environments) and are torn down
with the pull request, so their retention window is short by construction.

## CI

`.github/workflows/ci.yml` runs the seven gates
(`install -> lint -> typecheck -> unit -> integration -> build -> security`)
with a `postgres:16-alpine` service container. The integration job receives
only `TEST_DATABASE_URL`; staging and preview secrets are never visible to
CI jobs.

## Variable reference

| Variable                                                                                            | Set in                           | Meaning                                                                                                   |
| --------------------------------------------------------------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `SLATE_ENV` / `NODE_ENV`                                                                            | all                              | Environment identity (see above).                                                                         |
| `SLATE_SERVICE`                                                                                     | all                              | Service name on every log record and error report.                                                        |
| `SENTRY_RELEASE`                                                                                    | staging, preview                 | Deployed tag or commit SHA, set by the release job.                                                       |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB`                                               | all                              | Database credentials; the password differs per environment.                                               |
| `POSTGRES_HOST` / `POSTGRES_PORT`                                                                   | all                              | In-network address (`postgres:5432`) used by the connection strings.                                      |
| `POSTGRES_HOST_PORT` / `POSTGRES_BIND_ADDRESS`                                                      | staging, preview                 | Host-side binding; loopback only.                                                                         |
| `POSTGRES_VOLUME_NAME` / `SLATE_NETWORK_NAME`                                                       | staging, preview                 | Per-deployment stack identity.                                                                            |
| `POSTGRES_MEMORY_LIMIT`                                                                             | staging (`1g`), preview (`512m`) | Container memory ceiling.                                                                                 |
| `DATABASE_URL` / `DIRECT_URL`                                                                       | all                              | Application connection strings; `DIRECT_URL` is the non-pooled migration connection.                      |
| `TEST_DATABASE_URL`                                                                                 | local, CI only                   | Isolated integration-test database. Deliberately unset in staging and preview: they are not test targets. |
| `SLATE_APP_URL` / `SLATE_CONTROL_PLANE_URL` / `SLATE_PUBLIC_URL`                                    | staging, preview                 | Public endpoints (real in Phase 4).                                                                       |
| `LOG_LEVEL` / `LOG_FORMAT` / `SENTRY_ENVIRONMENT` / `SENTRY_DSN` / `SLATE_DISABLE_ERROR_MONITORING` | all                              | The observability baseline - `docs/observability.md`.                                                     |

## Secrets and the GitHub environments

- `.env`, `.env.staging(.local)` and `.env.preview(.local)` are git-ignored;
  the committed `*.example` files are the only environment files in git.
- Real values are stored as secrets and variables of the GitHub `staging` and
  `preview` environments (Settings -> Environments) and are written into the
  host `.env.*` file when a deployment is provisioned.
- Special characters in a password must be URL-encoded inside connection
  strings (`@` -> `%40`, `#` -> `%23`).

## Rendering without a daemon

The stack must render even where no Docker daemon exists (documentation,
review, CI):

```bash
npm run docker:config:staging   # renders base + overlay with .env.staging.example
```

## Rules that keep the environments apart

1. One service definition (`docker-compose.yml`); environments differ by
   overlay and values, never by structure.
2. Staging keeps its data; previews never do (`down -v`).
3. `TEST_DATABASE_URL` exists in local and CI only.
4. Production-like PostgreSQL binds to loopback, never `0.0.0.0`.
5. No secret is ever committed; the `*.example` files carry placeholders
   only.
