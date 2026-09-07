import type { IConnectionStore, StoredConnection } from "../../connection-service.ts";
import type { TokenPolicy } from "../../core/action-policy.ts";
import type { ResolvedCredential, RuntimeLogger } from "../../core/types.ts";
import type { IMarketplaceStore } from "../../marketplace/marketplace-service.ts";
import type { IOAuthClientConfigStore, OAuthClientConfig } from "../../oauth/oauth-client-config-service.ts";
import type { CacheInvalidationBus } from "./cache-invalidation-bus.ts";
import type { IIdempotencyStore } from "./idempotency-store.ts";
import type { RuntimeDatabase } from "./runtime-database.ts";
import type { IRuntimePolicyStore, RuntimePolicyRecord } from "./runtime-policy-store.ts";
import type { IRunLogStore } from "./runtime-store.ts";
import type { IRuntimeTokenStore, RuntimeTokenRecord } from "./runtime-token-service.ts";

const DEFAULT_TTL_MS = 30_000;

export interface CachingRuntimeDatabaseOptions {
  bus: CacheInvalidationBus;
  ttlMs?: number;
  logger?: RuntimeLogger;
}

interface CacheEntry<T> {
  value: T;
}

/**
 * Simple in-memory TTL map used by {@link CachingRuntimeDatabase} and tests.
 */
export class MemoryTtlCache {
  private readonly entries = new Map<string, { value: unknown; expiresAt: number }>();
  private readonly ttlMs: number;

  constructor(ttlMs: number = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  get<T>(key: string): T | undefined {
    const entry = this.getEntry<T>(key);
    return entry?.value;
  }

  has(key: string): boolean {
    return this.getEntry(key) !== undefined;
  }

  /**
   * Read a cache entry that may intentionally hold `undefined` (negative cache).
   */
  getEntry<T>(key: string): CacheEntry<T> | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }
    if (Date.now() >= entry.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value as CacheEntry<T>;
  }

  set(key: string, value: unknown): void {
    this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  setEntry<T>(key: string, value: T): void {
    this.set(key, { value } satisfies CacheEntry<T>);
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  deleteWhere(predicate: (key: string) => boolean): void {
    for (const key of [...this.entries.keys()]) {
      if (predicate(key)) {
        this.entries.delete(key);
      }
    }
  }

  keys(): string[] {
    return [...this.entries.keys()];
  }
}

/**
 * Runtime database decorator that caches hot read paths and invalidates via a pub/sub bus.
 */
export class CachingRuntimeDatabase implements RuntimeDatabase {
  readonly connectionStore: IConnectionStore;
  readonly oauthClientConfigStore: IOAuthClientConfigStore;
  readonly oauthStateStore: RuntimeDatabase["oauthStateStore"];
  readonly runtimeTokenStore: IRuntimeTokenStore;
  readonly runtimePolicyStore: IRuntimePolicyStore;
  readonly runLogStore: IRunLogStore;
  readonly idempotencyStore: IIdempotencyStore;
  readonly marketplaceStore: IMarketplaceStore;

  private readonly inner: RuntimeDatabase;
  private readonly bus: CacheInvalidationBus;
  private readonly cache: MemoryTtlCache;
  private readonly logger: RuntimeLogger | undefined;

  constructor(inner: RuntimeDatabase, options: CachingRuntimeDatabaseOptions) {
    this.inner = inner;
    this.bus = options.bus;
    this.cache = new MemoryTtlCache(options.ttlMs ?? DEFAULT_TTL_MS);
    this.logger = options.logger;

    this.connectionStore = new CachingConnectionStore(inner.connectionStore, this.cache, (topics) =>
      this.publishTopics(topics),
    );
    this.oauthClientConfigStore = new CachingOAuthClientConfigStore(
      inner.oauthClientConfigStore,
      this.cache,
      (topics) => this.publishTopics(topics),
    );
    this.oauthStateStore = inner.oauthStateStore;
    this.runtimeTokenStore = new CachingRuntimeTokenStore(inner.runtimeTokenStore, this.cache, (topics) =>
      this.publishTopics(topics),
    );
    this.runtimePolicyStore = new CachingRuntimePolicyStore(inner.runtimePolicyStore, this.cache, (topics) =>
      this.publishTopics(topics),
    );
    this.runLogStore = inner.runLogStore;
    this.idempotencyStore = inner.idempotencyStore;
    // Marketplace config changes are rare; pass through so reads stay coherent with the durable store.
    this.marketplaceStore = inner.marketplaceStore;
  }

  async start(): Promise<void> {
    await this.bus.subscribe((message) => {
      this.applyInvalidation(message.topics);
    });
  }

  async close(): Promise<void> {
    await this.bus.close();
    const innerClose = (this.inner as { close?: () => void | Promise<void> }).close;
    if (typeof innerClose === "function") {
      await innerClose.call(this.inner);
    }
  }

  private async publishTopics(topics: string[]): Promise<void> {
    if (topics.length === 0) {
      return;
    }
    this.applyInvalidation(topics);
    try {
      await this.bus.publish(topics);
    } catch (error) {
      this.logger?.warn({ err: error, topics }, "cache invalidation publish failed");
    }
  }

  private applyInvalidation(topics: string[]): void {
    for (const topic of topics) {
      if (topic === "*") {
        this.cache.clear();
        return;
      }
      this.cache.delete(topic);
    }
  }
}

type PublishTopics = (topics: string[]) => Promise<void>;

class CachingConnectionStore implements IConnectionStore {
  private readonly inner: IConnectionStore;
  private readonly cache: MemoryTtlCache;
  private readonly publish: PublishTopics;

  constructor(inner: IConnectionStore, cache: MemoryTtlCache, publish: PublishTopics) {
    this.inner = inner;
    this.cache = cache;
    this.publish = publish;
  }

  async get(service: string, connectionName: string): Promise<StoredConnection | undefined> {
    const key = connectionKey(service, connectionName);
    const cached = this.cache.getEntry<StoredConnection | undefined>(key);
    if (cached) {
      return cached.value;
    }

    const value = await this.inner.get(service, connectionName);
    this.cache.setEntry(key, value);
    return value;
  }

  async set(service: string, connectionName: string, credential: ResolvedCredential): Promise<StoredConnection> {
    const value = await this.inner.set(service, connectionName, credential);
    await this.publish([connectionKey(service, connectionName), "connections:list"]);
    return value;
  }

  async updateCredential(input: StoredConnection): Promise<boolean> {
    const updated = await this.inner.updateCredential(input);
    await this.publish([connectionKey(input.service, input.connectionName), "connections:list"]);
    return updated;
  }

  async delete(service: string, connectionName: string): Promise<void> {
    await this.inner.delete(service, connectionName);
    await this.publish([connectionKey(service, connectionName), "connections:list"]);
  }

  async list(): Promise<StoredConnection[]> {
    const cached = this.cache.getEntry<StoredConnection[]>("connections:list");
    if (cached) {
      return cached.value;
    }

    const value = await this.inner.list();
    this.cache.setEntry("connections:list", value);
    return value;
  }
}

class CachingOAuthClientConfigStore implements IOAuthClientConfigStore {
  private readonly inner: IOAuthClientConfigStore;
  private readonly cache: MemoryTtlCache;
  private readonly publish: PublishTopics;

  constructor(inner: IOAuthClientConfigStore, cache: MemoryTtlCache, publish: PublishTopics) {
    this.inner = inner;
    this.cache = cache;
    this.publish = publish;
  }

  async get(service: string): Promise<OAuthClientConfig | undefined> {
    const key = oauthClientKey(service);
    const cached = this.cache.getEntry<OAuthClientConfig | undefined>(key);
    if (cached) {
      return cached.value;
    }

    const value = await this.inner.get(service);
    this.cache.setEntry(key, value);
    return value;
  }

  async set(config: OAuthClientConfig): Promise<void> {
    await this.inner.set(config);
    await this.publish([oauthClientKey(config.service), "oauth_clients:list"]);
  }

  async delete(service: string): Promise<void> {
    await this.inner.delete(service);
    await this.publish([oauthClientKey(service), "oauth_clients:list"]);
  }

  async list(): Promise<OAuthClientConfig[]> {
    const cached = this.cache.getEntry<OAuthClientConfig[]>("oauth_clients:list");
    if (cached) {
      return cached.value;
    }

    const value = await this.inner.list();
    this.cache.setEntry("oauth_clients:list", value);
    return value;
  }
}

class CachingRuntimeTokenStore implements IRuntimeTokenStore {
  private readonly inner: IRuntimeTokenStore;
  private readonly cache: MemoryTtlCache;
  private readonly publish: PublishTopics;

  constructor(inner: IRuntimeTokenStore, cache: MemoryTtlCache, publish: PublishTopics) {
    this.inner = inner;
    this.cache = cache;
    this.publish = publish;
  }

  async add(record: RuntimeTokenRecord): Promise<void> {
    await this.inner.add(record);
    await this.publish([tokenHashKey(record.tokenHash), "tokens:list"]);
  }

  async list(): Promise<RuntimeTokenRecord[]> {
    const cached = this.cache.getEntry<RuntimeTokenRecord[]>("tokens:list");
    if (cached) {
      return cached.value;
    }

    const value = await this.inner.list();
    this.cache.setEntry("tokens:list", value);
    return value;
  }

  async findByHash(tokenHash: string): Promise<RuntimeTokenRecord | undefined> {
    const key = tokenHashKey(tokenHash);
    const cached = this.cache.getEntry<RuntimeTokenRecord | undefined>(key);
    if (cached) {
      return cached.value;
    }

    const value = await this.inner.findByHash(tokenHash);
    this.cache.setEntry(key, value);
    return value;
  }

  async updatePolicy(id: string, policy: TokenPolicy): Promise<RuntimeTokenRecord | undefined> {
    const value = await this.inner.updatePolicy(id, policy);
    const topics = ["tokens:list"];
    if (value) {
      topics.push(tokenHashKey(value.tokenHash));
    } else {
      topics.push(...this.tokenHashTopicsForId(id));
    }
    await this.publish(topics);
    return value;
  }

  async revoke(id: string): Promise<boolean> {
    const hashTopics = this.tokenHashTopicsForId(id);
    const revoked = await this.inner.revoke(id);
    await this.publish(["tokens:list", ...hashTopics]);
    return revoked;
  }

  async markUsed(id: string, usedAt: string): Promise<void> {
    await this.inner.markUsed(id, usedAt);
    await this.publish(["tokens:list", ...this.tokenHashTopicsForId(id)]);
  }

  private tokenHashTopicsForId(id: string): string[] {
    const topics: string[] = [];
    for (const key of this.cache.keys()) {
      if (!key.startsWith("token_hash:")) {
        continue;
      }
      const entry = this.cache.getEntry<RuntimeTokenRecord | undefined>(key);
      if (entry?.value?.id === id) {
        topics.push(key);
      }
    }
    return topics;
  }
}

class CachingRuntimePolicyStore implements IRuntimePolicyStore {
  private readonly inner: IRuntimePolicyStore;
  private readonly cache: MemoryTtlCache;
  private readonly publish: PublishTopics;

  constructor(inner: IRuntimePolicyStore, cache: MemoryTtlCache, publish: PublishTopics) {
    this.inner = inner;
    this.cache = cache;
    this.publish = publish;
  }

  async get(): Promise<RuntimePolicyRecord | undefined> {
    const cached = this.cache.getEntry<RuntimePolicyRecord | undefined>("runtime_policy");
    if (cached) {
      return cached.value;
    }

    const value = await this.inner.get();
    this.cache.setEntry("runtime_policy", value);
    return value;
  }

  async set(record: RuntimePolicyRecord): Promise<void> {
    await this.inner.set(record);
    await this.publish(["runtime_policy"]);
  }
}

function connectionKey(service: string, connectionName: string): string {
  return `connection:${service}:${connectionName}`;
}

function oauthClientKey(service: string): string {
  return `oauth_client:${service}`;
}

function tokenHashKey(hash: string): string {
  return `token_hash:${hash}`;
}
