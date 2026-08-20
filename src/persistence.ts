import { Service, type Context } from "@deepseek-ai/cordis";
import { parseConfig, type PluginConfig, type ResolvedPluginConfig } from "./config.js";
import {
  S3PersistenceBackend,
  type PersistEvent,
  type PersistHeader,
  type SessionLocation,
  type SessionSnapshot,
  type S3PersistenceBackendOptions,
} from "./backend.js";
import type { CasStore } from "./cas.js";

export interface SessionInspection {
  readonly meta: PersistHeader;
  readonly events: readonly PersistEvent[];
}

export interface PersistenceContext {
  on?(event: string, listener: (...args: unknown[]) => unknown): unknown;
  effect?(callback: () => unknown, name?: string): unknown;
  get?(name: string): unknown;
  sessions?: {
    get?(id: string): LiveSession | undefined;
    list?(): LiveSession[];
    prepare?(id: string, opts: unknown): unknown;
  };
  logger?: { warn?(message: string): void };
}

export interface LiveSession {
  id: string;
  header: PersistHeader;
  events: readonly PersistEvent[];
}

interface SessionState {
  meta: PersistHeader;
  cursor: number;
  materialized: boolean;
}

export interface S3SessionRuntimeOptions extends S3PersistenceBackendOptions {
  ctx?: PersistenceContext;
  bucket?: CasStore;
}

function snapshotJson<T>(value: T, label: string): T {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch (cause) {
    throw new TypeError(`${label} is not losslessly JSON-serializable`, { cause });
  }
  if (typeof json !== "string") {
    throw new TypeError(`${label} is not losslessly JSON-serializable`);
  }
  return JSON.parse(json) as T;
}

function asEvents(events: readonly unknown[]): PersistEvent[] {
  return events.map((event, index) => {
    if (typeof event !== "object" || event === null) {
      throw new TypeError(`session event at index ${index} is not an object`);
    }
    const rec = event as PersistEvent;
    if (!Number.isSafeInteger(rec.seq) || rec.seq < 0) {
      throw new TypeError(`session event at index ${index} is missing a non-negative seq`);
    }
    if (typeof rec.type !== "string" || rec.type.length === 0) {
      throw new TypeError(`session event at index ${index} is missing type`);
    }
    return rec;
  });
}

/**
 * Upstream SessionPersistence surface, minus Cordis Service registration.
 * Tests and the Service wrapper both drive this.
 */
export class S3SessionRuntime {
  readonly supportsRawArtifacts = true;
  readonly name = "session-persistence-s3";
  private readonly states = new Map<string, SessionState>();
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly liveBuffers = new Map<string, PersistEvent[]>();
  private readonly ctx?: PersistenceContext;

  constructor(
    readonly backend: S3PersistenceBackend,
    ctx?: PersistenceContext,
  ) {
    this.ctx = ctx;
  }

  static create(
    config: PluginConfig | unknown,
    opts?: S3SessionRuntimeOptions,
  ): S3SessionRuntime {
    const resolved = parseConfig(config);
    const backend = opts?.bucket
      ? S3PersistenceBackend.fromMemory(resolved, opts.bucket, opts.cas)
      : new S3PersistenceBackend(resolved, opts);
    const runtime = new S3SessionRuntime(backend, opts?.ctx);
    if (opts?.ctx) runtime.installWritePath();
    return runtime;
  }

  locate(meta: PersistHeader): SessionLocation {
    return this.backend.locate(meta);
  }

  create(meta: PersistHeader): Promise<void> {
    const snapshot = snapshotJson(meta, "session metadata");
    if (!Number.isSafeInteger(snapshot.createdAt) || snapshot.createdAt < 0) {
      return Promise.reject(new TypeError("session metadata createdAt must be a non-negative safe integer"));
    }
    return this.serialize(snapshot.id, () => this.createCore(snapshot));
  }

  async append(id: string, events: readonly PersistEvent[]): Promise<void> {
    const batch = asEvents(snapshotJson(events, "session event batch"));
    return this.serialize(id, () => this.appendCore(id, batch));
  }

  load(id: string, signal?: AbortSignal): Promise<SessionInspection> {
    return this.serialize(id, () => this.loadCore(id, true, signal));
  }

  inspect(id: string, signal?: AbortSignal): Promise<SessionInspection> {
    const live = this.ctx?.sessions?.get?.(id) ?? this.liveFromCtx(id);
    if (live) {
      return Promise.resolve(
        Object.freeze({ meta: live.header, events: live.events }),
      );
    }
    return this.serialize(id, () => this.loadCore(id, false, signal));
  }

  async readFrom(
    id: string,
    fromSeq: number,
    signal?: AbortSignal,
  ): Promise<{ meta: PersistHeader; events: PersistEvent[] }> {
    if (!Number.isSafeInteger(fromSeq) || fromSeq < 0) {
      throw new TypeError(`readFrom fromSeq must be a non-negative safe integer, got ${String(fromSeq)}`);
    }
    const whole = await this.serialize(id, () => this.loadCore(id, false, signal));
    return {
      meta: whole.meta,
      events: whole.events.filter((event) => event.seq >= fromSeq),
    };
  }

  list(signal?: AbortSignal): Promise<PersistHeader[]> {
    return this.backend.list(signal);
  }

  listSnapshots(signal?: AbortSignal): Promise<SessionSnapshot[]> {
    return this.backend.listSnapshots(signal);
  }

  async prepare(id: string, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    const loaded = await this.load(id, signal);
    signal?.throwIfAborted();
    const sessions =
      (this.ctx?.get?.("sessions") as PersistenceContext["sessions"] | undefined) ??
      this.ctx?.sessions;
    if (sessions?.prepare === undefined) {
      throw new Error("cannot prepare a session: SessionStore is not configured");
    }
    return sessions.prepare(id, {
      seed: loaded.events.map((event) => structuredClone(event)),
      meta: structuredClone(loaded.meta),
      seedSource: "persistence",
    });
  }

  readRaw(id: string, signal?: AbortSignal) {
    return this.backend.readRaw(id, signal);
  }

  installWritePath(): void {
    const ctx = this.ctx;
    if (!ctx?.on) return;
    ctx.on("session/created", (session) => {
      void this.onCreated(session as LiveSession);
    });
    ctx.on("session/event", (session, event) => {
      this.enqueue(session as LiveSession, event as PersistEvent);
    });
    ctx.on("session/flush", (session) => this.flushLive(session as LiveSession));
    ctx.on("session/disposed", (session) => {
      void this.flushLive(session as LiveSession);
    });
    ctx.effect?.(() => async () => {
      const ids = [...this.liveBuffers.keys()];
      await Promise.all(ids.map((id) => this.flushId(id)));
    }, "session-persistence-s3 write path");
  }

  private liveFromCtx(id: string): LiveSession | undefined {
    const sessions =
      (this.ctx?.get?.("sessions") as PersistenceContext["sessions"] | undefined) ??
      this.ctx?.sessions;
    return sessions?.get?.(id);
  }

  private enqueue(session: LiveSession, event: PersistEvent): void {
    const id = session.header?.id ?? session.id;
    const buf = this.liveBuffers.get(id) ?? [];
    buf.push(event);
    this.liveBuffers.set(id, buf);
  }

  private async flushLive(session: LiveSession): Promise<void> {
    const id = session.header?.id ?? session.id;
    await this.flushId(id);
  }

  private async flushId(id: string): Promise<void> {
    const buf = this.liveBuffers.get(id);
    if (!buf || buf.length === 0) return;
    this.liveBuffers.set(id, []);
    await this.append(id, buf);
  }

  private async onCreated(session: LiveSession): Promise<void> {
    const id = session.header.id;
    const seed = asEvents(snapshotJson(session.events ?? [], "session seed"));
    await this.serialize(id, () => this.onCreatedCore(session.header, seed));
  }

  private async onCreatedCore(meta: PersistHeader, seed: PersistEvent[]): Promise<void> {
    const id = meta.id;
    const stored = await this.backend.loadStored(id);
    if (stored) {
      this.states.set(id, {
        meta: stored.meta,
        cursor: stored.events.length,
        materialized: true,
      });
      const suffix = seed.filter((event) => event.seq >= stored.events.length);
      if (suffix.length > 0) await this.appendCore(id, suffix);
      return;
    }
    await this.createCore(meta);
    if (seed.length > 0) await this.appendCore(id, seed);
  }

  private async createCore(meta: PersistHeader): Promise<void> {
    if (this.states.has(meta.id)) {
      throw new Error(`session "${meta.id}" already exists in this backend`);
    }
    if ((await this.backend.loadStored(meta.id)) !== undefined) {
      throw new Error(
        `session "${meta.id}" already has a persisted log; load/resume it instead of creating`,
      );
    }
    this.states.set(meta.id, { meta, cursor: 0, materialized: false });
  }

  private async appendCore(id: string, events: readonly PersistEvent[]): Promise<void> {
    if (events.length === 0) return;
    let state = this.states.get(id);
    if (state === undefined) state = await this.adopt(id);
    for (const [i, event] of events.entries()) {
      if (event.seq !== state.cursor + i) {
        throw new Error(
          `append seq mismatch for "${id}": expected ${state.cursor + i} at index ${i}, got ${event.seq}`,
        );
      }
    }
    await this.backend.appendBatch(state.meta, events, state.materialized);
    state.materialized = true;
    state.cursor += events.length;
  }

  private async adopt(id: string): Promise<SessionState> {
    const stored = await this.backend.loadStored(id);
    if (stored === undefined) {
      throw new Error(`session "${id}" not found`);
    }
    if (stored.tornMarker) {
      await this.backend.commitRepair(stored.meta, stored.tornMarker, []);
    }
    const state: SessionState = {
      meta: stored.meta,
      cursor: stored.events.length,
      materialized: true,
    };
    this.states.set(id, state);
    return state;
  }

  private async loadCore(
    id: string,
    commitRepair: boolean,
    signal?: AbortSignal,
  ): Promise<SessionInspection> {
    signal?.throwIfAborted();
    const stored = await this.backend.loadStored(id, signal);
    signal?.throwIfAborted();
    if (stored === undefined) throw new Error(`session "${id}" not found`);
    if (commitRepair && stored.tornMarker) {
      await this.backend.commitRepair(stored.meta, stored.tornMarker, []);
    }
    const state: SessionState = {
      meta: stored.meta,
      cursor: stored.events.length,
      materialized: true,
    };
    this.states.set(id, state);
    return Object.freeze({
      meta: stored.meta,
      events: Object.freeze(stored.events),
    });
  }

  private serialize<T>(id: string, op: () => Promise<T>): Promise<T> {
    const prior = this.chains.get(id) ?? Promise.resolve();
    const next = prior.then(op, op);
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(id, tail);
    void tail.then(() => {
      if (this.chains.get(id) === tail) this.chains.delete(id);
    });
    return next;
  }
}

/**
 * Cordis plugin: registers as `ctx.sessionPersistence`, replacing JSONL when
 * the profile `sessions` row is patched to `dsh-session-s3`.
 */
export class S3SessionPersistence extends Service {
  static inject = ["sessions"];
  readonly supportsRawArtifacts = true;
  readonly backendName = "session-persistence-s3";
  private readonly runtime: S3SessionRuntime;

  constructor(ctx: Context, config: PluginConfig, opts?: S3SessionRuntimeOptions) {
    super(ctx, "sessionPersistence");
    const resolved: ResolvedPluginConfig = parseConfig(config);
    const backend = opts?.bucket
      ? S3PersistenceBackend.fromMemory(resolved, opts.bucket, opts.cas)
      : new S3PersistenceBackend(resolved, opts);
    this.runtime = new S3SessionRuntime(backend, ctx);
    this.runtime.installWritePath();
  }

  locate(meta: PersistHeader): SessionLocation {
    return this.runtime.locate(meta);
  }

  create(meta: PersistHeader): Promise<void> {
    return this.runtime.create(meta);
  }

  append(id: string, events: readonly PersistEvent[]): Promise<void> {
    return this.runtime.append(id, events);
  }

  load(id: string): Promise<SessionInspection> {
    return this.runtime.load(id);
  }

  inspect(id: string, signal?: AbortSignal): Promise<SessionInspection> {
    return this.runtime.inspect(id, signal);
  }

  readFrom(
    id: string,
    fromSeq: number,
    signal?: AbortSignal,
  ): Promise<{ meta: PersistHeader; events: PersistEvent[] }> {
    return this.runtime.readFrom(id, fromSeq, signal);
  }

  list(signal?: AbortSignal): Promise<PersistHeader[]> {
    return this.runtime.list(signal);
  }

  listSnapshots(signal?: AbortSignal): Promise<SessionSnapshot[]> {
    return this.runtime.listSnapshots(signal);
  }

  prepare(id: string, signal?: AbortSignal): Promise<unknown> {
    return this.runtime.prepare(id, signal);
  }

  readRaw(id: string, signal?: AbortSignal) {
    return this.runtime.readRaw(id, signal);
  }
}

export default S3SessionPersistence;
