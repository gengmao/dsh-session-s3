import { describe, expect, it } from "vitest";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import {
  isNotFound,
  isPreconditionFailed,
  quoteEtag,
  S3CasStore,
} from "../src/s3log.js";
import { CasConflictError, S3AccessError } from "../src/errors.js";

class FakeError extends Error {
  $metadata: { httpStatusCode?: number };
  Code?: string;
  constructor(name: string, status: number, code?: string) {
    super(name);
    this.name = name;
    this.$metadata = { httpStatusCode: status };
    this.Code = code;
  }
}

interface CapturedPut {
  Key?: string;
  IfMatch?: string;
  IfNoneMatch?: string;
}

function fakeClient(handler: (cmd: unknown) => Promise<unknown>): S3Client {
  return { send: (cmd: unknown) => handler(cmd) } as S3Client;
}

describe("quoteEtag / error classifiers", () => {
  it("quotes bare etags and leaves already-quoted / * alone", () => {
    expect(quoteEtag("abc")).toBe('"abc"');
    expect(quoteEtag('"abc"')).toBe('"abc"');
    expect(quoteEtag('W/"abc"')).toBe('W/"abc"');
    expect(quoteEtag("*")).toBe("*");
    expect(quoteEtag("")).toBe("");
    expect(quoteEtag(undefined)).toBe("");
  });

  it("classifies 404 / NoSuchKey as not found", () => {
    expect(isNotFound(new FakeError("NoSuchKey", 404, "NoSuchKey"))).toBe(true);
    expect(isNotFound(new FakeError("NotFound", 404))).toBe(true);
    expect(isNotFound(new FakeError("Boom", 500))).toBe(false);
  });

  it("classifies 412 / PreconditionFailed", () => {
    expect(isPreconditionFailed(new FakeError("PreconditionFailed", 412, "PreconditionFailed"))).toBe(
      true,
    );
    expect(isPreconditionFailed(new FakeError("Error", 412))).toBe(true);
    expect(isPreconditionFailed(new FakeError("Error", 500))).toBe(false);
  });
});

describe("S3CasStore", () => {
  it("GET 404 returns null", async () => {
    const store = new S3CasStore(
      fakeClient(async () => {
        throw new FakeError("NoSuchKey", 404, "NoSuchKey");
      }),
      "bucket",
      "dsh/",
    );
    expect(await store.get("manifest.json")).toBeNull();
  });

  it("GET returns body and a quoted etag", async () => {
    const store = new S3CasStore(
      fakeClient(async () => ({
        ETag: '"deadbeef"',
        Body: { transformToByteArray: async () => new Uint8Array(Buffer.from("hi")) },
      })),
      "bucket",
      "dsh/",
    );
    const got = await store.get("manifest.json");
    expect(got?.body.toString()).toBe("hi");
    expect(got?.etag).toBe('"deadbeef"');
  });

  it("PUT If-None-Match * on create; If-Match is quoted", async () => {
    const captured: CapturedPut[] = [];
    const store = new S3CasStore(
      fakeClient(async (cmd) => {
        if (cmd instanceof PutObjectCommand) {
          captured.push({
            Key: cmd.input.Key,
            IfMatch: cmd.input.IfMatch,
            IfNoneMatch: cmd.input.IfNoneMatch,
          });
          return { ETag: '"etag-1"' };
        }
        throw new Error(`unexpected ${cmd?.constructor?.name}`);
      }),
      "bucket",
      "dsh/",
    );
    await store.putIfAbsent("manifest.json", Buffer.from("{}"));
    await store.putIfMatch("manifest.json", Buffer.from("{}"), "etag-1");
    expect(captured[0]).toMatchObject({
      Key: "dsh/manifest.json",
      IfNoneMatch: "*",
    });
    expect(captured[1]?.IfMatch).toBe('"etag-1"');
  });

  it("PUT 412 becomes CasConflictError", async () => {
    const store = new S3CasStore(
      fakeClient(async () => {
        throw new FakeError("PreconditionFailed", 412, "PreconditionFailed");
      }),
      "bucket",
      "p/",
    );
    await expect(store.putIfAbsent("k", Buffer.from("x"))).rejects.toBeInstanceOf(CasConflictError);
    await expect(store.putIfMatch("k", Buffer.from("x"), '"e"')).rejects.toBeInstanceOf(
      CasConflictError,
    );
  });

  it("PUT 500 becomes S3AccessError", async () => {
    const store = new S3CasStore(
      fakeClient(async () => {
        throw new FakeError("InternalError", 500);
      }),
      "bucket",
      "p/",
    );
    await expect(store.putIfAbsent("k", Buffer.from("x"))).rejects.toBeInstanceOf(S3AccessError);
  });

  it("DELETE 404 is ignored", async () => {
    const store = new S3CasStore(
      fakeClient(async (cmd) => {
        if (cmd instanceof DeleteObjectCommand) throw new FakeError("NoSuchKey", 404, "NoSuchKey");
        throw new Error("unexpected");
      }),
      "bucket",
      "p/",
    );
    await expect(store.delete("gone")).resolves.toBeUndefined();
  });

  it("listKeys pages and strips the store prefix", async () => {
    let calls = 0;
    const store = new S3CasStore(
      fakeClient(async (cmd) => {
        if (!(cmd instanceof ListObjectsV2Command)) throw new Error("expected list");
        calls += 1;
        if (calls === 1) {
          return {
            Contents: [{ Key: "dsh/sessions/a/manifest.json" }],
            IsTruncated: true,
            NextContinuationToken: "tok",
          };
        }
        return { Contents: [{ Key: "dsh/sessions/b/manifest.json" }], IsTruncated: false };
      }),
      "bucket",
      "dsh/",
    );
    expect(await store.listKeys("sessions/")).toEqual([
      "sessions/a/manifest.json",
      "sessions/b/manifest.json",
    ]);
    expect(calls).toBe(2);
  });

  it("GET 500 surfaces as S3AccessError", async () => {
    const store = new S3CasStore(
      fakeClient(async (cmd) => {
        if (cmd instanceof GetObjectCommand) throw new FakeError("SlowDown", 500);
        throw new Error("unexpected");
      }),
      "bucket",
      "p/",
    );
    await expect(store.get("x")).rejects.toBeInstanceOf(S3AccessError);
  });
});
