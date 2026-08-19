import { describe, expect, it } from "vitest";
import {
  emptyManifest,
  parseManifest,
  serializeManifest,
  type Manifest,
} from "../src/manifest.js";
import { ManifestCorruptError } from "../src/errors.js";

const sha = "a".repeat(64);

function sample(): Manifest {
  return {
    version: 1,
    session_id: "s1",
    fragments: [
      { seq: 1, key: "fragments/00000001.jsonl", bytes: 10, sha256: sha, events: 2 },
      { seq: 2, key: "fragments/00000002.jsonl", bytes: 5, sha256: sha, events: 1 },
    ],
    total_events: 3,
    total_bytes: 15,
    checkpoint: { at_seq: 1, blob: "checkpoints/cp-00000001.json", sha256: sha },
    updated_at: "2026-08-19T00:00:00.000Z",
  };
}

describe("manifest", () => {
  it("creates an empty manifest", () => {
    const m = emptyManifest("abc");
    expect(m.version).toBe(1);
    expect(m.session_id).toBe("abc");
    expect(m.fragments).toEqual([]);
    expect(m.total_events).toBe(0);
    expect(m.total_bytes).toBe(0);
    expect(m.checkpoint).toBeNull();
    expect(m.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("round-trips a populated manifest", () => {
    const original = sample();
    expect(parseManifest(serializeManifest(original))).toEqual(original);
  });

  it("round-trips checkpoint: null", () => {
    const original = { ...sample(), checkpoint: null };
    expect(parseManifest(serializeManifest(original)).checkpoint).toBeNull();
  });

  it("throws on invalid json", () => {
    expect(() => parseManifest("{nope")).toThrow(ManifestCorruptError);
    expect(() => parseManifest("{nope")).toThrow(/not valid JSON/);
  });

  it("throws on missing required fields", () => {
    expect(() => parseManifest("{}")).toThrow(ManifestCorruptError);
    expect(() => parseManifest("{}")).toThrow(/schema invalid/);
  });

  it("throws on wrong version", () => {
    const m = sample() as unknown as Record<string, unknown>;
    m.version = 2;
    expect(() => parseManifest(JSON.stringify(m))).toThrow(ManifestCorruptError);
  });

  it("throws when fragments are not ascending by seq", () => {
    const m = sample();
    m.fragments = [
      { seq: 2, key: "fragments/00000002.jsonl", bytes: 1, sha256: sha, events: 1 },
      { seq: 1, key: "fragments/00000001.jsonl", bytes: 1, sha256: sha, events: 1 },
    ];
    expect(() => parseManifest(serializeManifest(m))).toThrow(/ordered ascending/);
  });

  it("rejects a bad sha256", () => {
    const m = sample();
    m.fragments[0]!.sha256 = "not-a-hash";
    expect(() => parseManifest(serializeManifest(m))).toThrow(ManifestCorruptError);
  });
});
