# High Availability (Postgres + S3 + Redis)

Use this layout when a customer connector must run multiple Node replicas without storing
credentials on a single host disk. Keep **one OpenConnector deploy per customer**; this path does
not add multi-tenant columns.

```text
Load balancer
  -> OpenConnector replica 1..N  (stateless app)
       -> PostgreSQL             (encrypted credentials + runtime state)
       -> S3-compatible storage  (transit files)
       -> Redis pub/sub          (in-memory cache invalidation)
```

## Required environment

| Variable                                                                | Purpose                                                                                           |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `OOMOL_CONNECT_DATABASE_URL`                                            | Postgres connection URL. Enables the shared runtime store.                                        |
| `OOMOL_CONNECT_ENCRYPTION_KEY`                                          | Required with Postgres. Encrypts credentials, OAuth config/state, and idempotent responses.       |
| `OOMOL_CONNECT_REDIS_URL`                                               | Optional. Enables in-memory L1 cache + cross-replica invalidation. Recommended for multi-replica. |
| `OOMOL_CONNECT_S3_BUCKET`                                               | Shared transit-file bucket (recommended for HA).                                                  |
| `OOMOL_CONNECT_S3_ENDPOINT`                                             | Optional. Set for MinIO or other S3-compatible endpoints.                                         |
| `OOMOL_CONNECT_S3_REGION`                                               | Optional. Defaults to the AWS SDK default.                                                        |
| `OOMOL_CONNECT_S3_ACCESS_KEY_ID` / `OOMOL_CONNECT_S3_SECRET_ACCESS_KEY` | Bucket credentials.                                                                               |
| `OOMOL_CONNECT_S3_FORCE_PATH_STYLE`                                     | Set `true` for MinIO-style path addressing.                                                       |
| `OOMOL_CONNECT_CACHE_TTL_MS`                                            | Soft L1 TTL (default `30000`). Bounds staleness if pub/sub is delayed.                            |
| `OOMOL_CONNECT_CACHE_CHANNEL`                                           | Redis channel (default `oomol-connect:cache-invalidate`).                                         |
| `OOMOL_CONNECT_ORIGIN`                                                  | Public origin for OAuth redirects and transit download URLs.                                      |

Without `OOMOL_CONNECT_DATABASE_URL`, the Node runtime keeps the existing SQLite + local-files
single-node behavior.

## What is cached

Each replica keeps an in-memory L1 cache for hot reads: connections, OAuth client configs, runtime
tokens, and runtime policy. Redis carries **invalidation topics only** — never credential
payloads. OAuth CSRF state, run logs, and idempotency records always go to Postgres.

## Local HA stack

```bash
docker compose -f docker-compose.yml -f docker-compose.ha.yml up --build
```

That overlay starts Postgres, MinIO, Redis, and one connector service wired to them. Scale the
connector service as needed once the shared backends are healthy.

## Ops notes

- Store `OOMOL_CONNECT_ENCRYPTION_KEY` in a secrets manager. Losing it makes encrypted rows
  unrecoverable.
- Migrations under `migrations/postgres/` apply automatically on process start.
- `npm run runtime:data -- rotate-key --database-url …` rotates encryption in Postgres and publishes
  a full cache flush when Redis is configured.
- Prefer vertical scale of a single machine only when still on SQLite volumes; with Postgres + S3 +
  Redis, horizontal replica count may be greater than one.
