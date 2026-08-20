import { describe, expect, it } from "vitest";
import { S3SessionLog } from "../src/s3log.js";
import { FragmentCorruptError, S3LogError, CasRetryExhaustedError, ManifestCorruptError } from "../src/errors.js";
import { fragmentKey, serializeFragment, sha256Hex } from "../src/fragment.js";
import { emptyManifest, parseManifestBuffer, serializeManifestBuffer, type Manifest } from "../src/manifest.js";
import { MemoryCasStore, fastCas } from "./helpers.js";

async function openLog(store = new MemoryCasStore(), sessionId = "s1") {
  return S3SessionLog.open(store, sessionId, {
    flushThresholdEvents: 50,
    flushThresholdBytes: 262144,
    cas: fastCas,
  });
}

function event(n: number) {
  return { type: "user/message", seq: n, text: `e${n}` };
}

describe("S3SessionLog", () => {
  it("append+flush writes a fragment and CAS-updates the manifest", async () => {
    const store = new MemoryCasStore();
    const log = await openLog(store);
    log.append(event(0));
    log.append(event(1));
    await log.flush();
    expect(store.keys()).toEqual(["fragments/00000001.jsonl", "manifest.json"]);
    const events = await log.readAll();
    expect(events).toEqual([event(0), event(1)]);
    expect(log.stats).toMatchObject({
      totalEvents: 2,
      fragmentCount: 1,
      pendingEvents: 0,
    });
  });

  it("flush is a no-op when the buffer is empty", async () => {
    const store = new MemoryCasStore();
    const log = await openLog(store);
    await log.flush();
    expect(store.keys()).toEqual(["manifest.json"]);
  });

  it("crash-resume: 100 flushed + 10 unflushed are lost cleanly, no corruption", async () => {
    const store = new MemoryCasStore();
    const log = await openLog(store);
    for (let i = 0; i < 100; i++) log.append(event(i));
    await log.flush();
    for (let i = 100; i < 110; i++) log.append(event(i));
    expect(log.stats.pendingEvents).toBe(10);

    const resumed = await openLog(store);
    const events = await resumed.readAll();
    expect(events).toHaveLength(100);
    expect(events[0]).toEqual(event(0));
    expect(events[99]).toEqual(event(99));
    expect(resumed.stats.pendingEvents).toBe(0);
  });

  it("ignores an orphan fragment on open (manifest is source of truth)", async () => {
    const store = new MemoryCasStore();
    const log = await openLog(store);
    log.append(event(0));
    await log.flush();

    const orphan = serializeFragment([event(99)]);
    await store.putIfAbsent("fragments/00000002.jsonl", orphan);

    const resumed = await openLog(store);
    expect(await resumed.readAll()).toEqual([event(0)]);
    expect(resumed.stats.fragmentCount).toBe(1);
  });

  it("skips an orphan seq on the next flush", async () => {
    const store = new MemoryCasStore();
    const log = await openLog(store);
    log.append(event(0));
    await log.flush();
    await store.putIfAbsent("fragments/00000002.jsonl", serializeFragment([event(99)]));

    const resumed = await openLog(store);
    resumed.append(event(1));
    await resumed.flush();
    expect(store.keys()).toContain("fragments/00000003.jsonl");
    expect(await resumed.readAll()).toEqual([event(0), event(1)]);
  });

  it("monotonic seq skips two consecutive orphan fragments (no ping-pong)", async () => {
    const store = new MemoryCasStore();
    const log = await openLog(store);
    log.append(event(0));
    await log.flush();
    await store.putIfAbsent("fragments/00000002.jsonl", serializeFragment([event(98)]));
    await store.putIfAbsent("fragments/00000003.jsonl", serializeFragment([event(99)]));

    const resumed = await openLog(store);
    resumed.append(event(1));
    await resumed.flush();
    expect(store.keys()).toContain("fragments/00000004.jsonl");
    expect(await resumed.readAll()).toEqual([event(0), event(1)]);
  });

  it("LIST-skips a run of orphans that would otherwise exhaust the PUT budget", async () => {
    const store = new MemoryCasStore();
    const log = await openLog(store);
    log.append(event(0));
    await log.flush();
    for (let seq = 2; seq <= 12; seq++) {
      await store.putIfAbsent(
        `fragments/${seq.toString().padStart(8, "0")}.jsonl`,
        serializeFragment([{ orphan: seq }]),
      );
    }
    const resumed = await openLog(store);
    resumed.append(event(1));
    await resumed.flush();
    expect(store.keys()).toContain("fragments/00000013.jsonl");
    expect(await resumed.readAll()).toEqual([event(0), event(1)]);
  });

  it("reallocates a stale fragment ordinal above the committed tail", async () => {
    const store = new MemoryCasStore();
    const a = await openLog(store);
    const b = await openLog(store);
    a.append({ from: "a", seq: 0 });
    b.append({ from: "b", seq: 0 });
    store.afterFragmentPut = async () => {
      await b.flush();
    };
    await a.flush();
    const manifest = parseManifestBuffer((await store.get("manifest.json"))!.body);
    const seqs = manifest.fragments.map((f) => f.seq);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
    expect(seqs[0]).toBeLessThan(seqs[seqs.length - 1]!);
    expect(await (await openLog(store)).readAll()).toEqual([
      { from: "b", seq: 0 },
      { from: "a", seq: 0 },
    ]);
  });

  it("uncontended flush is one GET plus two PUTs", async () => {
    const store = new MemoryCasStore();
    const log = await openLog(store);
    store.getCount = 0;
    store.putCount = 0;
    log.append(event(0));
    await log.flush();
    expect(store.getCount).toBe(1);
    expect(store.putCount).toBe(2);
  });

  it("concurrent flushes never produce an out-of-order fragment list", async () => {
    const store = new MemoryCasStore({ delayMs: 8 });
    const a = await openLog(store);
    const b = await openLog(store);
    a.append({ from: "a" });
    b.append({ from: "b" });
    await Promise.all([a.flush(), b.flush()]);
    const manifest = parseManifestBuffer((await store.get("manifest.json"))!.body);
    const seqs = manifest.fragments.map((f) => f.seq);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
    }
    expect(await (await openLog(store)).readAll()).toHaveLength(2);
  });

  it("retries flush after a lost manifest CAS response without duplicating", async () => {
    const store = new MemoryCasStore();
    const log = await openLog(store);
    log.append(event(0));
    store.crashAfterSuccessfulConditionalPut = true;
    await expect(log.flush()).rejects.toThrow(/lost CAS response/);
    expect(await (await openLog(store)).readAll()).toEqual([event(0)]);
    await log.flush();
    expect(await log.readAll()).toEqual([event(0)]);
    expect(log.stats.fragmentCount).toBe(1);
  });

  it("keeps events appended while flush is in flight", async () => {
    const store = new MemoryCasStore({ delayMs: 20 });
    const log = await openLog(store);
    log.append(event(0));
    const flushing = log.flush();
    await new Promise((r) => setTimeout(r, 5));
    log.append(event(1));
    await flushing;
    expect(log.pending).toEqual([event(1)]);
    await log.flush();
    expect(await log.readAll()).toEqual([event(0), event(1)]);
    expect(log.pending).toEqual([]);
  });

  it("serialized concurrent flush() calls do not duplicate or drop", async () => {
    const store = new MemoryCasStore({ delayMs: 2 });
    const log = await openLog(store);
    log.append(event(0));
    const first = log.flush();
    log.append(event(1));
    const second = log.flush();
    await Promise.all([first, second]);
    expect(await log.readAll()).toEqual([event(0), event(1)]);
    expect(log.pending).toEqual([]);
  });

  it("fragment PUT exhaustion throws CasRetryExhaustedError", async () => {
    const store = new MemoryCasStore();
    const log = await openLog(store);
    store.failNextPutIfAbsent = 20;
    log.append(event(0));
    await expect(log.flush()).rejects.toBeInstanceOf(CasRetryExhaustedError);
    expect(log.pending).toEqual([event(0)]);
  });

  it("open rejects a manifest whose session_id does not match", async () => {
    const store = new MemoryCasStore();
    await openLog(store, "alpha");
    await expect(openLog(store, "beta")).rejects.toBeInstanceOf(ManifestCorruptError);
  });

  it("trim(0) deletes every fragment", async () => {
    const store = new MemoryCasStore();
    const log = await openLog(store);
    log.append(event(0));
    await log.flush();
    log.append(event(1));
    await log.flush();
    await log.trim(0);
    expect(log.stats.fragmentCount).toBe(0);
    expect(await log.readAll()).toEqual([]);
    expect(store.keys()).toEqual(["manifest.json"]);
  });

  it("throws FragmentCorruptError on sha256 mismatch", async () => {
    const store = new MemoryCasStore();
    const log = await openLog(store);
    log.append(event(0));
    await log.flush();
    const key = fragmentKey(1);
    const cur = await store.get(key);
    expect(cur).not.toBeNull();
    await store.putIfMatch(key, Buffer.from('{"tampered":true}\n'), cur!.etag);

    const resumed = await openLog(store);
    await expect(resumed.readAll()).rejects.toBeInstanceOf(FragmentCorruptError);
    await expect(resumed.readAll()).rejects.toThrow(/sha256 mismatch/);
  });

  it("throws when a listed fragment is missing", async () => {
    const store = new MemoryCasStore();
    const log = await openLog(store);
    log.append(event(0));
    await log.flush();
    await store.delete(fragmentKey(1));
    await expect(log.readAll()).rejects.toBeInstanceOf(FragmentCorruptError);
  });

  it("trim keeps last N fragments, deletes older, keeps manifest consistent", async () => {
    const store = new MemoryCasStore();
    const log = await openLog(store);
    for (let i = 0; i < 5; i++) {
      log.append(event(i));
      await log.flush();
    }
    await log.trim(2);
    expect(log.stats.fragmentCount).toBe(2);
    expect(await log.readAll()).toEqual([event(3), event(4)]);
    expect(store.keys()).toEqual([
      "fragments/00000004.jsonl",
      "fragments/00000005.jsonl",
      "manifest.json",
    ]);
  });

  it("trim is a no-op when keepLastN >= fragment count", async () => {
    const store = new MemoryCasStore();
    const log = await openLog(store);
    log.append(event(0));
    await log.flush();
    await log.trim(10);
    expect(log.stats.fragmentCount).toBe(1);
  });

  it("trim rejects a negative keepLastN", async () => {
    const log = await openLog();
    await expect(log.trim(-1)).rejects.toBeInstanceOf(S3LogError);
  });

  it("readFrom yields events from fragments with seq >= start", async () => {
    const log = await openLog();
    log.append(event(0));
    await log.flush();
    log.append(event(1));
    await log.flush();
    log.append(event(2));
    await log.flush();
    const got: unknown[] = [];
    for await (const e of log.readFrom(2)) got.push(e);
    expect(got).toEqual([event(1), event(2)]);
  });

  it("close flushes remaining buffered events", async () => {
    const store = new MemoryCasStore();
    const log = await openLog(store);
    log.append(event(0));
    await log.close();
    const resumed = await openLog(store);
    expect(await resumed.readAll()).toEqual([event(0)]);
  });

  it("concurrent flush on a shared store both succeed via CAS retry", async () => {
    const store = new MemoryCasStore();
    const a = await openLog(store, "shared");
    const b = await openLog(store, "shared");
    a.append({ who: "a" });
    b.append({ who: "b" });
    await Promise.all([a.flush(), b.flush()]);
    const reader = await openLog(store, "shared");
    const events = await reader.readAll();
    expect(events).toHaveLength(2);
    expect(events).toEqual(expect.arrayContaining([{ who: "a" }, { who: "b" }]));
    expect(reader.stats.fragmentCount).toBe(2);
  });

  it("injected 412 on fragment putIfAbsent is retried with a new seq", async () => {
    const store = new MemoryCasStore();
    const log = await openLog(store);
    store.failNextPutIfAbsent = 1;
    log.append(event(0));
    await log.flush();
    expect(await log.readAll()).toEqual([event(0)]);
  });

  it("multiple flushes increment seq and totals", async () => {
    const log = await openLog();
    log.append(event(0));
    await log.flush();
    log.append(event(1));
    await log.flush();
    expect(log.stats).toMatchObject({ totalEvents: 2, fragmentCount: 2, pendingEvents: 0 });
  });

  it("shouldFlush respects event and byte thresholds", async () => {
    const store = new MemoryCasStore();
    const byEvents = await S3SessionLog.open(store, "e", {
      flushThresholdEvents: 2,
      flushThresholdBytes: 1_000_000,
      cas: fastCas,
    });
    byEvents.append(event(0));
    expect(byEvents.shouldFlush()).toBe(false);
    byEvents.append(event(1));
    expect(byEvents.shouldFlush()).toBe(true);

    const byBytes = await S3SessionLog.open(new MemoryCasStore(), "b", {
      flushThresholdEvents: 10_000,
      flushThresholdBytes: 10,
      cas: fastCas,
    });
    byBytes.append({ pad: "x".repeat(64) });
    expect(byBytes.shouldFlush()).toBe(true);
  });

  it("open of a brand-new session writes an empty manifest", async () => {
    const store = new MemoryCasStore();
    await openLog(store, "fresh");
    const manifest = store.objects.get("manifest.json");
    expect(manifest).toBeDefined();
    const parsed = JSON.parse(manifest!.body.toString()) as Manifest;
    expect(parsed.session_id).toBe("fresh");
    expect(parsed.fragments).toEqual([]);
  });

  it("fragment sha256 in the manifest matches the stored bytes", async () => {
    const store = new MemoryCasStore();
    const log = await openLog(store);
    log.append(event(0));
    await log.flush();
    const body = (await store.get(fragmentKey(1)))!.body;
    const manifest = JSON.parse((await store.get("manifest.json"))!.body.toString()) as Manifest;
    expect(manifest.fragments[0]!.sha256).toBe(sha256Hex(body));
    expect(manifest.fragments[0]!.events).toBe(1);
    expect(manifest.fragments[0]!.bytes).toBe(body.byteLength);
  });

  it("can seed an existing emptyManifest without losing session_id", async () => {
    const store = new MemoryCasStore();
    const seed = emptyManifest("seeded");
    await store.putIfAbsent("manifest.json", serializeManifestBuffer(seed));
    const log = await openLog(store, "seeded");
    log.append({ ok: true });
    await log.flush();
    expect((await log.readAll())[0]).toEqual({ ok: true });
  });
});
