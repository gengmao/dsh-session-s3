import { describe, expect, it } from "vitest";
import { createProvider } from "../src/provider.js";

const enabled = process.env.S3_IT === "1";

describe.skipIf(!enabled)("MinIO / S3 integration (S3_IT=1)", () => {
  it("round-trips append/read against a real bucket", async () => {
    const bucket = process.env.S3_BUCKET;
    const endpoint = process.env.S3_ENDPOINT;
    if (!bucket) throw new Error("S3_BUCKET is required when S3_IT=1");

    const provider = createProvider({
      bucket,
      endpoint,
      region: process.env.S3_REGION ?? "auto",
      prefix: process.env.S3_PREFIX ?? "dsh-it/",
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      forcePathStyle: true,
      flushThresholdEvents: 2,
    });

    const sessionId = `it-${Date.now()}`;
    await provider.append(sessionId, { n: 1 });
    await provider.append(sessionId, { n: 2 });
    const events = await provider.read(sessionId);
    expect(events).toEqual([{ n: 1 }, { n: 2 }]);
    await provider.close(sessionId);
  });
});
