import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createSecretCodec } from "../src/server/secrets/secret-codec.ts";
import { createCacheInvalidationBus } from "../src/server/storage/cache-invalidation-bus.ts";
import { createPostgresRuntimeDatabase } from "../src/server/storage/postgres-runtime-store.ts";
import { SqliteRuntimeDatabase } from "../src/server/storage/sqlite-runtime-store.ts";

const { positionals, values: options } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    "data-dir": { type: "string" },
    "database-url": { type: "string" },
    plain: { type: "boolean" },
    yes: { type: "boolean" },
  },
  strict: true,
});
const [command] = positionals;

if (positionals.length !== 1 || (command !== "reset" && command !== "rotate-key")) {
  printUsageAndExit();
}

const nextEncryptionKey = process.env.OOMOL_CONNECT_NEW_ENCRYPTION_KEY;
if (command === "rotate-key") {
  if (options.yes) {
    throw new Error("--yes is only valid with reset.");
  }
  if (!nextEncryptionKey && !options.plain) {
    throw new Error("rotate-key requires OOMOL_CONNECT_NEW_ENCRYPTION_KEY unless --plain is set.");
  }
} else {
  if (options.plain) {
    throw new Error("--plain is only valid with rotate-key.");
  }
  if (!options.yes) {
    throw new Error("reset requires --yes.");
  }
}

const databaseUrl = options["database-url"] ?? process.env.OOMOL_CONNECT_DATABASE_URL?.trim();
const dataDir = resolve(options["data-dir"] ?? process.env.OOMOL_CONNECT_DATA_DIR ?? join(process.cwd(), "data"));
const secretCodec = createSecretCodec(process.env.OOMOL_CONNECT_ENCRYPTION_KEY);

if (databaseUrl) {
  if (!process.env.OOMOL_CONNECT_ENCRYPTION_KEY) {
    throw new Error("OOMOL_CONNECT_ENCRYPTION_KEY is required when using a Postgres database URL.");
  }
  const database = await createPostgresRuntimeDatabase(databaseUrl, { secretCodec });
  try {
    if (command === "rotate-key") {
      await database.rotateSecretCodec(createSecretCodec(options.plain ? undefined : nextEncryptionKey));
      await publishCacheFlush();
      console.log(`Rotated runtime secret encryption in Postgres.`);
    } else {
      await database.resetRuntimeData();
      await publishCacheFlush();
      console.log(`Reset runtime data in Postgres.`);
    }
  } finally {
    await database.close();
  }
} else {
  const databasePath = join(dataDir, "connect.sqlite");
  await mkdir(dataDir, { recursive: true });
  const database = new SqliteRuntimeDatabase(databasePath, { secretCodec });
  try {
    if (command === "rotate-key") {
      await database.rotateSecretCodec(createSecretCodec(options.plain ? undefined : nextEncryptionKey));
      console.log(`Rotated runtime secret encryption in ${databasePath}.`);
    } else {
      database.resetRuntimeData();
      console.log(`Reset runtime data in ${databasePath}.`);
    }
  } finally {
    database.close();
  }
}

async function publishCacheFlush(): Promise<void> {
  const redisUrl = process.env.OOMOL_CONNECT_REDIS_URL?.trim();
  if (!redisUrl) {
    return;
  }
  const bus = await createCacheInvalidationBus({
    redisUrl,
    channel: process.env.OOMOL_CONNECT_CACHE_CHANNEL?.trim() || undefined,
  });
  try {
    await bus.publish(["*"]);
  } finally {
    await bus.close();
  }
}

function printUsageAndExit(): never {
  console.error(`Usage:
  node scripts/runtime-data.ts reset --yes [--data-dir ./data]
  node scripts/runtime-data.ts reset --yes --database-url postgres://...
  node scripts/runtime-data.ts rotate-key [--data-dir ./data]
  node scripts/runtime-data.ts rotate-key --database-url postgres://...
  node scripts/runtime-data.ts rotate-key --plain [--data-dir ./data]

Set OOMOL_CONNECT_ENCRYPTION_KEY to read/write encrypted credential records.
Set OOMOL_CONNECT_NEW_ENCRYPTION_KEY when rotating to a new encryption key.
Set OOMOL_CONNECT_DATABASE_URL (or --database-url) to target Postgres instead of SQLite.
Set OOMOL_CONNECT_REDIS_URL to publish a full cache flush after Postgres rotate/reset.`);
  process.exit(1);
}
