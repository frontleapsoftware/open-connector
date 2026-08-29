import type { IConnectionStore, StoredConnection } from "../../connection-service.ts";
import type { TokenPolicy } from "../../core/action-policy.ts";
import type { ResolvedCredential, RuntimeLogger } from "../../core/types.ts";
import type { IOAuthClientConfigStore, OAuthClientConfig } from "../../oauth/oauth-client-config-service.ts";
import type { IOAuthStateStore, OAuthAuthorizationState } from "../../oauth/oauth-flow-service.ts";
import type { ISecretCodec } from "../secrets/secret-codec-core.ts";
import type {
  CompleteIdempotencyInput,
  IdempotencyClaimInput,
  IdempotencyClaimResult,
  IIdempotencyStore,
} from "./idempotency-store.ts";
import type { RuntimeDatabase } from "./runtime-database.ts";
import type { IRuntimePolicyStore, RuntimePolicyRecord } from "./runtime-policy-store.ts";
import type { IRunLogStore, RunLog, RunLogListInput, RunLogPage, RunLogWriteResult } from "./runtime-store.ts";
import type { IRuntimeTokenStore, RuntimeTokenRecord } from "./runtime-token-service.ts";
import type { Pool, PoolClient, QueryResultRow } from "pg";

import { Pool as PgPool } from "pg";
import { parseRuntimeActionHttpResult } from "../api/runtime-api.ts";
import { PlainTextSecretCodec } from "../secrets/secret-codec-core.ts";
import { runPostgresMigrations } from "./postgres-migrations.ts";
import { DEFAULT_RUN_LIMIT, decodeRunLogCursor, encodeRunLogCursor } from "./runtime-store.ts";

type RuntimeRow = QueryResultRow;
type SecretJsonTable = "oauth_client_configs";
type Queryable = Pool | PoolClient;

export interface PostgresRuntimeDatabaseOptions {
  logger?: RuntimeLogger;
  runLimit?: number;
  secretCodec?: ISecretCodec;
}

interface RotatedConnectionSecret {
  service: string;
  connectionName: string;
  value: string;
}

interface RotatedServiceSecret {
  service: string;
  value: string;
}

interface RotatedIdempotencySecret {
  keyHash: string;
  value: string;
}

interface RotatedStateSecret {
  state: string;
  value: string;
}

/**
 * Create a Postgres-backed runtime database and apply pending migrations.
 */
export async function createPostgresRuntimeDatabase(
  databaseUrlOrPool: string | Pool,
  options: PostgresRuntimeDatabaseOptions = {},
): Promise<PostgresRuntimeDatabase> {
  const pool =
    typeof databaseUrlOrPool === "string" ? new PgPool({ connectionString: databaseUrlOrPool }) : databaseUrlOrPool;
  await runPostgresMigrations(pool, options.logger);
  return new PostgresRuntimeDatabase(pool, options);
}

/**
 * Shared Postgres connection pool for runtime state.
 */
export class PostgresRuntimeDatabase implements RuntimeDatabase {
  readonly connectionStore: PostgresConnectionStore;
  readonly oauthClientConfigStore: PostgresOAuthClientConfigStore;
  readonly oauthStateStore: PostgresOAuthStateStore;
  readonly runtimeTokenStore: PostgresRuntimeTokenStore;
  readonly runtimePolicyStore: PostgresRuntimePolicyStore;
  readonly runLogStore: PostgresRunLogStore;
  readonly idempotencyStore: PostgresIdempotencyStore;

  private readonly pool: Pool;
  private readonly secretCodec: ISecretCodec;

  constructor(databaseUrlOrPool: string | Pool, options: PostgresRuntimeDatabaseOptions = {}) {
    this.pool =
      typeof databaseUrlOrPool === "string" ? new PgPool({ connectionString: databaseUrlOrPool }) : databaseUrlOrPool;
    this.secretCodec = options.secretCodec ?? new PlainTextSecretCodec();
    this.connectionStore = new PostgresConnectionStore(this.pool, this.secretCodec);
    this.oauthClientConfigStore = new PostgresOAuthClientConfigStore(this.pool, this.secretCodec);
    this.oauthStateStore = new PostgresOAuthStateStore(this.pool, this.secretCodec);
    this.runtimeTokenStore = new PostgresRuntimeTokenStore(this.pool);
    this.runtimePolicyStore = new PostgresRuntimePolicyStore(this.pool);
    this.runLogStore = new PostgresRunLogStore(this.pool, options.runLimit ?? DEFAULT_RUN_LIMIT);
    this.idempotencyStore = new PostgresIdempotencyStore(this.pool, this.secretCodec);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async rotateSecretCodec(nextSecretCodec: ISecretCodec): Promise<void> {
    const connections = await readRotatedConnectionSecrets(this.pool, this.secretCodec, nextSecretCodec);
    const oauthConfigs = await readRotatedServiceSecrets(
      this.pool,
      this.secretCodec,
      nextSecretCodec,
      "oauth_client_configs",
    );
    const oauthStates = await readRotatedStateSecrets(this.pool, this.secretCodec, nextSecretCodec);
    const idempotencyResponses = await readRotatedIdempotencySecrets(this.pool, this.secretCodec, nextSecretCodec);

    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await writeRotatedConnectionSecrets(client, connections);
      await writeRotatedServiceSecrets(client, "oauth_client_configs", oauthConfigs);
      await writeRotatedStateSecrets(client, oauthStates);
      await writeRotatedIdempotencySecrets(client, idempotencyResponses);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async resetRuntimeData(): Promise<void> {
    await this.pool.query(`
      delete from connections;
      delete from oauth_client_configs;
      delete from oauth_states;
      delete from runtime_tokens;
      delete from runtime_policy;
      delete from runs;
      delete from idempotency_records;
    `);
  }
}

export class PostgresConnectionStore implements IConnectionStore {
  private readonly pool: Pool;
  private readonly secretCodec: ISecretCodec;

  constructor(pool: Pool, secretCodec: ISecretCodec) {
    this.pool = pool;
    this.secretCodec = secretCodec;
  }

  async get(service: string, connectionName: string): Promise<StoredConnection | undefined> {
    const row = await queryOne(
      this.pool,
      "select id, revision, value from connections where service = $1 and connection_name = $2",
      [service, connectionName],
    );
    return row
      ? {
          id: readString(row, "id"),
          revision: readString(row, "revision"),
          service,
          connectionName,
          credential: parseJson<ResolvedCredential>(await this.secretCodec.decode(readString(row, "value"))),
        }
      : undefined;
  }

  async set(service: string, connectionName: string, credential: ResolvedCredential): Promise<StoredConnection> {
    const row = await queryOne(
      this.pool,
      `
        insert into connections (id, revision, service, connection_name, value, updated_at)
        values ($1, $2, $3, $4, $5, $6)
        on conflict(service, connection_name) do update set
          revision = excluded.revision,
          value = excluded.value,
          updated_at = excluded.updated_at
        returning id, revision
      `,
      [
        crypto.randomUUID(),
        crypto.randomUUID(),
        service,
        connectionName,
        await this.secretCodec.encode(JSON.stringify(credential)),
        new Date().toISOString(),
      ],
    );
    return {
      id: readString(row!, "id"),
      revision: readString(row!, "revision"),
      service,
      connectionName,
      credential,
    };
  }

  async updateCredential(input: StoredConnection): Promise<boolean> {
    const row = await queryOne(
      this.pool,
      `
        update connections
        set revision = $1, value = $2, updated_at = $3
        where service = $4 and connection_name = $5 and id = $6 and revision = $7
        returning id
      `,
      [
        crypto.randomUUID(),
        await this.secretCodec.encode(JSON.stringify(input.credential)),
        new Date().toISOString(),
        input.service,
        input.connectionName,
        input.id,
        input.revision,
      ],
    );
    return row !== undefined;
  }

  async delete(service: string, connectionName: string): Promise<void> {
    await this.pool.query("delete from connections where service = $1 and connection_name = $2", [
      service,
      connectionName,
    ]);
  }

  async list(): Promise<StoredConnection[]> {
    const result = await this.pool.query(
      "select id, revision, service, connection_name, value from connections order by service, connection_name",
    );
    return await Promise.all(
      result.rows.map(async (row) => ({
        id: readString(row, "id"),
        revision: readString(row, "revision"),
        service: readString(row, "service"),
        connectionName: readString(row, "connection_name"),
        credential: parseJson<ResolvedCredential>(await this.secretCodec.decode(readString(row, "value"))),
      })),
    );
  }
}

export class PostgresOAuthClientConfigStore implements IOAuthClientConfigStore {
  private readonly pool: Pool;
  private readonly secretCodec: ISecretCodec;

  constructor(pool: Pool, secretCodec: ISecretCodec) {
    this.pool = pool;
    this.secretCodec = secretCodec;
  }

  async get(service: string): Promise<OAuthClientConfig | undefined> {
    return await getSecretJson<OAuthClientConfig>(this.pool, this.secretCodec, "oauth_client_configs", service);
  }

  async set(config: OAuthClientConfig): Promise<void> {
    await this.pool.query(
      `
        insert into oauth_client_configs (service, value, updated_at)
        values ($1, $2, $3)
        on conflict(service) do update set value = excluded.value, updated_at = excluded.updated_at
      `,
      [config.service, await this.secretCodec.encode(JSON.stringify(config)), new Date().toISOString()],
    );
  }

  async delete(service: string): Promise<void> {
    await this.pool.query("delete from oauth_client_configs where service = $1", [service]);
  }

  async list(): Promise<OAuthClientConfig[]> {
    const result = await this.pool.query("select value from oauth_client_configs order by service");
    return await Promise.all(
      result.rows.map(async (row) =>
        parseJson<OAuthClientConfig>(await this.secretCodec.decode(readString(row, "value"))),
      ),
    );
  }
}

export class PostgresOAuthStateStore implements IOAuthStateStore {
  private readonly pool: Pool;
  private readonly secretCodec: ISecretCodec;

  constructor(pool: Pool, secretCodec: ISecretCodec) {
    this.pool = pool;
    this.secretCodec = secretCodec;
  }

  async set(state: OAuthAuthorizationState): Promise<void> {
    await this.pool.query(
      `
        insert into oauth_states (state, value, created_at)
        values ($1, $2, $3)
        on conflict(state) do update set value = excluded.value, created_at = excluded.created_at
      `,
      [state.state, await this.secretCodec.encode(JSON.stringify(state)), state.createdAt],
    );
  }

  async take(state: string): Promise<OAuthAuthorizationState | undefined> {
    const row = await queryOne(this.pool, "delete from oauth_states where state = $1 returning value", [state]);
    return row
      ? parseJson<OAuthAuthorizationState>(await this.secretCodec.decode(readString(row, "value")))
      : undefined;
  }
}

export class PostgresRuntimeTokenStore implements IRuntimeTokenStore {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async add(record: RuntimeTokenRecord): Promise<void> {
    await this.pool.query(
      `
        insert into runtime_tokens (
          id, name, token_hash, allowed_actions, blocked_actions, allowed_proxies, created_at, last_used_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8)
      `,
      [
        record.id,
        record.name,
        record.tokenHash,
        JSON.stringify(record.allowedActions),
        JSON.stringify(record.blockedActions),
        JSON.stringify(record.allowedProxies),
        record.createdAt,
        record.lastUsedAt ?? null,
      ],
    );
  }

  async list(): Promise<RuntimeTokenRecord[]> {
    const result = await this.pool.query(
      `
        select id, name, token_hash, allowed_actions, blocked_actions, allowed_proxies, created_at, last_used_at
        from runtime_tokens
        where revoked_at is null
        order by created_at desc, id desc
      `,
    );
    return result.rows.map(readRuntimeTokenRow);
  }

  async findByHash(tokenHash: string): Promise<RuntimeTokenRecord | undefined> {
    const row = await queryOne(
      this.pool,
      `
        select id, name, token_hash, allowed_actions, blocked_actions, allowed_proxies, created_at, last_used_at
        from runtime_tokens
        where token_hash = $1 and revoked_at is null
      `,
      [tokenHash],
    );
    return row ? readRuntimeTokenRow(row) : undefined;
  }

  async updatePolicy(id: string, policy: TokenPolicy): Promise<RuntimeTokenRecord | undefined> {
    const row = await queryOne(
      this.pool,
      `
        update runtime_tokens
        set allowed_actions = $1, blocked_actions = $2, allowed_proxies = $3
        where id = $4 and revoked_at is null
        returning id, name, token_hash, allowed_actions, blocked_actions, allowed_proxies, created_at, last_used_at
      `,
      [
        JSON.stringify(policy.allowedActions),
        JSON.stringify(policy.blockedActions),
        JSON.stringify(policy.allowedProxies),
        id,
      ],
    );
    return row ? readRuntimeTokenRow(row) : undefined;
  }

  async revoke(id: string): Promise<boolean> {
    const result = await this.pool.query("delete from runtime_tokens where id = $1", [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async markUsed(id: string, usedAt: string): Promise<void> {
    await this.pool.query("update runtime_tokens set last_used_at = $1 where id = $2 and revoked_at is null", [
      usedAt,
      id,
    ]);
  }
}

function readRuntimeTokenRow(row: RuntimeRow): RuntimeTokenRecord {
  return {
    id: readString(row, "id"),
    name: readString(row, "name"),
    tokenHash: readString(row, "token_hash"),
    allowedActions: parseJson(readString(row, "allowed_actions")),
    blockedActions: parseJson(readString(row, "blocked_actions")),
    allowedProxies: parseJson(readString(row, "allowed_proxies")),
    createdAt: readString(row, "created_at"),
    lastUsedAt: readOptionalString(row, "last_used_at"),
  };
}

export class PostgresRuntimePolicyStore implements IRuntimePolicyStore {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async get(): Promise<RuntimePolicyRecord | undefined> {
    const row = await queryOne(this.pool, "select value, updated_at from runtime_policy where id = 1", []);
    return row
      ? {
          rules: parseJson(readString(row, "value")),
          updatedAt: readString(row, "updated_at"),
        }
      : undefined;
  }

  async set(record: RuntimePolicyRecord): Promise<void> {
    await this.pool.query(
      `
        insert into runtime_policy (id, value, updated_at)
        values (1, $1, $2)
        on conflict(id) do update set value = excluded.value, updated_at = excluded.updated_at
      `,
      [JSON.stringify(record.rules), record.updatedAt],
    );
  }
}

export class PostgresIdempotencyStore implements IIdempotencyStore {
  private readonly pool: Pool;
  private readonly secretCodec: ISecretCodec;

  constructor(pool: Pool, secretCodec: ISecretCodec) {
    this.pool = pool;
    this.secretCodec = secretCodec;
  }

  async claim(input: IdempotencyClaimInput): Promise<IdempotencyClaimResult> {
    await this.pool.query("delete from idempotency_records where expires_at <= $1", [input.now]);

    const inserted = await this.pool.query(
      `
        insert into idempotency_records (
          key_hash, claim_id, request_hash, state, response_value, created_at, expires_at
        )
        values ($1, $2, $3, 'in_progress', null, $4, $5)
        on conflict(key_hash) do nothing
      `,
      [input.keyHash, input.claimId, input.requestHash, input.now, input.expiresAt],
    );
    if ((inserted.rowCount ?? 0) > 0) {
      return { kind: "acquired" };
    }

    const row = await queryOne(
      this.pool,
      "select request_hash, state, response_value from idempotency_records where key_hash = $1",
      [input.keyHash],
    );
    if (!row) {
      throw new Error("Idempotency record disappeared while claiming it.");
    }
    if (readString(row, "request_hash") !== input.requestHash) {
      return { kind: "conflict" };
    }
    if (readString(row, "state") === "in_progress") {
      return { kind: "in_progress" };
    }

    const response = parseRuntimeActionHttpResult(
      parseJson(await this.secretCodec.decode(readString(row, "response_value"))),
    );
    return { kind: "completed", response };
  }

  async complete(input: CompleteIdempotencyInput): Promise<boolean> {
    const result = await this.pool.query(
      `
        update idempotency_records
        set state = 'completed', response_value = $1, expires_at = $2
        where key_hash = $3
          and claim_id = $4
          and request_hash = $5
          and state = 'in_progress'
      `,
      [
        await this.secretCodec.encode(JSON.stringify(input.response)),
        input.expiresAt,
        input.keyHash,
        input.claimId,
        input.requestHash,
      ],
    );
    return (result.rowCount ?? 0) > 0;
  }
}

export class PostgresRunLogStore implements IRunLogStore {
  private readonly pool: Pool;
  private readonly limit: number;

  constructor(pool: Pool, limit: number) {
    this.pool = pool;
    this.limit = limit;
  }

  async add(run: RunLog): Promise<RunLogWriteResult> {
    await this.pool.query(
      `
        insert into runs (id, service, action_id, caller, started_at, completed_at, ok, value)
        values ($1, $2, $3, $4, $5, $6, $7, $8)
        on conflict(id) do update set
          service = excluded.service,
          action_id = excluded.action_id,
          caller = excluded.caller,
          started_at = excluded.started_at,
          completed_at = excluded.completed_at,
          ok = excluded.ok,
          value = excluded.value
      `,
      [
        run.id,
        run.service,
        run.actionId,
        run.caller,
        run.startedAt,
        run.completedAt,
        run.ok ? 1 : 0,
        JSON.stringify(run),
      ],
    );

    try {
      await this.pool.query(
        `
          delete from runs
          where id in (
            select id from runs
            order by started_at desc, id desc
            offset $1
          )
        `,
        [this.limit],
      );
      return { retentionApplied: true };
    } catch {
      return { retentionApplied: false };
    }
  }

  async get(id: string): Promise<RunLog | undefined> {
    const row = await queryOne(this.pool, "select service, value from runs where id = $1", [id]);
    return row ? readRunLogRow(row) : undefined;
  }

  async list(input: RunLogListInput = {}): Promise<RunLogPage> {
    const limit = Math.max(1, Math.min(input.limit ?? this.limit, this.limit));
    const cursor = decodeRunLogCursor(input.cursor);
    const conditions: string[] = [];
    const values: Array<string | number> = [];
    let index = 1;
    if (cursor) {
      conditions.push(`(started_at < $${index} or (started_at = $${index + 1} and id < $${index + 2}))`);
      values.push(cursor.startedAt, cursor.startedAt, cursor.id);
      index += 3;
    }
    if (input.service) {
      conditions.push(`service = $${index}`);
      values.push(input.service);
      index += 1;
    }
    if (input.actionId) {
      conditions.push(`action_id = $${index}`);
      values.push(input.actionId);
      index += 1;
    }
    if (input.caller) {
      conditions.push(`caller = $${index}`);
      values.push(input.caller);
      index += 1;
    }
    if (input.ok !== undefined) {
      conditions.push(`ok = $${index}`);
      values.push(input.ok ? 1 : 0);
      index += 1;
    }
    const where = conditions.length > 0 ? `where ${conditions.join(" and ")}` : "";
    values.push(limit + 1);
    const result = await this.pool.query(
      `select service, value from runs ${where} order by started_at desc, id desc limit $${index}`,
      values,
    );
    const runs = result.rows.map(readRunLogRow);
    const items = runs.slice(0, limit);

    return {
      items,
      nextCursor: runs.length > limit && items.length > 0 ? encodeRunLogCursor(items[items.length - 1]) : undefined,
    };
  }
}

async function getSecretJson<T>(
  pool: Pool,
  secretCodec: ISecretCodec,
  table: SecretJsonTable,
  service: string,
): Promise<T | undefined> {
  const row = await queryOne(pool, `select value from ${table} where service = $1`, [service]);
  return row ? parseJson<T>(await secretCodec.decode(readString(row, "value"))) : undefined;
}

async function queryOne(queryable: Queryable, sql: string, params: unknown[]): Promise<RuntimeRow | undefined> {
  const result = await queryable.query(sql, params);
  return result.rows[0];
}

async function readRotatedConnectionSecrets(
  pool: Pool,
  currentCodec: ISecretCodec,
  nextCodec: ISecretCodec,
): Promise<RotatedConnectionSecret[]> {
  const result = await pool.query("select service, connection_name, value from connections");
  return await Promise.all(
    result.rows.map(async (row) => ({
      service: readString(row, "service"),
      connectionName: readString(row, "connection_name"),
      value: await nextCodec.encode(await currentCodec.decode(readString(row, "value"))),
    })),
  );
}

async function writeRotatedConnectionSecrets(
  client: PoolClient,
  connections: RotatedConnectionSecret[],
): Promise<void> {
  for (const connection of connections) {
    await client.query("update connections set value = $1 where service = $2 and connection_name = $3", [
      connection.value,
      connection.service,
      connection.connectionName,
    ]);
  }
}

async function readRotatedServiceSecrets(
  pool: Pool,
  currentCodec: ISecretCodec,
  nextCodec: ISecretCodec,
  table: SecretJsonTable,
): Promise<RotatedServiceSecret[]> {
  const result = await pool.query(`select service, value from ${table}`);
  return await Promise.all(
    result.rows.map(async (row) => ({
      service: readString(row, "service"),
      value: await nextCodec.encode(await currentCodec.decode(readString(row, "value"))),
    })),
  );
}

async function writeRotatedServiceSecrets(
  client: PoolClient,
  table: SecretJsonTable,
  services: RotatedServiceSecret[],
): Promise<void> {
  for (const service of services) {
    await client.query(`update ${table} set value = $1 where service = $2`, [service.value, service.service]);
  }
}

async function readRotatedStateSecrets(
  pool: Pool,
  currentCodec: ISecretCodec,
  nextCodec: ISecretCodec,
): Promise<RotatedStateSecret[]> {
  const result = await pool.query("select state, value from oauth_states");
  return await Promise.all(
    result.rows.map(async (row) => ({
      state: readString(row, "state"),
      value: await nextCodec.encode(await currentCodec.decode(readString(row, "value"))),
    })),
  );
}

async function writeRotatedStateSecrets(client: PoolClient, states: RotatedStateSecret[]): Promise<void> {
  for (const state of states) {
    await client.query("update oauth_states set value = $1 where state = $2", [state.value, state.state]);
  }
}

async function readRotatedIdempotencySecrets(
  pool: Pool,
  currentCodec: ISecretCodec,
  nextCodec: ISecretCodec,
): Promise<RotatedIdempotencySecret[]> {
  const result = await pool.query(
    "select key_hash, response_value from idempotency_records where response_value is not null",
  );
  return await Promise.all(
    result.rows.map(async (row) => ({
      keyHash: readString(row, "key_hash"),
      value: await nextCodec.encode(await currentCodec.decode(readString(row, "response_value"))),
    })),
  );
}

async function writeRotatedIdempotencySecrets(
  client: PoolClient,
  responses: RotatedIdempotencySecret[],
): Promise<void> {
  for (const response of responses) {
    await client.query("update idempotency_records set response_value = $1 where key_hash = $2", [
      response.value,
      response.keyHash,
    ]);
  }
}

function readRunLogRow(row: RuntimeRow): RunLog {
  const run = parseJson<RunLog>(readString(row, "value"));
  return { ...run, service: readString(row, "service") };
}

function readString(row: RuntimeRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new Error(`Expected Postgres column ${key} to be a string.`);
  }

  return value;
}

function readOptionalString(row: RuntimeRow, key: string): string | undefined {
  const value = row[key];
  if (value == null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`Expected Postgres column ${key} to be a string.`);
  }

  return value;
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}
