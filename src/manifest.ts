import { z } from "zod";
import { ManifestCorruptError } from "./errors.js";

const sessionHeaderSchema = z
  .object({
    version: z.number(),
    id: z.string().min(1),
    createdAt: z.number().int().nonnegative(),
  })
  .passthrough();

const fragmentRefSchema = z.object({
  seq: z.number().int().positive(),
  key: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  events: z.number().int().nonnegative(),
});

const checkpointRefSchema = z.object({
  at_seq: z.number().int().nonnegative(),
  blob: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

const manifestSchema = z.object({
  version: z.literal(1),
  session_id: z.string().min(1),
  header: sessionHeaderSchema.nullable().optional(),
  fragments: z.array(fragmentRefSchema),
  total_events: z.number().int().nonnegative(),
  total_bytes: z.number().int().nonnegative(),
  checkpoint: checkpointRefSchema.nullable(),
  updated_at: z.string().min(1),
});

export type FragmentRef = z.infer<typeof fragmentRefSchema>;
export type CheckpointRef = z.infer<typeof checkpointRefSchema>;
export type Manifest = z.infer<typeof manifestSchema>;

export function emptyManifest(sessionId: string): Manifest {
  return {
    version: 1,
    session_id: sessionId,
    header: null,
    fragments: [],
    total_events: 0,
    total_bytes: 0,
    checkpoint: null,
    updated_at: new Date().toISOString(),
  };
}

export function parseManifest(json: string): Manifest {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (cause) {
    throw new ManifestCorruptError("manifest.json is not valid JSON", { cause });
  }
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "manifest"}: ${issue.message}`)
      .join("; ");
    throw new ManifestCorruptError(`manifest.json schema invalid: ${details}`);
  }
  const manifest = parsed.data;
  const seqs = manifest.fragments.map((f) => f.seq);
  for (let i = 1; i < seqs.length; i++) {
    if (seqs[i]! <= seqs[i - 1]!) {
      throw new ManifestCorruptError("manifest fragments must be ordered ascending by seq");
    }
  }
  return manifest;
}

export function serializeManifest(manifest: Manifest): string {
  return JSON.stringify(manifest);
}

export function parseManifestBuffer(buf: Buffer): Manifest {
  return parseManifest(buf.toString("utf8"));
}

export function serializeManifestBuffer(manifest: Manifest): Buffer {
  return Buffer.from(serializeManifest(manifest), "utf8");
}
