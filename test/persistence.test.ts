import { describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { SessionId } from "@deepseek-ai/dsh-session";
import type { SessionEvent, SessionHeader } from "@deepseek-ai/dsh-session";
import { SessionPersistence } from "@deepseek-ai/dsh-session-persistence";
import { S3SessionPersistence } from "../src/persistence.js";
import { MemoryCasStore, fastCas } from "./helpers.js";

function header(id = "sess-1"): SessionHeader {
  return { version: 0, id: SessionId(id), createdAt: 1_700_000_000_000, cwd: "/work" };
}

function ev(seq: number): SessionEvent {
  return { type: "turn/start", seq, time: 1_700_000_000_000 + seq, data: { turn: seq } };
}

function service(store = new MemoryCasStore()) {
  const ctx = new Context();
  ctx.provide("sessions", {
    get: () => undefined,
    list: () => [],
    prepare(_id: string, opts: { seed?: unknown[]; meta?: unknown }) {
      return { header: opts.meta, events: opts.seed ?? [] };
    },
  });
  return new S3SessionPersistence(
    ctx,
    { bucket: "test-bucket", writeBatchMaxDelayMs: 1 },
    { bucket: store, cas: fastCas },
  );
}

describe("S3SessionPersistence (official SessionPersistence + PersistenceCoordinator)", () => {
  it("is a SessionPersistence", () => {
    const svc = service();
    expect(svc).toBeInstanceOf(SessionPersistence);
    expect(svc).toBeInstanceOf(S3SessionPersistence);
    expect(svc.name).toBe("sessionPersistence");
  });

  it("create is lazy — absent from list until first append", async () => {
    const svc = service();
    await svc.create(header());
    expect(await svc.list()).toEqual([]);
    await svc.append(SessionId("sess-1"), [ev(0)]);
    expect((await svc.list()).map((h) => h.id)).toEqual(["sess-1"]);
  });

  it("append + load round-trips header and events through the coordinator", async () => {
    const svc = service();
    await svc.create(header());
    await svc.append(SessionId("sess-1"), [ev(0), ev(1)]);
    const loaded = await svc.load(SessionId("sess-1"));
    expect(loaded.meta).toMatchObject({ id: "sess-1", cwd: "/work" });
    expect(loaded.events.slice(0, 2)).toEqual([ev(0), ev(1)]);
    expect(loaded.events.at(-1)).toMatchObject({
      type: "turn/end",
      data: { reason: { kind: "interrupted" } },
    });
  });

  it("rejects appends whose first seq is not the stored next-seq", async () => {
    const svc = service();
    await svc.create(header());
    await svc.append(SessionId("sess-1"), [ev(0)]);
    await expect(svc.append(SessionId("sess-1"), [ev(2)])).rejects.toThrow(/seq mismatch/);
  });

  it("inspect does not drop a torn tail; load commits the repair", async () => {
    const store = new MemoryCasStore();
    const svc = service(store);
    const quiet = (seq: number): SessionEvent => ({
      type: "session/end-seed",
      seq,
      time: 1_700_000_000_000 + seq,
      data: {},
    });
    await svc.create(header());
    await svc.append(SessionId("sess-1"), [quiet(0)]);
    await svc.append(SessionId("sess-1"), [quiet(1)]);
    store.smash("dsh/sessions/sess-1/fragments/00000002.jsonl", Buffer.from("nope\n"));

    const storedBefore = await svc.loadStored(SessionId("sess-1"));
    expect(storedBefore?.events).toEqual([quiet(0)]);
    expect(storedBefore?.tornMarker).toEqual(
      expect.objectContaining({ dropFromSeq: 2, etag: expect.any(String), tailSha256: expect.any(String) }),
    );

    const inspected = await svc.inspect(SessionId("sess-1"));
    expect(inspected.events[0]).toEqual(quiet(0));
    expect(storedBefore?.tornMarker).toEqual(
      expect.objectContaining({ dropFromSeq: 2 }),
    );

    await svc.load(SessionId("sess-1"));
    const storedAfter = await svc.loadStored(SessionId("sess-1"));
    expect(storedAfter?.tornMarker).toBeUndefined();
    expect(storedAfter?.events[0]).toEqual(quiet(0));
  });

  it("readFrom returns the suffix", async () => {
    const svc = service();
    await svc.create(header());
    await svc.append(SessionId("sess-1"), [ev(0), ev(1), ev(2)]);
    expect((await svc.readFrom(SessionId("sess-1"), 2)).events).toEqual([ev(2)]);
    expect((await svc.readFrom(SessionId("sess-1"), 99)).events).toEqual([]);
  });

  it("locate is side-effect free", () => {
    const svc = service();
    expect(svc.locate(header("x")).path).toBe("s3://test-bucket/dsh/sessions/x/");
  });

  it("create of an already-tracked or persisted id is refused", async () => {
    const store = new MemoryCasStore();
    const svc = service(store);
    await svc.create(header());
    await expect(svc.create(header())).rejects.toThrow(/already exists/);
    await svc.append(SessionId("sess-1"), [ev(0)]);
    const svc2 = service(store);
    await expect(svc2.create(header())).rejects.toThrow(/persisted log|already/);
  });
});
