import { describe, expect, it } from "vitest";
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { createProvider } from "../src/provider.js";
import { parseConfig } from "../src/config.js";
import { createS3Client } from "../src/s3log.js";

const enabled = process.env.S3_IT === "1";

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
  it("round-trips append/read and two writers contend via CAS", async () => {
    const bucket = process.env.S3_BUCKET;
    const endpoint = process.env.S3_ENDPOINT;
    if (!bucket) throw new Error("S3_BUCKET is required when S3_IT=1");

    const prefix = `dsh-it/${Date.now()}/`;
    const cfg = {
      bucket,
      endpoint,
      region: process.env.S3_REGION ?? "auto",
      prefix,
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      forcePathStyle: true,
      flushThresholdEvents: 1,
    };
    const client = createS3Client(parseConfig(cfg));

    try {
      const a = createProvider(cfg);
      const b = createProvider(cfg);
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
});
