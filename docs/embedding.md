# Embedding OpenConnector in a host app

OpenConnector can run as a library inside another Node process (for example Nest `api-server`)
instead of a separate HTTP service. The host supplies durable storage and mounts the returned Hono
app (or calls `ActionRunner` in-process).

## Install

Point a workspace / git dependency at this repo (the package stays `private` and runs as native
TypeScript):

```json
{
  "dependencies": {
    "@oomol-lab/open-connector": "workspace:*"
  }
}
```

Import the embed surface:

```ts
import {
  createConnectApp,
  createPostgresRuntimeDatabase,
  createSecretCodec,
  loadCatalog,
  ProviderLoader,
  executorModules,
  WorkspaceTransitFileService,
} from "@oomol-lab/open-connector/embed";
```

Narrower imports are also available (for example
`@oomol-lab/open-connector/server/files/workspace-transit-files`).

## Wire storage

| Concern                                       | Inject                                                                              |
| --------------------------------------------- | ----------------------------------------------------------------------------------- |
| Credentials, OAuth, tokens, runs, idempotency | `RuntimeDatabase` — typically `createPostgresRuntimeDatabase(url, { secretCodec })` |
| Transit action files                          | `ITransitFileService` — `WorkspaceTransitFileService`, S3, or local disk            |
| Encryption                                    | `createSecretCodec(process.env.OOMOL_CONNECT_ENCRYPTION_KEY)`                       |

### Mastra workspace for transit files

`WorkspaceTransitFileService` accepts any Mastra-compatible filesystem (`WorkspaceFilesystem` from
`@mastra/core/workspace`, or Frontleap’s Local/GCS workspace FS). It does **not** depend on Mastra;
pass the filesystem instance you already construct for agents.

```ts
import { Workspace } from "@mastra/core/workspace";
// filesystem: LocalFilesystem | GCS | S3Filesystem | AgentFS, etc.

const workspace = new Workspace({ filesystem: /* your shared FS */ });
const transitFiles = new WorkspaceTransitFileService({
  filesystem: workspace.filesystem, // or the FS instance directly
  publicOrigin: process.env.OOMOL_CONNECT_ORIGIN ?? "http://localhost:3000",
  ttlSeconds: 86_400,
  maxBytes: 100 * 1024 * 1024,
  prefix: "open-connector/transit",
});
```

Use a **shared** workspace backend (GCS/S3) when running multiple host replicas. A local folder FS
is fine for single-node only.

Credentials must still live in Postgres (or another `RuntimeDatabase`), not in the workspace FS.

## Create and mount the app

```ts
const secretCodec = createSecretCodec(process.env.OOMOL_CONNECT_ENCRYPTION_KEY);
const runtimeDatabase = await createPostgresRuntimeDatabase(process.env.OOMOL_CONNECT_DATABASE_URL!, {
  secretCodec,
});
const catalog = await loadCatalog(undefined, { executableServices: Object.keys(executorModules) });
const { app } = await createConnectApp({
  catalog,
  providerLoader: new ProviderLoader(executorModules),
  runtimeDatabase,
  transitFiles,
  publicOrigin: process.env.OOMOL_CONNECT_ORIGIN ?? "http://localhost:3000",
  secretCodec,
  adminToken: process.env.OOMOL_CONNECT_ADMIN_TOKEN,
});

// Nest / Express / raw Node: forward requests to app.fetch
// e.g. Nest: all('*', (req, res) => handle via app.fetch(Request))
```

In-process actions without HTTP:

```ts
import { ActionRunner } from "@oomol-lab/open-connector/server/actions/action-runner";
```

Build `ActionRunner` with the same catalog, provider loader, connections, and run-log store the
connect app uses (see `createConnectApp` in `src/server/connect-app.ts`).

## Optional Redis L1 cache

Wrap the Postgres database with `CachingRuntimeDatabase` + `createCacheInvalidationBus({ redisUrl })`
when multiple host replicas share one DB. See [ha-postgres.md](ha-postgres.md).

## Example

`examples/embed-create-app.ts` shows a minimal boot with Postgres (or SQLite) and an in-memory
workspace filesystem stand-in when Mastra is not installed.
