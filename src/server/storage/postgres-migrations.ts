import type { RuntimeLogger } from "../../core/types.ts";
import type { Pool } from "pg";

import { readdir, readFile } from "node:fs/promises";

const migrationDirectory = new URL("../../../migrations/postgres/", import.meta.url);

/**
 * Apply pending SQL files from migrations/postgres/ in lexical order.
 */
export async function runPostgresMigrations(pool: Pool, logger?: RuntimeLogger): Promise<void> {
  await pool.query(`
    create table if not exists schema_migrations (
      id text primary key,
      applied_at text not null
    )
  `);

  const applied = new Set(
    (await pool.query<{ id: string }>("select id from schema_migrations")).rows.map((row) => row.id),
  );
  const files = (await readdir(migrationDirectory)).filter((name) => /^\d+_.*\.sql$/.test(name)).sort();

  for (const file of files) {
    if (applied.has(file)) {
      continue;
    }

    const sql = await readFile(new URL(file, migrationDirectory), "utf8");
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(sql);
      await client.query("insert into schema_migrations (id, applied_at) values ($1, $2)", [
        file,
        new Date().toISOString(),
      ]);
      await client.query("commit");
      logger?.info({ migration: file }, "applied postgres runtime migration");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
}
