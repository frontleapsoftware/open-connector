import type { WorkspaceFilesystemLike } from "../src/embed.ts";

/**
 * Minimal embed example: build a Connect Hono app with injectable storage.
 *
 * Postgres:
 *   OOMOL_CONNECT_DATABASE_URL=postgres://... OOMOL_CONNECT_ENCRYPTION_KEY=... node examples/embed-create-app.ts
 *
 * SQLite fallback (no DATABASE_URL):
 *   node examples/embed-create-app.ts
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  createConnectApp,
  createPostgresRuntimeDatabase,
  createSecretCodec,
  executorModules,
  loadCatalog,
  ProviderLoader,
  SqliteRuntimeDatabase,
  WorkspaceTransitFileService,
} from "../src/embed.ts";

class MemoryWorkspaceFilesystem implements WorkspaceFilesystemLike {
  readonly files = new Map<string, Buffer>();

  async readFile(path: string, options?: { encoding?: "utf-8" | "binary" }): Promise<string | Buffer> {
    const value = this.files.get(path);
    if (!value) {
      throw new Error(`ENOENT: ${path}`);
    }
    return options?.encoding === "utf-8" ? value.toString("utf8") : value;
  }

  async writeFile(path: string, content: string | Buffer): Promise<void> {
    this.files.set(path, typeof content === "string" ? Buffer.from(content) : Buffer.from(content));
  }

  async deleteFile(path: string, options?: { force?: boolean }): Promise<void> {
    if (!this.files.has(path) && !options?.force) {
      throw new Error(`ENOENT: ${path}`);
    }
    this.files.delete(path);
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }
}

const publicOrigin = process.env.OOMOL_CONNECT_ORIGIN ?? "http://127.0.0.1:3000";
const encryptionKey = process.env.OOMOL_CONNECT_ENCRYPTION_KEY;
const databaseUrl = process.env.OOMOL_CONNECT_DATABASE_URL?.trim();
const secretCodec = createSecretCodec(encryptionKey);

if (databaseUrl && !encryptionKey) {
  throw new Error("OOMOL_CONNECT_ENCRYPTION_KEY is required with OOMOL_CONNECT_DATABASE_URL.");
}

const runtimeDatabase = databaseUrl
  ? await createPostgresRuntimeDatabase(databaseUrl, { secretCodec })
  : await (async () => {
      const dataDir = join(process.cwd(), "data");
      await mkdir(dataDir, { recursive: true });
      return new SqliteRuntimeDatabase(join(dataDir, "embed-example.sqlite"), { secretCodec });
    })();

const transitFiles = new WorkspaceTransitFileService({
  filesystem: new MemoryWorkspaceFilesystem(),
  publicOrigin,
  ttlSeconds: 86_400,
  maxBytes: 10 * 1024 * 1024,
});

const catalog = await loadCatalog(undefined, { executableServices: Object.keys(executorModules) });
const { app } = await createConnectApp({
  catalog,
  providerLoader: new ProviderLoader(executorModules),
  runtimeDatabase,
  transitFiles,
  publicOrigin,
  secretCodec,
});

const health = await app.request("/health");
console.log("embed health", health.status, await health.json());
console.log("transit backend: WorkspaceTransitFileService (swap MemoryWorkspaceFilesystem for Mastra FS)");

if ("close" in runtimeDatabase && typeof runtimeDatabase.close === "function") {
  await runtimeDatabase.close();
}
