// Create the S3 integration-test bucket on the local MinIO. Idempotent.
import { S3Client, CreateBucketCommand } from "@aws-sdk/client-s3";

const endpoint = process.env.S3_ENDPOINT ?? "http://127.0.0.1:9000";
const bucket = process.env.S3_BUCKET ?? "test";

const client = new S3Client({
  region: process.env.S3_REGION ?? "us-east-1",
  endpoint,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "minioadmin",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "minioadmin",
  },
});

try {
  await client.send(new CreateBucketCommand({ Bucket: bucket }));
  console.log(`Created bucket ${bucket}`);
} catch (error) {
  const name = error instanceof Error ? error.name : "";
  const status = error && error.$metadata ? error.$metadata.httpStatusCode : undefined;
  if (name !== "BucketAlreadyOwnedByYou" && name !== "BucketAlreadyExists" && status !== 409) {
    throw error;
  }
  console.log(`Bucket ${bucket} already exists`);
}
