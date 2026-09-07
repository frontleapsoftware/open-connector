# High Availability (Postgres + S3 + Redis)

Upstream OpenConnector already supports shared Postgres runtime state and S3 transit files. This
fork adds an optional Redis-backed L1 cache for multi-replica reads.

Use this layout when a customer connector must run multiple Node replicas without storing
credentials on a single host disk. Keep **one OpenConnector deploy per customer**; this path does
not add multi-tenant columns.

```text
Load balancer
  -> OpenConnector replica 1..N  (stateless app)
       -> PostgreSQL             (encrypted credentials + runtime state)
       -> S3-compatible storage  (transit files)
       -> Redis pub/sub          (optional in-memory cache invalidation)
```

## Required environment

| Variable                                                                | Purpose                                                                                           |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `OOMOL_CONNECT_DATABASE_URL`                                            | Postgres connection URL. Enables the shared runtime store.                                        |
| `OOMOL_CONNECT_ENCRYPTION_KEY`                                          | Encrypts credentials, Marketplace keys, OAuth config/state, and idempotent responses.             |
| `OOMOL_CONNECT_TRANSIT_FILE_BACKEND`                                    | Set to `s3` for shared transit files across replicas.                                             |
| `OOMOL_CONNECT_S3_BUCKET`                                               | Shared transit-file bucket (required when backend is `s3`).                                       |
| `OOMOL_CONNECT_S3_ENDPOINT`                                             | Optional. Set for MinIO or other S3-compatible endpoints.                                         |
| `OOMOL_CONNECT_S3_REGION`                                               | Optional. Defaults to `us-east-1`.                                                                |
| `OOMOL_CONNECT_S3_ACCESS_KEY_ID` / `OOMOL_CONNECT_S3_SECRET_ACCESS_KEY` | Bucket credentials (or omit both for the AWS SDK chain).                                          |
| `OOMOL_CONNECT_S3_FORCE_PATH_STYLE`                                     | Set `true` for MinIO-style path addressing.                                                       |
| `OOMOL_CONNECT_REDIS_URL`                                               | Optional. Enables in-memory L1 cache + cross-replica invalidation. Recommended for multi-replica. |
| `OOMOL_CONNECT_CACHE_TTL_MS`                                            | Soft L1 TTL (default `30000`). Bounds staleness if pub/sub is delayed.                            |
| `OOMOL_CONNECT_CACHE_CHANNEL`                                           | Redis channel (default `oomol-connect:cache-invalidate`).                                         |
| `OOMOL_CONNECT_ORIGIN`                                                  | Public origin for OAuth redirects and transit download URLs.                                      |

Without `OOMOL_CONNECT_DATABASE_URL`, the Node runtime keeps the existing SQLite + local-files
single-node behavior. See [configuration.md](configuration.md) for the full Postgres/S3 reference.

## What is cached

Each replica keeps an in-memory L1 cache for hot reads: connections, OAuth client configs, runtime
tokens, and runtime policy. Redis carries **invalidation topics only** — never credential
payloads. OAuth CSRF state, run logs, idempotency records, and Marketplace config always go to
Postgres.

## Local HA stack

```bash
docker compose -f docker-compose.yml -f docker-compose.ha.yml up --build
```

That overlay starts Postgres, MinIO, Redis, and one connector service wired to them. Scale the
connector service as needed once the shared backends are healthy.

## Ops notes

- Store `OOMOL_CONNECT_ENCRYPTION_KEY` in a secrets manager. Losing it makes encrypted rows
  unrecoverable.
- Apply Postgres migrations with `npm run runtime:migrate` (or `open-connector migrate`) before
  serving traffic; see [configuration.md](configuration.md).
- Prefer vertical scale of a single machine only when still on SQLite volumes; with Postgres + S3 +
  Redis, horizontal replica count may be greater than one.

When embedding OpenConnector inside a host app, transit files can use a Mastra workspace filesystem
instead of S3 — see [embedding.md](embedding.md).
