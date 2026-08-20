import { describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import {
  S3SessionPersistence,
  S3SessionRuntime,
  type LiveSession,
} from "../src/persistence.js";
import type { PersistEvent, PersistHeader } from "../src/backend.js";
import { MemoryCasStore } from "./helpers.js";
import { fastCas } from "./helpers.js";

function header(id = "sess-1"): PersistHeader {
  return { version: 0, id, createdAt: 1_700_000_000_000, cwd: "/work" };
}

function ev(seq: number, type = "user/message"): PersistEvent {
  return { seq, type, time: 1_700_000_000_000 + seq, data: { n: seq } };
}

function runtime(store = new MemoryCasStore(), ctx?: ConstructorParameters<typeof S3SessionRuntime>[1]) {
  return S3SessionRuntime.create(
    { bucket: "test-bucket", prefix: "dsh/" },
    { bucket: store, cas: fastCas, ctx },
  );
}

describe("S3SessionRuntime (SessionPersistence seam)", () => {
  it("create is lazy — absent from list until first append", async () => {
    const r = runtime();
    await r.create(header());
    expect(await r.list()).toEqual([]);
    await r.append("sess-1", [ev(0)]);
    expect((await r.list()).map((h) => h.id)).toEqual(["sess-1"]);
  });

  it("append + load round-trips header and events", async () => {
    const r = runtime();
    await r.create(header());
    await r.append("sess-1", [ev(0), ev(1)]);
    const loaded = await r.load("sess-1");
    expect(loaded.meta).toMatchObject({ id: "sess-1", cwd: "/work" });
    expect(loaded.events).toEqual([ev(0), ev(1)]);
  });

  it("rejects appends whose first seq is not the stored next-seq", async () => {
    const r = runtime();
    await r.create(header());
    await r.append("sess-1", [ev(0)]);
    await expect(r.append("sess-1", [ev(2)])).rejects.toThrow(
      /append seq mismatch for "sess-1": expected 1 at index 0, got 2/,
    );
  });

  it("inspect does not drop a torn tail; load commits the repair", async () => {
    const store = new MemoryCasStore();
    const r = runtime(store);
    await r.create(header());
    await r.append("sess-1", [ev(0)]);
    await r.append("sess-1", [ev(1)]);
    store.smash(
      "dsh/sessions/sess-1/fragments/00000002.jsonl",
      Buffer.from("nope\n"),
    );
    const inspected = await r.inspect("sess-1");
    expect(inspected.events).toEqual([ev(0)]);
    const loaded = await r.load("sess-1");
    expect(loaded.events).toEqual([ev(0)]);
    const again = await r.inspect("sess-1");
    expect(again.events).toEqual([ev(0)]);
  });

  it("readFrom returns the suffix and an empty list past the end", async () => {
    const r = runtime();
    await r.create(header());
    await r.append("sess-1", [ev(0), ev(1), ev(2)]);
    expect((await r.readFrom("sess-1", 2)).events).toEqual([ev(2)]);
    expect((await r.readFrom("sess-1", 99)).events).toEqual([]);
    await expect(r.readFrom("sess-1", -1)).rejects.toThrow(/fromSeq/);
  });

  it("locate is side-effect free", () => {
    const r = runtime();
    expect(r.locate(header("x")).path).toBe("s3://test-bucket/dsh/sessions/x/");
  });

  it("create of an already-tracked or persisted id is refused", async () => {
    const store = new MemoryCasStore();
    const r = runtime(store);
    await r.create(header());
    await expect(r.create(header())).rejects.toThrow(/already exists in this backend/);
    await r.append("sess-1", [ev(0)]);
    const r2 = runtime(store);
    await expect(r2.create(header())).rejects.toThrow(/already has a persisted log/);
  });

  it("prepare seeds SessionStore from the durable log", async () => {
    const prepared: unknown[] = [];
    const r = runtime(
      new MemoryCasStore(),
      {
        sessions: {
          prepare(id, opts) {
            prepared.push({ id, opts });
            return { id, unpublished: true };
          },
        },
      },
    );
    await r.create(header());
    await r.append("sess-1", [ev(0)]);
    const out = await r.prepare("sess-1");
    expect(out).toEqual({ id: "sess-1", unpublished: true });
    expect(prepared[0]).toMatchObject({
      id: "sess-1",
      opts: { seedSource: "persistence" },
    });
  });

  it("write path: session/created seed + session/event + flush persist", async () => {
    const listeners = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const ctx = {
      on(event: string, listener: (...args: unknown[]) => unknown) {
        const list = listeners.get(event) ?? [];
        list.push(listener);
        listeners.set(event, list);
      },
    };
    const r = runtime(new MemoryCasStore(), ctx);
    const session: LiveSession = {
      id: "sess-1",
      header: header(),
      events: [ev(0)],
    };
    await Promise.all((listeners.get("session/created") ?? []).map((fn) => fn(session)));
    for (const fn of listeners.get("session/event") ?? []) fn(session, ev(1));
    await Promise.all((listeners.get("session/flush") ?? []).map((fn) => fn(session)));
    const loaded = await r.load("sess-1");
    expect(loaded.events).toEqual([ev(0), ev(1)]);
  });
});

describe("S3SessionPersistence Cordis service", () => {
  it("registers under the sessionPersistence service key and serves the API", async () => {
    const ctx = new Context();
    ctx.provide("sessions", {
      get: () => undefined,
      list: () => [],
      prepare: () => ({}),
    });
    const store = new MemoryCasStore();
    const service = new S3SessionPersistence(
      ctx,
      { bucket: "test-bucket" },
      { bucket: store, cas: fastCas },
    );
    expect(service.name).toBe("sessionPersistence");
    expect(service.supportsRawArtifacts).toBe(true);
    await service.create(header());
    await service.append("sess-1", [ev(0)]);
    const loaded = await service.load("sess-1");
    expect(loaded.events).toEqual([ev(0)]);
    expect(service.locate(header()).kind).toBe("s3");
    expect(typeof ctx.get).toBe("function");
  });
});
