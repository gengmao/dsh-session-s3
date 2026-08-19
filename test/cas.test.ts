import { describe, expect, it } from "vitest";
import { casUpdate } from "../src/cas.js";
import { CasRetryExhaustedError } from "../src/errors.js";
import { MemoryCasStore, fastCas } from "./helpers.js";

function parseNum(buf: Buffer): number {
  return Number(buf.toString("utf8"));
}
function serNum(n: number): Buffer {
  return Buffer.from(String(n), "utf8");
}

describe("casUpdate", () => {
  it("creates a key with putIfAbsent when missing", async () => {
    const store = new MemoryCasStore();
    const result = await casUpdate(store, "n", () => 1, parseNum, serNum, fastCas);
    expect(result.value).toBe(1);
    expect(result.etag).toBe("etag-1");
    expect((await store.get("n"))?.body.toString()).toBe("1");
  });

  it("updates with If-Match when the key exists", async () => {
    const store = new MemoryCasStore();
    await casUpdate(store, "n", () => 1, parseNum, serNum, fastCas);
    const result = await casUpdate(store, "n", (cur) => (cur ?? 0) + 1, parseNum, serNum, fastCas);
    expect(result.value).toBe(2);
  });

  it("retries after a single injected 412 and then succeeds", async () => {
    const store = new MemoryCasStore();
    await casUpdate(store, "n", () => 1, parseNum, serNum, fastCas);
    store.failNextPutIfMatch = 1;
    const result = await casUpdate(
      store,
      "n",
      (cur) => (cur ?? 0) + 10,
      parseNum,
      serNum,
      fastCas,
    );
    expect(result.value).toBe(11);
  });

  it("throws CasRetryExhaustedError after maxRetries", async () => {
    const store = new MemoryCasStore();
    await casUpdate(store, "n", () => 1, parseNum, serNum, fastCas);
    store.failNextPutIfMatch = 100;
    await expect(
      casUpdate(store, "n", (cur) => (cur ?? 0) + 1, parseNum, serNum, {
        ...fastCas,
        maxRetries: 3,
      }),
    ).rejects.toBeInstanceOf(CasRetryExhaustedError);
  });

  it("does not retry non-conflict errors", async () => {
    const store = new MemoryCasStore();
    await expect(
      casUpdate(
        store,
        "n",
        () => {
          throw new Error("boom");
        },
        parseNum,
        serNum,
        fastCas,
      ),
    ).rejects.toThrow("boom");
  });

  it("passes null to mutate when the key is absent", async () => {
    const store = new MemoryCasStore();
    const seen: Array<number | null> = [];
    await casUpdate(
      store,
      "n",
      (cur) => {
        seen.push(cur);
        return 7;
      },
      parseNum,
      serNum,
      fastCas,
    );
    expect(seen).toEqual([null]);
  });
});
