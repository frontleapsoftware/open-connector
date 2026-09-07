/**
 * Public embed surface for hosting OpenConnector inside another Node process.
 * Import concrete modules for narrower needs; use this entry when wiring an app host.
 */

export { loadCatalog } from "./catalog-store.ts";
export type { CatalogStore } from "./catalog-store.ts";
export { ActionRunner } from "./server/actions/action-runner.ts";
export type { ActionRunResult, RunActionInput } from "./server/actions/action-runner.ts";
export { createConnectApp } from "./server/connect-app.ts";
export type { ConnectApp, ConnectAppOptions } from "./server/connect-app.ts";
export { createSecretCodec } from "./server/secrets/secret-codec.ts";
export type { ISecretCodec } from "./server/secrets/secret-codec-core.ts";
export { resolveServerAssets } from "./server/server-assets.ts";
export type { ServerAssets } from "./server/server-assets.ts";
export { createCacheInvalidationBus } from "./server/storage/cache-invalidation-bus.ts";
export { CachingRuntimeDatabase } from "./server/storage/caching-runtime-database.ts";
export { createNodeRuntimeDatabase } from "./server/storage/node-runtime-database.ts";
export type { NodeRuntimeDatabase, NodeRuntimeDatabaseOptions } from "./server/storage/node-runtime-database.ts";
export { PostgresRuntimeDatabase } from "./server/storage/postgres-runtime-store.ts";
export type { RuntimeDatabase } from "./server/storage/runtime-database.ts";
export { SqliteRuntimeDatabase } from "./server/storage/sqlite-runtime-store.ts";
export { S3TransitFileService } from "./server/files/s3-transit-files.ts";
export { TransitFileService } from "./server/files/transit-files.ts";
export type { ITransitFileService } from "./server/files/transit-file-store.ts";
export { WorkspaceTransitFileService } from "./server/files/workspace-transit-files.ts";
export type { WorkspaceFilesystemLike, WorkspaceTransitFileOptions } from "./server/files/workspace-transit-files.ts";
export { ProviderLoader } from "./providers/provider-loader.ts";
export { executorModules } from "./providers/registry.generated.ts";
