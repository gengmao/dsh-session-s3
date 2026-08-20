import { describe, expect, it } from "vitest";
import { SessionId } from "@deepseek-ai/dsh-session";
import type { SessionEvent, SessionHeader } from "@deepseek-ai/dsh-session";
import { parseConfig } from "../src/config.js";
import { S3PersistenceBackend } from "../src/backend.js";
import { serializeFragment } from "../src/fragment.js";
import { MemoryCasStore, fastCas } from "./helpers.js";

function header(id = "sess-1"): SessionHeader {
  return { version: 0, id: SessionId(id), createdAt: 1_700_000_000_000, cwd: "/work" };
}

function ev(seq: number): SessionEvent {
  return { type: "turn/start", seq, time: 1_700_000_000_000 + seq, data: { turn: seq } };
}

function backend(store = new MemoryCasStore()) {
  return {
    store,
    backend: S3PersistenceBackend.fromMemory(
      parseConfig({ bucket: "test-bucket", prefix: "dsh/" }),
      store,
      fastCas,
    ),
  };
}

describe("S3PersistenceBackend (PersistenceBackend hooks)", () => {
  it("create is lazy: list is empty until the first appendBatch", async () => {
    const { backend: b } = backend();
    expect(await b.list()).toEqual([]);
  });

  it("appendBatch materializes header + events atomically", async () => {
    const { backend: b } = backend();
    await b.appendBatch(header(), [ev(0), ev(1)], false);
    const stored = await b.loadStored(SessionId("sess-1"));
    expect(stored?.meta).toMatchObject({ id: "sess-1", cwd: "/work" });
    expect(stored?.events).toEqual([ev(0), ev(1)]);
    expect(await b.list()).toEqual([expect.objectContaining({ id: "sess-1" })]);
  });

  it("rejects a batch whose first seq is not the stored next-seq", async () => {
    const { backend: b } = backend();
    await b.appendBatch(header(), [ev(0)], false);
    await expect(b.appendBatch(header(), [ev(2)], true)).rejects.toThrow(
      /append seq mismatch.*expected 1, got 2/,
    );
  });

  it("locate returns an s3 URI without touching storage", () => {
    const { backend: b } = backend();
    expect(b.locate(header("abc"))).toEqual({
      kind: "s3",
      path: "s3://test-bucket/dsh/sessions/abc/",
    });
  });

  it("last-fragment sha mismatch is a torn tail, not fatal load", async () => {
    const { store, backend: b } = backend();
    await b.appendBatch(header(), [ev(0)], false);
    await b.appendBatch(header(), [ev(1)], true);
    const key = "dsh/sessions/sess-1/fragments/00000002.jsonl";
    store.smash(key, Buffer.from("{not-the-bytes}\n"));
    const stored = await b.loadStored(SessionId("sess-1"));
    expect(stored?.events).toEqual([ev(0)]);
    expect(stored?.tornMarker).toEqual({ dropFromSeq: 2 });
    await b.commitRepair(stored!.meta, stored!.tornMarker, []);
    const after = await b.loadStored(SessionId("sess-1"));
    expect(after?.events).toEqual([ev(0)]);
    expect(after?.tornMarker).toBeUndefined();
  });

  it("list skips a session with a corrupt manifest and still returns others", async () => {
    const { store, backend: b } = backend();
    await b.appendBatch(header("good"), [ev(0)], false);
    await b.appendBatch(header("bad"), [ev(0)], false);
    store.smash("dsh/sessions/bad/manifest.json", Buffer.from("not-json"));
    const listed = await b.list();
    expect(listed.map((h) => h.id)).toEqual(["good"]);
  });

  it("list does not parse fragments, so a smashed fragment does not poison listing", async () => {
    const { store, backend: b } = backend();
    await b.appendBatch(header("good"), [ev(0)], false);
    await b.appendBatch(header("rot"), [ev(0)], false);
    store.smash(
      "dsh/sessions/rot/fragments/00000001.jsonl",
      serializeFragment([{ wrecked: true }]),
    );
    const ids = (await b.list()).map((h) => h.id).sort();
    expect(ids).toEqual(["good", "rot"]);
  });

  it("readRaw concatenates header + events as JSONL", async () => {
    const { backend: b } = backend();
    await b.appendBatch(header(), [ev(0)], false);
    const raw = await b.readRaw(SessionId("sess-1"));
    expect(raw?.filename).toBe("session.jsonl");
    const lines = raw!.content.trim().split("\n");
    expect(JSON.parse(lines[0]!)).toMatchObject({ id: "sess-1" });
    expect(JSON.parse(lines[1]!)).toEqual(ev(0));
  });
});
