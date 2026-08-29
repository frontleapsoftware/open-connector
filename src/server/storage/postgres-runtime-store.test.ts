import type { RuntimeActionHttpResult } from "../api/runtime-api.ts";
import type { Pool } from "pg";

import { Pool as PgPool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AesGcmSecretCodec } from "../secrets/secret-codec.ts";
import { createPostgresRuntimeDatabase, PostgresRuntimeDatabase } from "./postgres-runtime-store.ts";
import { RuntimeTokenService } from "./runtime-token-service.ts";

const databaseUrl = process.env.OOMOL_CONNECT_TEST_DATABASE_URL;
const githubProfile = {
  accountId: "github:octocat",
  displayName: "octocat",
  grantedScopes: [],
};

describe.skipIf(!databaseUrl).sequential("PostgresRuntimeDatabase", () => {
  let pool: Pool;
  let database: PostgresRuntimeDatabase;

  beforeAll(async () => {
    pool = new PgPool({ connectionString: databaseUrl });
    database = await createPostgresRuntimeDatabase(pool, {
      secretCodec: new AesGcmSecretCodec("local-test-key"),
      runLimit: 5,
    });
  });

  beforeEach(async () => {
    await database.resetRuntimeData();
  });

  afterAll(async () => {
    await database.close();
  });

  it("stores connections and OAuth client configs through the secret codec", async () => {
    await database.connectionStore.set("github", "default", {
      authType: "api_key",
      apiKey: "github-token",
      values: { apiKey: "github-token" },
      profile: githubProfile,
      metadata: { login: "octocat" },
    });
    await database.oauthClientConfigStore.set({
      service: "gmail",
      clientId: "client-id",
      clientSecret: "client-secret",
      requestedScopes: ["gmail.readonly"],
      extra: { tenant: "default" },
      secretExtra: {},
    });

    expect(await readStoredValue(pool, "connections", "service", "github")).not.toContain("github-token");
    expect(await readStoredValue(pool, "oauth_client_configs", "service", "gmail")).not.toContain("client-secret");
    await expect(database.connectionStore.get("github", "default")).resolves.toMatchObject({
      id: expect.any(String),
      credential: {
        authType: "api_key",
        apiKey: "github-token",
        metadata: { login: "octocat" },
      },
    });
    await expect(database.oauthClientConfigStore.get("gmail")).resolves.toMatchObject({
      clientId: "client-id",
      clientSecret: "client-secret",
      requestedScopes: ["gmail.readonly"],
      extra: { tenant: "default" },
    });
    await expect(database.connectionStore.list()).resolves.toMatchObject([
      { service: "github", connectionName: "default" },
    ]);
    await expect(database.oauthClientConfigStore.list()).resolves.toMatchObject([{ service: "gmail" }]);

    await database.connectionStore.delete("github", "default");
    await database.oauthClientConfigStore.delete("gmail");
    await expect(database.connectionStore.get("github", "default")).resolves.toBeUndefined();
    await expect(database.oauthClientConfigStore.get("gmail")).resolves.toBeUndefined();
  });

  it("preserves connection identity and rejects stale credential revisions", async () => {
    const plain = new PostgresRuntimeDatabase(pool);
    const credential = {
      authType: "api_key" as const,
      apiKey: "github-token",
      values: { apiKey: "github-token" },
      profile: githubProfile,
      metadata: {},
    };

    const created = await plain.connectionStore.set("github", "default", credential);
    const updated = await plain.connectionStore.set("github", "default", {
      ...credential,
      apiKey: "updated-token",
    });
    expect(updated.id).toBe(created.id);
    expect(updated.revision).not.toBe(created.revision);
    await expect(
      plain.connectionStore.updateCredential({
        ...created,
        credential: { ...credential, apiKey: "stale-refreshed-token" },
      }),
    ).resolves.toBe(false);
    await expect(
      plain.connectionStore.updateCredential({
        ...updated,
        credential: { ...credential, apiKey: "refreshed-token" },
      }),
    ).resolves.toBe(true);
    await expect(
      plain.connectionStore.updateCredential({
        ...updated,
        credential: { ...credential, apiKey: "second-refreshed-token" },
      }),
    ).resolves.toBe(false);
    await expect(plain.connectionStore.get("github", "default")).resolves.toMatchObject({
      id: updated.id,
      credential: { apiKey: "refreshed-token" },
    });

    await plain.connectionStore.delete("github", "default");
    const recreated = await plain.connectionStore.set("github", "default", credential);
    expect(recreated.id).not.toBe(updated.id);
    await expect(
      plain.connectionStore.updateCredential({
        ...updated,
        credential: { ...credential, apiKey: "stale-refreshed-token" },
      }),
    ).resolves.toBe(false);
    await expect(plain.connectionStore.get("github", "default")).resolves.toMatchObject({
      id: recreated.id,
      credential: { apiKey: "github-token" },
    });
  });

  it("takes OAuth state once", async () => {
    await database.oauthStateStore.set({
      service: "gmail",
      state: "state-1",
      createdAt: "2026-06-30T00:00:00.000Z",
    });

    await expect(database.oauthStateStore.take("state-1")).resolves.toMatchObject({
      service: "gmail",
      state: "state-1",
    });
    await expect(database.oauthStateStore.take("state-1")).resolves.toBeUndefined();
  });

  it("stores OAuth state through the secret codec", async () => {
    await database.oauthStateStore.set({
      service: "github",
      state: "state-1",
      createdAt: "2026-06-30T00:00:00.000Z",
      clientConfig: {
        service: "github",
        clientId: "client-id",
        clientSecret: "client-secret",
        extra: {},
        secretExtra: {},
      },
    });

    expect(await readStoredValue(pool, "oauth_states", "state", "state-1")).not.toContain("client-secret");
    await expect(database.oauthStateStore.take("state-1")).resolves.toMatchObject({
      clientConfig: { clientSecret: "client-secret" },
    });
  });

  it("stores runtime token hashes and supports verification and revocation", async () => {
    const tokens = new RuntimeTokenService(database.runtimeTokenStore);

    const created = await tokens.createToken("Claude Desktop", {
      allowedActions: ["github.*"],
      blockedActions: ["github.delete_repository"],
      allowedProxies: ["github"],
    });
    expect(created.token).toMatch(/^oct_/);
    expect(created.record.tokenHash).not.toBe(created.token);

    await expect(tokens.verifyToken(created.token)).resolves.toBe(true);
    const [listed] = await tokens.listTokens();
    expect(listed).toMatchObject({
      id: created.record.id,
      name: "Claude Desktop",
      allowedActions: ["github.*"],
      blockedActions: ["github.delete_repository"],
      allowedProxies: ["github"],
    });
    expect(listed?.lastUsedAt).toBeTruthy();

    await expect(
      tokens.updateTokenPolicy(created.record.id, {
        allowedActions: ["github.get_current_user"],
        blockedActions: [],
        allowedProxies: ["slack"],
      }),
    ).resolves.toMatchObject({
      allowedActions: ["github.get_current_user"],
      blockedActions: [],
      allowedProxies: ["slack"],
    });

    await expect(tokens.revokeToken(created.record.id)).resolves.toBe(true);
    await expect(tokens.listTokens()).resolves.toEqual([]);
    await expect(tokens.verifyToken(created.token)).resolves.toBe(false);
    await expect(tokens.revokeToken(created.record.id)).resolves.toBe(false);
  });

  it("persists the singleton runtime policy", async () => {
    const record = {
      rules: {
        allowedActions: ["github.*"],
        blockedActions: [],
        allowedProxies: ["github"],
        blockedProxies: ["slack"],
      },
      updatedAt: "2026-07-20T00:00:00.000Z",
    };

    await expect(database.runtimePolicyStore.get()).resolves.toBeUndefined();
    await database.runtimePolicyStore.set(record);
    await expect(database.runtimePolicyStore.get()).resolves.toEqual(record);
  });

  it("atomically claims idempotency keys", async () => {
    const results = await Promise.all([
      database.idempotencyStore.claim({
        keyHash: "key-1",
        requestHash: "request-1",
        claimId: "claim-1",
        now: "2026-06-30T00:00:00.000Z",
        expiresAt: "2026-07-01T00:00:00.000Z",
      }),
      database.idempotencyStore.claim({
        keyHash: "key-1",
        requestHash: "request-1",
        claimId: "claim-2",
        now: "2026-06-30T00:00:00.000Z",
        expiresAt: "2026-07-01T00:00:00.000Z",
      }),
    ]);

    expect(results.map((result) => result.kind).sort()).toEqual(["acquired", "in_progress"]);
  });

  it("detects idempotency conflicts and replays completed responses", async () => {
    const claim = {
      keyHash: "key-1",
      requestHash: "request-1",
      claimId: "claim-1",
      now: "2026-06-30T00:00:00.000Z",
      expiresAt: "2026-07-01T00:00:00.000Z",
    };

    await expect(database.idempotencyStore.claim(claim)).resolves.toEqual({ kind: "acquired" });
    await expect(
      database.idempotencyStore.claim({ ...claim, requestHash: "request-2", claimId: "claim-2" }),
    ).resolves.toEqual({ kind: "conflict" });

    const response = successResponse({ id: "message-1" });
    await expect(
      database.idempotencyStore.complete({
        keyHash: claim.keyHash,
        requestHash: claim.requestHash,
        claimId: claim.claimId,
        response,
        expiresAt: "2026-07-01T00:01:00.000Z",
      }),
    ).resolves.toBe(true);
    await expect(database.idempotencyStore.claim({ ...claim, claimId: "claim-3" })).resolves.toEqual({
      kind: "completed",
      response,
    });
  });

  it("expires claims without allowing stale executions to complete their replacements", async () => {
    const oldClaim = {
      keyHash: "key-1",
      requestHash: "request-1",
      claimId: "claim-old",
      now: "2026-06-30T00:00:00.000Z",
      expiresAt: "2026-06-30T00:01:00.000Z",
    };

    await expect(database.idempotencyStore.claim(oldClaim)).resolves.toEqual({ kind: "acquired" });

    const newClaim = {
      ...oldClaim,
      claimId: "claim-new",
      now: oldClaim.expiresAt,
      expiresAt: "2026-07-01T00:01:00.000Z",
    };
    await expect(database.idempotencyStore.claim(newClaim)).resolves.toEqual({ kind: "acquired" });
    await expect(
      database.idempotencyStore.complete({
        keyHash: oldClaim.keyHash,
        requestHash: oldClaim.requestHash,
        claimId: oldClaim.claimId,
        response: successResponse({ source: "old" }),
        expiresAt: "2026-07-01T00:00:00.000Z",
      }),
    ).resolves.toBe(false);

    const response = successResponse({ source: "new" });
    await expect(
      database.idempotencyStore.complete({
        keyHash: newClaim.keyHash,
        requestHash: newClaim.requestHash,
        claimId: newClaim.claimId,
        response,
        expiresAt: "2026-07-01T00:01:00.000Z",
      }),
    ).resolves.toBe(true);
    await expect(database.idempotencyStore.claim(newClaim)).resolves.toEqual({ kind: "completed", response });
  });

  it("stores completed idempotency responses through the secret codec", async () => {
    const claim = {
      keyHash: "key-1",
      requestHash: "request-1",
      claimId: "claim-1",
      now: "2026-06-30T00:00:00.000Z",
      expiresAt: "2026-07-01T00:00:00.000Z",
    };
    const response = successResponse({ token: "provider-secret" });

    await database.idempotencyStore.claim(claim);
    await database.idempotencyStore.complete({
      keyHash: claim.keyHash,
      requestHash: claim.requestHash,
      claimId: claim.claimId,
      response,
      expiresAt: claim.expiresAt,
    });

    expect(
      await readStoredValue(pool, "idempotency_records", "key_hash", claim.keyHash, "response_value"),
    ).not.toContain("provider-secret");
    await expect(database.idempotencyStore.claim(claim)).resolves.toEqual({ kind: "completed", response });
  });

  it("keeps only the configured number of recent runs", async () => {
    const limited = new PostgresRuntimeDatabase(pool, { runLimit: 2 });
    await limited.runLogStore.add(createRun("run-1", "2026-06-30T00:00:00.000Z"));
    await limited.runLogStore.add(createRun("run-2", "2026-06-30T00:00:01.000Z"));
    await limited.runLogStore.add(createRun("run-3", "2026-06-30T00:00:02.000Z"));

    await expect(limited.runLogStore.list()).resolves.toMatchObject({
      items: [{ id: "run-3" }, { id: "run-2" }],
    });
  });

  it("paginates recent runs with a cursor", async () => {
    const limited = new PostgresRuntimeDatabase(pool, { runLimit: 4 });
    await limited.runLogStore.add(createRun("run-1", "2026-06-30T00:00:00.000Z"));
    await limited.runLogStore.add(createRun("run-2", "2026-06-30T00:00:01.000Z"));
    await limited.runLogStore.add(createRun("run-3", "2026-06-30T00:00:02.000Z"));

    const first = await limited.runLogStore.list({ limit: 2 });
    expect(first.items.map((run) => run.id)).toEqual(["run-3", "run-2"]);
    expect(first.nextCursor).toBeTruthy();

    const second = await limited.runLogStore.list({ limit: 2, cursor: first.nextCursor });
    expect(second.items.map((run) => run.id)).toEqual(["run-1"]);
    expect(second.nextCursor).toBeUndefined();
  });

  it("filters recent runs by service before paginating", async () => {
    await database.runLogStore.add(createRun("gmail-1", "2026-06-30T00:00:00.000Z", "mail.search_threads", "gmail"));
    await database.runLogStore.add(createRun("hackernews-1", "2026-06-30T00:00:01.000Z"));
    await database.runLogStore.add(createRun("gmail-2", "2026-06-30T00:00:02.000Z", "mail.list_threads", "gmail"));

    const first = await database.runLogStore.list({ service: "gmail", limit: 1 });
    expect(first.items.map((run) => run.id)).toEqual(["gmail-2"]);
    expect(first.nextCursor).toBeTruthy();

    const second = await database.runLogStore.list({ service: "gmail", limit: 1, cursor: first.nextCursor });
    expect(second.items.map((run) => run.id)).toEqual(["gmail-1"]);
    expect(second.nextCursor).toBeUndefined();
  });

  it("filters runs by action, caller, and status and reads one run by id", async () => {
    const match = {
      ...createRun("run-match", "2026-06-30T00:00:02.000Z", "gmail.send_message", "gmail"),
      caller: "mcp" as const,
      ok: false,
    };

    await database.runLogStore.add(createRun("run-other", "2026-06-30T00:00:01.000Z"));
    await database.runLogStore.add(match);

    await expect(
      database.runLogStore.list({ actionId: "gmail.send_message", caller: "mcp", ok: false }),
    ).resolves.toMatchObject({ items: [{ id: "run-match" }] });
    await expect(database.runLogStore.get("run-match")).resolves.toEqual(match);
    await expect(database.runLogStore.get("missing")).resolves.toBeUndefined();
  });
});

function createRun(id: string, startedAt: string, actionId = "hackernews.get_top_stories", service = "hackernews") {
  return {
    id,
    service,
    actionId,
    caller: "http" as const,
    startedAt,
    completedAt: startedAt,
    durationMs: 0,
    ok: true,
  };
}

function successResponse(data: unknown): RuntimeActionHttpResult {
  return {
    status: 200,
    body: {
      success: true,
      message: "OK",
      data,
      meta: {},
    },
  };
}

async function readStoredValue(
  pool: Pool,
  table: "connections" | "oauth_client_configs" | "oauth_states" | "idempotency_records",
  keyColumn: "service" | "state" | "key_hash",
  key: string,
  valueColumn: "value" | "response_value" = "value",
): Promise<string> {
  const result = await pool.query(`select ${valueColumn} from ${table} where ${keyColumn} = $1`, [key]);
  const value = result.rows[0]?.[valueColumn];
  return typeof value === "string" ? value : "";
}
