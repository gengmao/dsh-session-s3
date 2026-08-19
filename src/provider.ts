import { parseConfig, type PluginConfig, type ResolvedPluginConfig } from "./config.js";
import type { CasStore } from "./cas.js";
import { S3LogError } from "./errors.js";
import { createS3CasStore, createS3Client, S3SessionLog } from "./s3log.js";
import type { S3Client } from "@aws-sdk/client-s3";

export type SessionEvent = Record<string, unknown>;

export interface SessionPersistenceProvider {
  load(sessionId: string): Promise<void>;
  append(sessionId: string, event: SessionEvent): Promise<void>;
  read(sessionId: string): Promise<SessionEvent[]>;
  compact(sessionId: string, keepLastN?: number): Promise<void>;
  close(sessionId: string): Promise<void>;
}

export interface CreateProviderOptions {
  createStore?: (sessionId: string) => CasStore;
  client?: S3Client;
}

const DEFAULT_COMPACT_KEEP = 10;

export function createProvider(
  config: PluginConfig | unknown,
  opts?: CreateProviderOptions,
): SessionPersistenceProvider {
  const resolved = parseConfig(config);
  return new S3SessionPersistenceProvider(resolved, opts);
}

class S3SessionPersistenceProvider implements SessionPersistenceProvider {
  private readonly logs = new Map<string, S3SessionLog>();
  private readonly client?: S3Client;

  constructor(
    private readonly config: ResolvedPluginConfig,
    private readonly opts?: CreateProviderOptions,
  ) {
    this.client = opts?.client ?? (opts?.createStore ? undefined : createS3Client(config));
  }

  async load(sessionId: string): Promise<void> {
    await this.ensure(sessionId);
  }

  async append(sessionId: string, event: SessionEvent): Promise<void> {
    const log = await this.ensure(sessionId);
    log.append(event);
    if (log.shouldFlush()) await log.flush();
  }

  async read(sessionId: string): Promise<SessionEvent[]> {
    const log = await this.ensure(sessionId);
    const durable = await log.readAll();
    return [...durable, ...log.pending] as SessionEvent[];
  }

  async compact(sessionId: string, keepLastN = DEFAULT_COMPACT_KEEP): Promise<void> {
    const log = await this.ensure(sessionId);
    await log.trim(keepLastN);
  }

  async close(sessionId: string): Promise<void> {
    const log = this.logs.get(sessionId);
    if (!log) return;
    await log.close();
    this.logs.delete(sessionId);
  }

  private storeFor(sessionId: string): CasStore {
    if (this.opts?.createStore) return this.opts.createStore(sessionId);
    if (!sessionId) {
      throw new S3LogError("sessionId is required", "CONFIG");
    }
    return createS3CasStore(this.config, sessionId, this.client);
  }

  private async ensure(sessionId: string): Promise<S3SessionLog> {
    const cached = this.logs.get(sessionId);
    if (cached) return cached;
    const log = await S3SessionLog.open(this.storeFor(sessionId), sessionId, {
      flushThresholdEvents: this.config.flushThresholdEvents,
      flushThresholdBytes: this.config.flushThresholdBytes,
    });
    this.logs.set(sessionId, log);
    return log;
  }
}
