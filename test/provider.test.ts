import { describe, expect, it } from "vitest";
import { createProvider } from "../src/provider.js";
import { parseConfig } from "../src/config.js";
import { ConfigError } from "../src/errors.js";
import { MemoryCasStore, fastCas } from "./helpers.js";
import { S3SessionLog } from "../src/s3log.js";

function provider(store = new MemoryCasStore(), extra: Record<string, unknown> = {}) {
  return createProvider(
    { bucket: "test-bucket", flushThresholdEvents: 50, ...extra },
    { createStore: () => store },
  );
}

describe("createProvider / config", () => {
  it("loud-fails when bucket is missing and lists the problem", () => {
    expect(() => createProvider({})).toThrow(ConfigError);
    try {
      createProvider({});
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const cfg = error as ConfigError;
      expect(cfg.issues.some((i) => i.includes("bucket"))).toBe(true);
      expect(cfg.message).toMatch(/invalid dsh-session-s3 config/);
    }
  });

  it("loud-fails listing every problem at once", () => {
    try {
      createProvider({
        accessKeyId: "ak",
        flushThresholdEvents: 0,
        flushThresholdBytes: -1,
      });
      throw new Error("expected ConfigError");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const cfg = error as ConfigError;
      const joined = cfg.issues.join(" | ");
      expect(joined).toMatch(/bucket/);
      expect(joined).toMatch(/flushThresholdEvents/);
      expect(joined).toMatch(/flushThresholdBytes/);
    }
  });

  it("requires secretAccessKey when accessKeyId is set", () => {
    expect(() => createProvider({ bucket: "b", accessKeyId: "ak" })).toThrow(/secretAccessKey/);
  });

  it("defaults prefix, region, flush thresholds, and path-style-when-endpoint", () => {
    const resolved = parseConfig({ bucket: "b", endpoint: "http://127.0.0.1:9000" });
    expect(resolved.prefix).toBe("dsh/");
    expect(resolved.region).toBe("auto");
    expect(resolved.flushThresholdEvents).toBe(50);
    expect(resolved.flushThresholdBytes).toBe(262144);
    expect(resolved.forcePathStyle).toBe(true);
  });

  it("does not force path-style on AWS when endpoint is omitted", () => {
    expect(parseConfig({ bucket: "b" }).forcePathStyle).toBe(false);
  });

  it("falls back to AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY", () => {
    const prevId = process.env.AWS_ACCESS_KEY_ID;
    const prevSecret = process.env.AWS_SECRET_ACCESS_KEY;
    process.env.AWS_ACCESS_KEY_ID = "env-ak";
    process.env.AWS_SECRET_ACCESS_KEY = "env-sk";
    try {
      const resolved = parseConfig({ bucket: "b" });
      expect(resolved.accessKeyId).toBe("env-ak");
      expect(resolved.secretAccessKey).toBe("env-sk");
    } finally {
      if (prevId === undefined) delete process.env.AWS_ACCESS_KEY_ID;
      else process.env.AWS_ACCESS_KEY_ID = prevId;
      if (prevSecret === undefined) delete process.env.AWS_SECRET_ACCESS_KEY;
      else process.env.AWS_SECRET_ACCESS_KEY = prevSecret;
    }
  });
});

describe("provider delegation", () => {
  it("append + read round-trips events", async () => {
    const p = provider();
    await p.load("sess-1");
    await p.append("sess-1", { type: "user/message", text: "hi" });
    await p.append("sess-1", { type: "assistant/message", text: "yo" });
    expect(await p.read("sess-1")).toEqual([
      { type: "user/message", text: "hi" },
      { type: "assistant/message", text: "yo" },
    ]);
  });

  it("auto-opens a session on append without an explicit load", async () => {
    const p = provider();
    await p.append("auto", { n: 1 });
    expect(await p.read("auto")).toEqual([{ n: 1 }]);
  });

  it("flushes when the event threshold is hit", async () => {
    const store = new MemoryCasStore();
    const p = provider(store, { flushThresholdEvents: 2 });
    await p.append("s", { n: 1 });
    expect(store.keys().some((k) => k.startsWith("fragments/"))).toBe(false);
    await p.append("s", { n: 2 });
    expect(store.keys()).toContain("fragments/00000001.jsonl");
  });

  it("compact trims to keepLastN fragments (default 10)", async () => {
    const store = new MemoryCasStore();
    const log = await S3SessionLog.open(store, "s", { cas: fastCas, flushThresholdEvents: 1 });
    for (let i = 0; i < 5; i++) {
      log.append({ n: i });
      await log.flush();
    }
    const p = createProvider({ bucket: "test-bucket" }, { createStore: () => store });
    await p.load("s");
    await p.compact("s", 2);
    expect(await p.read("s")).toEqual([{ n: 3 }, { n: 4 }]);
  });

  it("close flushes then evicts the cached log", async () => {
    const store = new MemoryCasStore();
    const p = provider(store, { flushThresholdEvents: 100 });
    await p.append("s", { n: 1 });
    await p.close("s");
    expect(store.keys()).toContain("fragments/00000001.jsonl");
    await p.append("s", { n: 2 });
    expect(await p.read("s")).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it("close of an unknown session is a no-op", async () => {
    const p = provider();
    await expect(p.close("missing")).resolves.toBeUndefined();
  });

  it("shares one log instance across load/append/read for the same session", async () => {
    const store = new MemoryCasStore();
    const p = provider(store, { flushThresholdEvents: 1000 });
    await p.load("s");
    await p.append("s", { n: 1 });
    await p.append("s", { n: 2 });
    expect(store.keys().some((k) => k.startsWith("fragments/"))).toBe(false);
    expect(await p.read("s")).toEqual([{ n: 1 }, { n: 2 }]);
  });
});
