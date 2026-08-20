import { describe, expect, it } from "vitest";
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { SessionId } from "@deepseek-ai/dsh-session";
import type { SessionEvent, SessionHeader } from "@deepseek-ai/dsh-session";
import { S3PersistenceBackend } from "../src/backend.js";
import { parseConfig } from "../src/config.js";
import { StaleWriterError } from "../src/errors.js";
import { createProvider } from "../src/provider.js";
import { createS3Client } from "../src/s3log.js";

const enabled = process.env.S3_IT === "1";

type TurnStart = Extract<SessionEvent, { type: "turn/start" }>;

function header(id: string): SessionHeader {
  return { version: 0, id: SessionId(id), createdAt: 1_700_000_000_000, cwd: "/work" };
}

function ev(seq: number, turn = seq): TurnStart {
  return { type: "turn/start", seq, time: 1_700_000_000_000 + seq, data: { turn } };
}

function itEnv() {
  const bucket = process.env.S3_BUCKET;
  const endpoint = process.env.S3_ENDPOINT;
  if (!bucket) throw new Error("S3_BUCKET is required when S3_IT=1");
  const prefix = `dsh-it/${Date.now()}-${Math.random().toString(16).slice(2)}/`;
  const cfg = {
    bucket,
    endpoint,
    region: process.env.S3_REGION ?? "us-east-1",
    prefix,
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    forcePathStyle: true,
  };
  return { bucket, prefix, cfg, client: createS3Client(parseConfig(cfg)) };
}

async function emptyPrefix(client: S3Client, bucket: string, prefix: string): Promise<void> {
  let token: string | undefined;
  do {
    const listed = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
    );
    const objects = (listed.Contents ?? [])
      .map((o) => o.Key)
      .filter((k): k is string => Boolean(k))
      .map((Key) => ({ Key }));
    if (objects.length > 0) {
      await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects } }));
    }
    token = listed.IsTruncated === true ? listed.NextContinuationToken : undefined;
  } while (token);
}

describe.skipIf(!enabled)("MinIO / S3 integration (S3_IT=1)", () => {
  it("round-trips append/read and two library writers contend via CAS", async () => {
    const { bucket, prefix, cfg, client } = itEnv();
    try {
      const a = createProvider({ ...cfg, flushThresholdEvents: 1 });
      const b = createProvider({ ...cfg, flushThresholdEvents: 1 });
      const sessionId = "it-shared";
      await Promise.all([
        a.append(sessionId, { who: "a" }),
        b.append(sessionId, { who: "b" }),
      ]);
      await a.close(sessionId);
      await b.close(sessionId);
      const reader = createProvider({ ...cfg, flushThresholdEvents: 50 });
      const events = await reader.read(sessionId);
      expect(events).toEqual(expect.arrayContaining([{ who: "a" }, { who: "b" }]));
      expect(events.length).toBeGreaterThanOrEqual(2);
      await reader.close(sessionId);
    } finally {
      await emptyPrefix(client, bucket, prefix);
    }
  });

  it("fail-closes a stale DSH writer: one appendBatch wins, the other throws StaleWriterError", async () => {
    const { bucket, prefix, cfg, client } = itEnv();
    const resolved = parseConfig(cfg);
    const a = new S3PersistenceBackend(resolved);
    const b = new S3PersistenceBackend(resolved);
    const meta = header("it-dsh");
    try {
      const results = await Promise.allSettled([
        a.appendBatch(meta, [ev(0, 1)], false),
        b.appendBatch(meta, [ev(0, 99)], false),
      ]);
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(StaleWriterError);
      const stored = await a.loadStored(SessionId("it-dsh"));
      expect(stored?.events).toHaveLength(1);
      expect(stored?.events[0]?.seq).toBe(0);
      const turn = (stored?.events[0] as TurnStart | undefined)?.data.turn;
      expect(turn === 1 || turn === 99).toBe(true);
    } finally {
      await emptyPrefix(client, bucket, prefix);
    }
  });
});
