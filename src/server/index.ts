import type { ITransitFileService } from "./files/transit-file-store.ts";
import type { RuntimeDatabase } from "./storage/runtime-database.ts";

import { serve } from "@hono/node-server";
import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { loadCatalog } from "../catalog-store.ts";
import { ActionPolicyService, parseActionPolicyList } from "../core/action-policy.ts";
import {
  parseEgressTrustedHosts,
  parsePrivateNetworkAccessFlag,
  setEgressTrustedHosts,
  setPrivateNetworkAccessAllowed,
} from "../core/request.ts";
import { ProviderLoader } from "../providers/provider-loader.ts";
import { executorModules } from "../providers/registry.generated.ts";
import { createRuntimeJwtVerifier } from "./api/runtime-jwt.ts";
import { registerStaticRoutes } from "./api/static-routes.ts";
import { createConnectApp } from "./connect-app.ts";
import { S3TransitFileService } from "./files/s3-transit-files.ts";
import { TransitFileService } from "./files/transit-files.ts";
import { logger } from "./logger.ts";
import { createSecretCodec } from "./secrets/secret-codec.ts";
import { createCacheInvalidationBus } from "./storage/cache-invalidation-bus.ts";
import { CachingRuntimeDatabase } from "./storage/caching-runtime-database.ts";
import { createPostgresRuntimeDatabase } from "./storage/postgres-runtime-store.ts";
import { DEFAULT_RUN_LIMIT } from "./storage/runtime-store.ts";
import { SqliteRuntimeDatabase } from "./storage/sqlite-runtime-store.ts";

const port = Number(process.env.PORT ?? 3000);
const hostname = process.env.HOST ?? "127.0.0.1";
const publicOrigin = process.env.OOMOL_CONNECT_ORIGIN ?? `http://localhost:${port}`;
const dataDir = process.env.OOMOL_CONNECT_DATA_DIR ?? join(process.cwd(), "data");
const databaseUrl = process.env.OOMOL_CONNECT_DATABASE_URL?.trim();
const redisUrl = process.env.OOMOL_CONNECT_REDIS_URL?.trim();
const cacheTtlMs = readPositiveIntegerEnv("OOMOL_CONNECT_CACHE_TTL_MS", 30_000);
const cacheChannel = process.env.OOMOL_CONNECT_CACHE_CHANNEL?.trim() || undefined;
const transitFileTtlSeconds = readPositiveIntegerEnv("OOMOL_CONNECT_TRANSIT_FILE_TTL_SECONDS", 86_400);
const transitFileMaxBytes = readPositiveIntegerEnv("OOMOL_CONNECT_TRANSIT_FILE_MAX_BYTES", 100 * 1024 * 1024);
const runLimit = readPositiveIntegerEnv("OOMOL_CONNECT_RUN_LIMIT", DEFAULT_RUN_LIMIT);
const encryptionKey = process.env.OOMOL_CONNECT_ENCRYPTION_KEY;
const secretCodec = createSecretCodec(encryptionKey);
const adminToken = process.env.OOMOL_CONNECT_ADMIN_TOKEN;
const runtimeToken = process.env.OOMOL_CONNECT_RUNTIME_TOKEN;
const verifyRuntimeJwt = createRuntimeJwtVerifier({
  jwksUri: process.env.OOMOL_CONNECT_JWKS_URI,
  issuer: process.env.OOMOL_CONNECT_JWT_ISSUER,
  audience: process.env.OOMOL_CONNECT_JWT_AUDIENCE,
});
const actionPolicy = new ActionPolicyService({
  allowedActions: parseActionPolicyList(process.env.OOMOL_CONNECT_ALLOWED_ACTIONS),
  blockedActions: parseActionPolicyList(process.env.OOMOL_CONNECT_BLOCKED_ACTIONS),
  allowedProxies: parseActionPolicyList(process.env.OOMOL_CONNECT_ALLOWED_PROXIES),
  blockedProxies: parseActionPolicyList(process.env.OOMOL_CONNECT_BLOCKED_PROXIES),
});
const allowedCustomOAuth = parseActionPolicyList(process.env.OOMOL_CONNECT_ALLOWED_CUSTOM_OAUTH);
setPrivateNetworkAccessAllowed(parsePrivateNetworkAccessFlag(process.env.OOMOL_CONNECT_ALLOW_PRIVATE_NETWORK));
setEgressTrustedHosts(parseEgressTrustedHosts(process.env.OOMOL_CONNECT_EGRESS_TRUSTED_HOSTS));
const builtRoot = join(process.cwd(), "dist/web");
const staticRoot = await resolveStaticRoot(builtRoot);

if (databaseUrl && !encryptionKey) {
  throw new Error("OOMOL_CONNECT_ENCRYPTION_KEY is required when OOMOL_CONNECT_DATABASE_URL is set.");
}

await mkdir(dataDir, { recursive: true });
const catalog = await loadCatalog(undefined, {
  executableServices: Object.keys(executorModules),
});
const providerLoader = new ProviderLoader(executorModules);

const { runtimeDatabase, closeRuntime } = await createRuntimeStorage({
  databaseUrl,
  redisUrl,
  cacheChannel,
  cacheTtlMs,
  dataDir,
  secretCodec,
  runLimit,
});
const transitFiles = createTransitFiles({
  publicOrigin,
  dataDir,
  ttlSeconds: transitFileTtlSeconds,
  maxBytes: transitFileMaxBytes,
});
await transitFiles.cleanupExpired();
const { app, runtimeAuthConfigured } = await createConnectApp({
  catalog,
  providerLoader,
  runtimeDatabase,
  transitFiles,
  publicOrigin,
  secretCodec,
  adminToken,
  runtimeToken,
  verifyRuntimeJwt,
  actionPolicy,
  allowedCustomOAuth,
  registerStaticRoutes: (app) => registerStaticRoutes(app, staticRoot),
  logger,
});

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "shutting down connect server");
  await closeRuntime();
  process.exit(0);
}

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});
process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});

serve(
  {
    fetch: app.fetch,
    port,
    hostname,
  },
  (info) => {
    logger.info({ url: `http://${hostname}:${info.port}` }, "connect server listening");
    if (databaseUrl) {
      logger.info({ backend: "postgres" }, "runtime database");
    } else {
      logger.info({ dataDir }, "runtime data directory");
    }
    if (!adminToken) {
      logger.warn("local admin authentication is disabled; set OOMOL_CONNECT_ADMIN_TOKEN to require bearer tokens");
    }
    if (!runtimeAuthConfigured) {
      logger.warn(
        "runtime API authentication is disabled; create a runtime token in the web console, set OOMOL_CONNECT_RUNTIME_TOKEN, or configure JWT authentication",
      );
    }
    if (!secretCodec.encrypted) {
      logger.warn(
        "local data encryption is disabled; set OOMOL_CONNECT_ENCRYPTION_KEY to encrypt stored credentials, OAuth client configuration, pending OAuth state, and completed idempotent action responses",
      );
    }
    if (!staticRoot) {
      logger.warn("web console assets are not built; use http://localhost:5173 for local console development");
    }
  },
);

interface CreateRuntimeStorageInput {
  databaseUrl: string | undefined;
  redisUrl: string | undefined;
  cacheChannel: string | undefined;
  cacheTtlMs: number;
  dataDir: string;
  secretCodec: ReturnType<typeof createSecretCodec>;
  runLimit: number;
}

interface RuntimeStorage {
  runtimeDatabase: RuntimeDatabase;
  closeRuntime: () => Promise<void>;
}

async function createRuntimeStorage(input: CreateRuntimeStorageInput): Promise<RuntimeStorage> {
  const inner = input.databaseUrl
    ? await createPostgresRuntimeDatabase(input.databaseUrl, {
        logger,
        secretCodec: input.secretCodec,
        runLimit: input.runLimit,
      })
    : new SqliteRuntimeDatabase(join(input.dataDir, "connect.sqlite"), {
        logger,
        secretCodec: input.secretCodec,
        runLimit: input.runLimit,
      });

  // L1 cache is only enabled with Redis so multi-replica invalidation stays coherent.
  // Postgres alone (no Redis) still works as a shared durable store without a local cache.
  if (!input.redisUrl) {
    return {
      runtimeDatabase: inner,
      closeRuntime: async () => {
        await Promise.resolve(inner.close());
      },
    };
  }

  const bus = await createCacheInvalidationBus({
    redisUrl: input.redisUrl,
    channel: input.cacheChannel,
    logger,
  });
  const cached = new CachingRuntimeDatabase(inner, {
    bus,
    ttlMs: input.cacheTtlMs,
    logger,
  });
  await cached.start();
  return {
    runtimeDatabase: cached,
    closeRuntime: async () => {
      await cached.close();
    },
  };
}

interface CreateTransitFilesInput {
  publicOrigin: string;
  dataDir: string;
  ttlSeconds: number;
  maxBytes: number;
}

function createTransitFiles(input: CreateTransitFilesInput): ITransitFileService {
  const bucket = process.env.OOMOL_CONNECT_S3_BUCKET?.trim();
  if (!bucket) {
    return new TransitFileService({
      rootDir: join(input.dataDir, "files"),
      publicOrigin: input.publicOrigin,
      ttlSeconds: input.ttlSeconds,
      maxBytes: input.maxBytes,
    });
  }

  return new S3TransitFileService({
    bucket,
    publicOrigin: input.publicOrigin,
    ttlSeconds: input.ttlSeconds,
    maxBytes: input.maxBytes,
    region: process.env.OOMOL_CONNECT_S3_REGION?.trim() || undefined,
    endpoint: process.env.OOMOL_CONNECT_S3_ENDPOINT?.trim() || undefined,
    accessKeyId: process.env.OOMOL_CONNECT_S3_ACCESS_KEY_ID?.trim() || undefined,
    secretAccessKey: process.env.OOMOL_CONNECT_S3_SECRET_ACCESS_KEY?.trim() || undefined,
    forcePathStyle: parseBooleanEnv(process.env.OOMOL_CONNECT_S3_FORCE_PATH_STYLE),
  });
}

async function resolveStaticRoot(root: string): Promise<string | undefined> {
  try {
    await access(join(root, "index.html"));
    return root;
  } catch {
    return undefined;
  }
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBooleanEnv(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}
