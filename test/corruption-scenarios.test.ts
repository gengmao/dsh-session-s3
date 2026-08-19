/**
 * The 7 field-confirmed DSH JSONL corruption mechanisms, replayed against
 * wal3-Lite on S3 (immutable fragments + CAS manifest).
 *
 * Sources (deepseek-ai/deepseek-harness discussions):
 *   #1333  cross-process seq overlap
 *   #1452  multi-process concurrent write / duplicate seq segments
 *   #1497  torn tail / crash recovery replays committed events
 *   #1473  one corrupt log poisons list() / workspace boot
 *   #1586  recovery writer vs surviving legacy writer
 *   #2167  stale-view re-append of last N committed events
 *   #2342  repair-injection vs live writer
 *
 * JSONL fails these because it concatenates writers into one file and the
 * scanner requires events[i].seq === i. wal3-Lite never mutates a fragment
 * and commits writers through a single CAS object, so a session stays
 * readable even when payload seqs collide (a coordinator-level concern).
 */
import { describe, expect, it } from "vitest";
import { S3SessionLog } from "../src/s3log.js";
import { createProvider } from "../src/provider.js";
import { FragmentCorruptError } from "../src/errors.js";
import { fragmentKey } from "../src/fragment.js";
import { MemoryCasStore, fastCas } from "./helpers.js";

interface DshEvent {
  seq: number;
  type: string;
  data?: unknown;
  time?: number;
}

function ev(seq: number, type: string, data?: unknown): DshEvent {
  return { seq, type, data, time: 1_000_000 + seq };
}

async function open(store: MemoryCasStore, sessionId = "sess") {
  return S3SessionLog.open(store, sessionId, {
    flushThresholdEvents: 10_000,
    flushThresholdBytes: 10_000_000,
    cas: fastCas,
  });
}

function payloadSeqs(events: unknown[]): number[] {
  return events.map((e) => (e as DshEvent).seq);
}

function seqContinuity(events: unknown[]): { ok: boolean; dups: number[]; rewinds: string[] } {
  const seqs = payloadSeqs(events);
  const seen = new Set<number>();
  const dups: number[] = [];
  const rewinds: string[] = [];
  for (let i = 0; i < seqs.length; i++) {
    const s = seqs[i]!;
    if (seen.has(s)) dups.push(s);
    seen.add(s);
    if (i > 0 && s <= seqs[i - 1]!) {
      rewinds.push(`${seqs[i - 1]} -> ${s}`);
    }
  }
  return { ok: dups.length === 0 && rewinds.length === 0, dups, rewinds };
}

describe("7 DSH JSONL corruption scenarios vs wal3-Lite", () => {
  it("#1333 cross-process seq: two writers, same in-memory watermark, log stays readable", async () => {
    const store = new MemoryCasStore();
    const a = await open(store);
    const b = await open(store);
    // Each process independently assigns seq from its own log.length === 0.
    a.append(ev(0, "user/message", "from-a"));
    b.append(ev(0, "user/message", "from-b"));
    await Promise.all([a.flush(), b.flush()]);

    const reader = await open(store);
    const events = await reader.readAll();
    expect(events).toHaveLength(2);
    expect(reader.stats.fragmentCount).toBe(2);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ data: "from-a" }),
        expect.objectContaining({ data: "from-b" }),
      ]),
    );
    // Payload seqs may collide — that is the coordinator bug. The *file*
    // is not unloadable, which is the JSONL failure mode.
    const report = seqContinuity(events);
    expect(report.dups).toEqual([0]);
    expect(reader.stats.fragmentCount).toBeGreaterThan(0);
  });

  it("#1452 multi-process concurrent write: duplicate batches become two fragments, not a seq-gap crash", async () => {
    const store = new MemoryCasStore();
    const web = await open(store);
    for (const s of [0, 1, 2, 3]) web.append(ev(s, "assistant/chunk"));
    await web.flush();

    const desktop = await open(store); // other process, stale in-memory seq
    for (const s of [0, 1, 2, 3]) desktop.append(ev(s, "assistant/chunk"));
    for (const s of [4, 5]) desktop.append(ev(s, "assistant/message"));
    await desktop.flush();

    const events = await (await open(store)).readAll();
    expect(events.length).toBe(10);
    // JSONL scanner: "seq gap in committed region (expected 4, got 0)" → refuse
    // wal3-Lite: every fragment parses; prefix of first writer is intact.
    expect(payloadSeqs(events).slice(0, 4)).toEqual([0, 1, 2, 3]);
    expect(seqContinuity(events).dups).toEqual([0, 1, 2, 3]);
  });

  it("#1497 torn tail: crash after fragment PUT / before manifest CAS loses only the in-flight batch", async () => {
    const store = new MemoryCasStore();
    const log = await open(store);
    for (let i = 0; i < 100; i++) log.append(ev(i, "assistant/chunk"));
    await log.flush();

    store.crashAfterFragmentPut = true;
    const writer = await open(store);
    for (let i = 100; i < 110; i++) writer.append(ev(i, "assistant/chunk"));
    await expect(writer.flush()).rejects.toThrow(/simulated crash/);

    const resumed = await open(store);
    const events = await resumed.readAll();
    expect(events).toHaveLength(100);
    expect(payloadSeqs(events)).toEqual([...Array(100).keys()]);
    expect(seqContinuity(events).ok).toBe(true);
    // Orphan fragment may exist; it is not in the manifest.
    expect(resumed.stats.fragmentCount).toBe(1);
  });

  it("#1497 torn object in the SAME fragment never poisons prior fragments", async () => {
    const store = new MemoryCasStore();
    const log = await open(store);
    log.append(ev(0, "user/message", "keep-me"));
    await log.flush();
    log.append(ev(1, "assistant/message", "torn-later"));
    await log.flush();

    store.smash(fragmentKey(2), Buffer.from('{"seq":1,"type":"assistant/message","data":"tor'));

    const reader = await open(store);
    await expect(reader.readAll()).rejects.toBeInstanceOf(FragmentCorruptError);
    // The committed prefix fragment is still intact — unlike a torn JSONL
    // tail, which lives in the same file as the prefix.
    const prefix = await store.get(fragmentKey(1));
    expect(prefix).not.toBeNull();
    expect(JSON.parse(prefix!.body.toString().trim()).data).toBe("keep-me");
  });

  it("#1473 one corrupt session does not take down a sibling (list/boot isolation)", async () => {
    const stores = new Map<string, MemoryCasStore>([
      ["good", new MemoryCasStore()],
      ["bad", new MemoryCasStore()],
    ]);
    const provider = createProvider(
      { bucket: "test", flushThresholdEvents: 1 },
      { createStore: (id) => stores.get(id) ?? new MemoryCasStore() },
    );

    await provider.append("good", ev(0, "user/message", "hello") as unknown as Record<string, unknown>);
    await provider.append("bad", ev(0, "user/message", "doomed") as unknown as Record<string, unknown>);
    stores.get("bad")!.smash(fragmentKey(1), Buffer.from("not-json\n"));

    await expect(provider.read("bad")).rejects.toBeInstanceOf(FragmentCorruptError);
    expect(await provider.read("good")).toEqual([
      expect.objectContaining({ data: "hello" }),
    ]);
  });

  it("#1586 recovery writer vs legacy writer: synthetic closers + live results coexist", async () => {
    const store = new MemoryCasStore();
    const live = await open(store);
    live.append(ev(0, "step/start"));
    await live.flush();

    // Cold recovery thinks the turn is open and injects synthetic closers
    // at last.seq+1 (the JSONL bug: it also appends them into the same file
    // the live writer is still using).
    const recovery = await open(store);
    recovery.append(ev(1, "tool/result", { kind: "interrupted" }));
    recovery.append(ev(2, "step/end"));
    recovery.append(ev(3, "turn/end", { kind: "interrupted" }));
    recovery.append(ev(4, "session/end-seed"));
    await recovery.flush();

    // Surviving live writer continues from its in-memory seq (also 1).
    live.append(ev(1, "tool/result", { kind: "ok" }));
    live.append(ev(2, "step/end"));
    live.append(ev(3, "turn/end", { kind: "completed" }));
    await live.flush();

    const events = await (await open(store)).readAll();
    expect(events.length).toBe(8);
    const types = events.map((e) => (e as DshEvent).type);
    expect(types).toContain("session/end-seed");
    expect(types.filter((t) => t === "tool/result")).toHaveLength(2);
    // Readable. JSONL would refuse: "expected 5, got 1".
    expect(seqContinuity(events).rewinds.length).toBeGreaterThan(0);
  });

  it("#2167 stale-view re-append: last N committed events replayed with fresh timestamps", async () => {
    const store = new MemoryCasStore();
    const writer = await open(store);
    for (const s of [0, 1, 2, 3, 4, 5, 6, 7]) {
      writer.append(ev(s, s < 4 ? "assistant/chunk" : "tool/result"));
    }
    await writer.flush();

    // Resume from a view that's 4 events behind (thinks last seq is 3).
    const stale = await open(store);
    const freshTime = 9_000_000;
    for (const s of [4, 5, 6, 7]) {
      stale.append({ seq: s, type: "tool/result", time: freshTime + s });
    }
    stale.append(ev(8, "assistant/message", "new"));
    await stale.flush();

    const events = await (await open(store)).readAll();
    expect(events).toHaveLength(13);
    expect(payloadSeqs(events).slice(0, 8)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect((events[events.length - 1] as DshEvent).data).toBe("new");
    expect(seqContinuity(events).dups).toEqual([4, 5, 6, 7]);
  });

  it("#2342 repair-injection vs live writer: synthetic tail does not clobber live chunks", async () => {
    const store = new MemoryCasStore();
    const live = await open(store);
    live.append(ev(0, "step/start"));
    await live.flush();

    // Cold load assumes "unbalanced log = crashed process" and commitRepair.
    const repair = await open(store);
    repair.append({ seq: 1, type: "step/end", time: 1_000_000 });
    repair.append({ seq: 2, type: "turn/end", time: 1_000_000, data: { kind: "interrupted" } });
    await repair.flush();

    // Live writer was mid-turn and keeps appending real chunks at the same seqs.
    live.append(ev(1, "assistant/chunk", "token-a"));
    live.append(ev(2, "assistant/chunk", "token-b"));
    live.append(ev(3, "assistant/message", "done"));
    await live.flush();

    const events = await (await open(store)).readAll();
    const types = events.map((e) => (e as DshEvent).type);
    expect(types).toEqual([
      "step/start",
      "step/end",
      "turn/end",
      "assistant/chunk",
      "assistant/chunk",
      "assistant/message",
    ]);
    expect((events[3] as DshEvent).data).toBe("token-a");
    expect((events[5] as DshEvent).data).toBe("done");
  });

  it("missing fsync analogue: a failed manifest CAS does not publish the fragment", async () => {
    const store = new MemoryCasStore();
    const log = await open(store);
    log.append(ev(0, "user/message", "committed"));
    await log.flush();

    store.failNextPutIfMatch = 100; // exhaust CAS on the next manifest update
    const writer = await open(store);
    writer.append(ev(1, "assistant/message", "should-not-publish"));
    await expect(writer.flush()).rejects.toThrow();

    const resumed = await open(store);
    const events = await resumed.readAll();
    expect(events).toEqual([expect.objectContaining({ data: "committed" })]);
    expect(resumed.stats.fragmentCount).toBe(1);
  });
});
