import { type Context } from "@deepseek-ai/cordis";
import type { SessionEvent, SessionHeader, SessionId, SessionPreparation } from "@deepseek-ai/dsh-session";
import {
  DEFAULT_PREPARED_SESSION_CACHE_SIZE,
  DEFAULT_WRITE_BATCH_MAX_DELAY_MS,
  PersistenceCoordinator,
  SessionPersistence,
  type PersistenceBackend,
  type SessionInspection,
  type SessionLocation,
  type SessionPersistenceSnapshot,
  type StoredPrefix,
} from "@deepseek-ai/dsh-session-persistence";
import { parseConfig, type PluginConfig } from "./config.js";
import {
  S3PersistenceBackend,
  type S3PersistenceBackendOptions,
  type S3TornMarker,
} from "./backend.js";
import type { CasStore } from "./cas.js";

export interface S3SessionPersistenceOptions extends S3PersistenceBackendOptions {
  bucket?: CasStore;
}

/**
 * First-party-shaped S3 backend: extends the official SessionPersistence
 * service and implements PersistenceBackend, then hands orchestration to
 * PersistenceCoordinator — the same composition as dsh-session-persistence-jsonl.
 */
export class S3SessionPersistence
  extends SessionPersistence
  implements PersistenceBackend<S3TornMarker>
{
  static inject = ["sessions"];
  readonly supportsRawArtifacts = true;

  private readonly storage: S3PersistenceBackend;
  private readonly coordinator: PersistenceCoordinator<S3TornMarker>;

  constructor(ctx: Context, config: PluginConfig, opts?: S3SessionPersistenceOptions) {
    super(ctx);
    const resolved = parseConfig(config);
    this.storage = opts?.bucket
      ? S3PersistenceBackend.fromMemory(resolved, opts.bucket, opts.cas)
      : new S3PersistenceBackend(resolved, opts);
    this.coordinator = new PersistenceCoordinator<S3TornMarker>(this.ctx, this, {
      preparedSessionCacheSize:
        resolved.preparedSessionCacheSize ?? DEFAULT_PREPARED_SESSION_CACHE_SIZE,
      writeBatchMaxDelayMs: resolved.writeBatchMaxDelayMs ?? DEFAULT_WRITE_BATCH_MAX_DELAY_MS,
    });
  }

  locate(meta: SessionHeader): SessionLocation {
    return this.storage.locate(meta);
  }

  create(meta: SessionHeader): Promise<void> {
    return this.coordinator.create(meta);
  }

  append(id: SessionId, events: readonly SessionEvent[]): Promise<void> {
    return this.coordinator.append(id, events);
  }

  override prepare(id: SessionId, signal?: AbortSignal): Promise<SessionPreparation> {
    return this.coordinator.prepare(id, signal);
  }

  load(id: SessionId): Promise<SessionInspection> {
    return this.coordinator.load(id);
  }

  inspect(id: SessionId, signal?: AbortSignal): Promise<SessionInspection> {
    return this.coordinator.inspect(id, signal);
  }

  readFrom(
    id: SessionId,
    fromSeq: number,
    signal?: AbortSignal,
  ): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    return this.coordinator.readFrom(id, fromSeq, signal);
  }

  list(signal?: AbortSignal): Promise<SessionHeader[]> {
    return this.storage.list(signal);
  }

  listSnapshots(signal?: AbortSignal): Promise<SessionPersistenceSnapshot[]> {
    return this.storage.listSnapshots(signal);
  }

  loadStored(
    id: SessionId,
    signal?: AbortSignal,
  ): Promise<StoredPrefix<S3TornMarker> | undefined> {
    return this.storage.loadStored(id, signal);
  }

  readStoredRevision(id: SessionId, signal?: AbortSignal) {
    return this.storage.readStoredRevision(id, signal);
  }

  appendBatch(
    meta: SessionHeader,
    events: readonly SessionEvent[],
    isMaterialized: boolean,
  ): Promise<void> {
    return this.storage.appendBatch(meta, events, isMaterialized);
  }

  commitRepair(
    meta: SessionHeader,
    tornMarker: S3TornMarker | undefined,
    closers: readonly SessionEvent[],
  ): Promise<void> {
    return this.storage.commitRepair(meta, tornMarker, closers);
  }

  readRaw(id: SessionId, signal?: AbortSignal) {
    return this.storage.readRaw(id, signal);
  }
}

export default S3SessionPersistence;
