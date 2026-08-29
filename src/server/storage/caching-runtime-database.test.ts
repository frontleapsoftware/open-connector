import type { IConnectionStore, StoredConnection } from "../../connection-service.ts";
import type { ResolvedCredential } from "../../core/types.ts";
import type { IOAuthClientConfigStore, OAuthClientConfig } from "../../oauth/oauth-client-config-service.ts";
import type { IOAuthStateStore, OAuthAuthorizationState } from "../../oauth/oauth-flow-service.ts";
import type { CompleteIdempotencyInput, IdempotencyClaimInput, IIdempotencyStore } from "./idempotency-store.ts";
import type { RuntimeDatabase } from "./runtime-database.ts";
import type { IRuntimePolicyStore, RuntimePolicyRecord } from "./runtime-policy-store.ts";
import type { IRunLogStore, RunLog, RunLogListInput } from "./runtime-store.ts";
import type { IRuntimeTokenStore, RuntimeTokenRecord } from "./runtime-token-service.ts";

import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryPubSubBus } from "./cache-invalidation-bus.ts";
import { CachingRuntimeDatabase } from "./caching-runtime-database.ts";

describe("CachingRuntimeDatabase", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("serves connection get from cache after the first read", async () => {
    const inner = new FakeRuntimeDatabase();
    const connection: StoredConnection = {
      id: "c1",
      revision: "r1",
      service: "github",
      connectionName: "default",
      credential: { authType: "no_auth" },
    };
    await inner.connectionStore.set("github", "default", connection.credential);
    const getSpy = vi.spyOn(inner.connectionStore, "get");

    const database = new CachingRuntimeDatabase(inner, { bus: new MemoryPubSubBus() });
    await database.start();

    await expect(database.connectionStore.get("github", "default")).resolves.toMatchObject({
      service: "github",
      connectionName: "default",
    });
    await expect(database.connectionStore.get("github", "default")).resolves.toMatchObject({
      service: "github",
      connectionName: "default",
    });
    expect(getSpy).toHaveBeenCalledTimes(1);

    await database.close();
  });

  it("invalidates local cache on write", async () => {
    const inner = new FakeRuntimeDatabase();
    await inner.connectionStore.set("github", "default", { authType: "no_auth" });
    const getSpy = vi.spyOn(inner.connectionStore, "get");

    const database = new CachingRuntimeDatabase(inner, { bus: new MemoryPubSubBus() });
    await database.start();

    await database.connectionStore.get("github", "default");
    await database.connectionStore.set("github", "default", { authType: "no_auth" });
    await database.connectionStore.get("github", "default");

    expect(getSpy).toHaveBeenCalledTimes(2);
    await database.close();
  });

  it("invalidates a peer instance through a shared MemoryPubSubBus", async () => {
    const emitter = new EventEmitter();
    const busA = new MemoryPubSubBus(emitter);
    const busB = new MemoryPubSubBus(emitter);

    const shared = new FakeRuntimeDatabase();
    await shared.connectionStore.set("slack", "default", { authType: "no_auth" });

    const instanceA = new CachingRuntimeDatabase(shared, { bus: busA });
    const instanceB = new CachingRuntimeDatabase(shared, { bus: busB });
    await instanceA.start();
    await instanceB.start();

    const getSpy = vi.spyOn(shared.connectionStore, "get");

    await instanceA.connectionStore.get("slack", "default");
    await instanceB.connectionStore.get("slack", "default");
    expect(getSpy).toHaveBeenCalledTimes(2);

    // Warm both caches, then mutate on A; B should drop its cache entry.
    getSpy.mockClear();
    await instanceA.connectionStore.get("slack", "default");
    await instanceB.connectionStore.get("slack", "default");
    expect(getSpy).toHaveBeenCalledTimes(0);

    await instanceA.connectionStore.set("slack", "default", { authType: "no_auth" });
    // Allow the EventEmitter handler to run.
    await Promise.resolve();

    await instanceB.connectionStore.get("slack", "default");
    expect(getSpy).toHaveBeenCalledTimes(1);

    await instanceA.close();
    await instanceB.close();
  });

  it("caches runtime policy and token hash lookups", async () => {
    const inner = new FakeRuntimeDatabase();
    await inner.runtimePolicyStore.set({
      rules: { allowedActions: ["*"], blockedActions: [], allowedProxies: [], blockedProxies: [] },
      updatedAt: new Date().toISOString(),
    });
    const token: RuntimeTokenRecord = {
      id: "t1",
      name: "ci",
      tokenHash: "abc",
      allowedActions: [],
      blockedActions: [],
      allowedProxies: [],
      createdAt: new Date().toISOString(),
    };
    await inner.runtimeTokenStore.add(token);

    const policySpy = vi.spyOn(inner.runtimePolicyStore, "get");
    const hashSpy = vi.spyOn(inner.runtimeTokenStore, "findByHash");

    const database = new CachingRuntimeDatabase(inner, { bus: new MemoryPubSubBus() });
    await database.start();

    await database.runtimePolicyStore.get();
    await database.runtimePolicyStore.get();
    expect(policySpy).toHaveBeenCalledTimes(1);

    await database.runtimeTokenStore.findByHash("abc");
    await database.runtimeTokenStore.findByHash("abc");
    expect(hashSpy).toHaveBeenCalledTimes(1);

    await database.close();
  });

  it("passes oauth state, run logs, and idempotency through without caching", async () => {
    const inner = new FakeRuntimeDatabase();
    const database = new CachingRuntimeDatabase(inner, { bus: new MemoryPubSubBus() });

    expect(database.oauthStateStore).toBe(inner.oauthStateStore);
    expect(database.runLogStore).toBe(inner.runLogStore);
    expect(database.idempotencyStore).toBe(inner.idempotencyStore);

    await database.close();
  });
});

class FakeRuntimeDatabase implements RuntimeDatabase {
  readonly connectionStore = new FakeConnectionStore();
  readonly oauthClientConfigStore = new FakeOAuthClientConfigStore();
  readonly oauthStateStore = new FakeOAuthStateStore();
  readonly runtimeTokenStore = new FakeRuntimeTokenStore();
  readonly runtimePolicyStore = new FakeRuntimePolicyStore();
  readonly runLogStore = new FakeRunLogStore();
  readonly idempotencyStore = new FakeIdempotencyStore();
}

class FakeConnectionStore implements IConnectionStore {
  private readonly rows = new Map<string, StoredConnection>();

  async get(service: string, connectionName: string): Promise<StoredConnection | undefined> {
    return this.rows.get(`${service}:${connectionName}`);
  }

  async set(service: string, connectionName: string, credential: ResolvedCredential): Promise<StoredConnection> {
    const row: StoredConnection = {
      id: this.rows.get(`${service}:${connectionName}`)?.id ?? crypto.randomUUID(),
      revision: crypto.randomUUID(),
      service,
      connectionName,
      credential,
    };
    this.rows.set(`${service}:${connectionName}`, row);
    return row;
  }

  async updateCredential(input: StoredConnection): Promise<boolean> {
    const key = `${input.service}:${input.connectionName}`;
    if (!this.rows.has(key)) {
      return false;
    }
    this.rows.set(key, input);
    return true;
  }

  async delete(service: string, connectionName: string): Promise<void> {
    this.rows.delete(`${service}:${connectionName}`);
  }

  async list(): Promise<StoredConnection[]> {
    return [...this.rows.values()];
  }
}

class FakeOAuthClientConfigStore implements IOAuthClientConfigStore {
  private readonly rows = new Map<string, OAuthClientConfig>();

  async get(service: string): Promise<OAuthClientConfig | undefined> {
    return this.rows.get(service);
  }

  async set(config: OAuthClientConfig): Promise<void> {
    this.rows.set(config.service, config);
  }

  async delete(service: string): Promise<void> {
    this.rows.delete(service);
  }

  async list(): Promise<OAuthClientConfig[]> {
    return [...this.rows.values()];
  }
}

class FakeOAuthStateStore implements IOAuthStateStore {
  private readonly rows = new Map<string, OAuthAuthorizationState>();

  async set(state: OAuthAuthorizationState): Promise<void> {
    this.rows.set(state.state, state);
  }

  async take(state: string): Promise<OAuthAuthorizationState | undefined> {
    const value = this.rows.get(state);
    this.rows.delete(state);
    return value;
  }
}

class FakeRuntimeTokenStore implements IRuntimeTokenStore {
  private readonly rows = new Map<string, RuntimeTokenRecord>();

  async add(record: RuntimeTokenRecord): Promise<void> {
    this.rows.set(record.id, record);
  }

  async list(): Promise<RuntimeTokenRecord[]> {
    return [...this.rows.values()];
  }

  async findByHash(tokenHash: string): Promise<RuntimeTokenRecord | undefined> {
    return [...this.rows.values()].find((row) => row.tokenHash === tokenHash);
  }

  async updatePolicy(
    id: string,
    policy: { allowedActions: string[]; blockedActions: string[]; allowedProxies: string[] },
  ): Promise<RuntimeTokenRecord | undefined> {
    const existing = this.rows.get(id);
    if (!existing) {
      return undefined;
    }
    const next = { ...existing, ...policy };
    this.rows.set(id, next);
    return next;
  }

  async revoke(id: string): Promise<boolean> {
    return this.rows.delete(id);
  }

  async markUsed(id: string, usedAt: string): Promise<void> {
    const existing = this.rows.get(id);
    if (existing) {
      this.rows.set(id, { ...existing, lastUsedAt: usedAt });
    }
  }
}

class FakeRuntimePolicyStore implements IRuntimePolicyStore {
  private record: RuntimePolicyRecord | undefined;

  async get(): Promise<RuntimePolicyRecord | undefined> {
    return this.record;
  }

  async set(record: RuntimePolicyRecord): Promise<void> {
    this.record = record;
  }
}

class FakeRunLogStore implements IRunLogStore {
  async add(_run: RunLog): Promise<{ retentionApplied: boolean }> {
    return { retentionApplied: false };
  }

  async get(_id: string): Promise<RunLog | undefined> {
    return undefined;
  }

  async list(_input?: RunLogListInput): Promise<{ items: RunLog[]; nextCursor?: string }> {
    return { items: [] };
  }
}

class FakeIdempotencyStore implements IIdempotencyStore {
  async claim(_input: IdempotencyClaimInput): Promise<{ kind: "acquired" }> {
    return { kind: "acquired" };
  }

  async complete(_input: CompleteIdempotencyInput): Promise<boolean> {
    return true;
  }
}
