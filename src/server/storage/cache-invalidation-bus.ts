import type { RuntimeLogger } from "../../core/types.ts";

import { Redis } from "ioredis";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

export interface CacheInvalidationMessage {
  v: 1;
  origin: string;
  topics: string[];
}

export interface CacheInvalidationBus {
  readonly origin: string;
  publish(topics: string[]): Promise<void>;
  subscribe(handler: (message: CacheInvalidationMessage) => void): Promise<void>;
  close(): Promise<void>;
}

export interface RedisPubSubBusOptions {
  url: string;
  channel?: string;
  logger?: RuntimeLogger;
}

export interface CreateCacheInvalidationBusOptions {
  redisUrl?: string;
  channel?: string;
  logger?: RuntimeLogger;
}

const DEFAULT_CHANNEL = "oomol-connect:cache-invalidate";

/**
 * No-op bus used when Redis is not configured (single-process / local mode).
 */
export class NoopCacheInvalidationBus implements CacheInvalidationBus {
  readonly origin: string = randomUUID();

  async publish(_topics: string[]): Promise<void> {}

  async subscribe(_handler: (message: CacheInvalidationMessage) => void): Promise<void> {}

  async close(): Promise<void> {}
}

/**
 * In-process pub/sub for tests and single-process multi-decorator scenarios.
 */
export class MemoryPubSubBus implements CacheInvalidationBus {
  readonly origin: string = randomUUID();

  private readonly emitter: EventEmitter;
  private readonly channel: string;
  private listener: ((message: CacheInvalidationMessage) => void) | undefined;
  private closed = false;

  constructor(emitter?: EventEmitter, channel: string = DEFAULT_CHANNEL) {
    this.emitter = emitter ?? new EventEmitter();
    this.channel = channel;
  }

  async publish(topics: string[]): Promise<void> {
    if (this.closed || topics.length === 0) {
      return;
    }

    const message: CacheInvalidationMessage = {
      v: 1,
      origin: this.origin,
      topics: [...topics],
    };
    this.emitter.emit(this.channel, message);
  }

  async subscribe(handler: (message: CacheInvalidationMessage) => void): Promise<void> {
    if (this.closed || this.listener) {
      return;
    }

    this.listener = (message: CacheInvalidationMessage) => {
      if (message.origin === this.origin) {
        return;
      }
      handler(message);
    };
    this.emitter.on(this.channel, this.listener);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.listener) {
      this.emitter.off(this.channel, this.listener);
      this.listener = undefined;
    }
  }
}

/**
 * Redis pub/sub invalidation bus for multi-instance cache coherence.
 */
export class RedisPubSubBus implements CacheInvalidationBus {
  readonly origin: string = randomUUID();

  private readonly publisher: Redis;
  private readonly subscriber: Redis;
  private readonly channel: string;
  private readonly logger: RuntimeLogger | undefined;
  private subscribed = false;

  constructor(options: RedisPubSubBusOptions) {
    this.publisher = new Redis(options.url, { lazyConnect: true, maxRetriesPerRequest: null });
    this.subscriber = new Redis(options.url, { lazyConnect: true, maxRetriesPerRequest: null });
    this.channel = options.channel ?? DEFAULT_CHANNEL;
    this.logger = options.logger;
  }

  async publish(topics: string[]): Promise<void> {
    if (topics.length === 0) {
      return;
    }

    await this.ensurePublisher();
    const message: CacheInvalidationMessage = {
      v: 1,
      origin: this.origin,
      topics: [...topics],
    };
    await this.publisher.publish(this.channel, JSON.stringify(message));
  }

  async subscribe(handler: (message: CacheInvalidationMessage) => void): Promise<void> {
    if (this.subscribed) {
      return;
    }

    this.subscribed = true;
    await this.ensureSubscriber();
    this.subscriber.on("message", (channel: string, payload: string) => {
      if (channel !== this.channel) {
        return;
      }

      const message = parseCacheInvalidationMessage(payload);
      if (!message) {
        this.logger?.warn({ channel, payload }, "ignored invalid cache invalidation payload");
        return;
      }
      if (message.origin === this.origin) {
        return;
      }

      handler(message);
    });
    await this.subscriber.subscribe(this.channel);
  }

  async close(): Promise<void> {
    await Promise.all([quitRedis(this.publisher), quitRedis(this.subscriber)]);
  }

  private async ensurePublisher(): Promise<void> {
    if (this.publisher.status === "wait") {
      await this.publisher.connect();
    }
  }

  private async ensureSubscriber(): Promise<void> {
    if (this.subscriber.status === "wait") {
      await this.subscriber.connect();
    }
  }
}

/**
 * Create a cache invalidation bus. Uses Redis when `redisUrl` is set; otherwise a no-op bus.
 */
export async function createCacheInvalidationBus(
  options: CreateCacheInvalidationBusOptions = {},
): Promise<CacheInvalidationBus> {
  if (options.redisUrl) {
    return new RedisPubSubBus({
      url: options.redisUrl,
      channel: options.channel,
      logger: options.logger,
    });
  }

  return new NoopCacheInvalidationBus();
}

function parseCacheInvalidationMessage(payload: string): CacheInvalidationMessage | undefined {
  try {
    const parsed = JSON.parse(payload) as Partial<CacheInvalidationMessage>;
    if (parsed.v !== 1 || typeof parsed.origin !== "string" || !Array.isArray(parsed.topics)) {
      return undefined;
    }
    if (!parsed.topics.every((topic) => typeof topic === "string")) {
      return undefined;
    }
    return {
      v: 1,
      origin: parsed.origin,
      topics: parsed.topics,
    };
  } catch {
    return undefined;
  }
}

async function quitRedis(client: Redis): Promise<void> {
  try {
    if (client.status !== "end" && client.status !== "close") {
      await client.quit();
    }
  } catch {
    client.disconnect();
  }
}
