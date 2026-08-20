import { describe, expect, it } from "vitest";
import {
  fragmentKey,
  parseFragment,
  seqFromFragmentKey,
  serializeFragment,
  sha256Hex,
} from "../src/fragment.js";
import { FragmentCorruptError } from "../src/errors.js";

describe("fragment", () => {
  it("round-trips events including unicode", () => {
    const events = [
      { type: "user/message", seq: 0, text: "hello" },
      { type: "assistant/message", seq: 1, text: "你好 👋" },
    ];
    const buf = serializeFragment(events);
    expect(buf.toString("utf8").endsWith("\n")).toBe(true);
    expect(parseFragment(buf)).toEqual(events);
  });

  it("serializes an empty fragment as empty buffer", () => {
    const buf = serializeFragment([]);
    expect(buf.byteLength).toBe(0);
    expect(parseFragment(buf)).toEqual([]);
  });

  it("throws FragmentCorruptError on a corrupt line", () => {
    const buf = Buffer.from('{"ok":true}\n{not json}\n', "utf8");
    expect(() => parseFragment(buf)).toThrow(FragmentCorruptError);
    expect(() => parseFragment(buf)).toThrow(/line 2/);
  });

  it("throws on an empty line in the middle", () => {
    const buf = Buffer.from('{"a":1}\n\n{"b":2}\n', "utf8");
    expect(() => parseFragment(buf)).toThrow(FragmentCorruptError);
  });

  it("pads fragment keys to 8 digits", () => {
    expect(fragmentKey(1)).toBe("fragments/00000001.jsonl");
    expect(fragmentKey(42)).toBe("fragments/00000042.jsonl");
    expect(fragmentKey(12345678)).toBe("fragments/12345678.jsonl");
  });

  it("parses seq out of a fragment object key", () => {
    expect(seqFromFragmentKey("fragments/00000003.jsonl")).toBe(3);
    expect(seqFromFragmentKey("dsh/sessions/x/fragments/00000012.jsonl")).toBe(12);
    expect(seqFromFragmentKey("manifest.json")).toBeNull();
  });

  it("rejects non-positive fragment seq", () => {
    expect(() => fragmentKey(0)).toThrow(FragmentCorruptError);
    expect(() => fragmentKey(1.5)).toThrow(FragmentCorruptError);
  });

  it("throws when JSON.stringify yields undefined (functions, undefined)", () => {
    expect(() => serializeFragment([undefined])).toThrow(FragmentCorruptError);
    expect(() => serializeFragment([() => 1])).toThrow(/not JSON-serializable/);
  });

  it("computes a stable sha256", () => {
    const buf = serializeFragment([{ n: 1 }]);
    expect(sha256Hex(buf)).toBe(sha256Hex(Buffer.from(buf)));
    expect(sha256Hex(buf)).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Hex(buf)).not.toBe(sha256Hex(serializeFragment([{ n: 2 }])));
  });

  it("stamped fragments parse back to the same events and do not share a digest", () => {
    const events = [{ type: "user/message", text: "hi" }];
    const a = serializeFragment(events, { unique: true });
    const b = serializeFragment(events, { unique: true });
    expect(parseFragment(a)).toEqual(events);
    expect(parseFragment(b)).toEqual(events);
    expect(sha256Hex(a)).not.toBe(sha256Hex(b));
  });
});
