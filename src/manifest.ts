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

const manifestSchema = z.object({
  version: z.literal(1),
  session_id: z.string().min(1),
  header: z.unknown().nullable().optional(),
  fragments: z.array(fragmentRefSchema),
  total_events: z.number().int().nonnegative(),
  total_bytes: z.number().int().nonnegative(),
  next_event_seq: z.number().int().nonnegative().optional(),
  updated_at: z.string().min(1),
});

export type FragmentRef = z.infer<typeof fragmentRefSchema>;
export type SessionHeaderFields = z.infer<typeof sessionHeaderSchema>;
export type Manifest = Omit<z.infer<typeof manifestSchema>, "header"> & {
  header: SessionHeaderFields | null;
};

export function emptyManifest(sessionId: string): Manifest {
  return {
    version: 1,
    session_id: sessionId,
    header: null,
    fragments: [],
    total_events: 0,
    total_bytes: 0,
    next_event_seq: 0,
    updated_at: new Date().toISOString(),
  };
}

/** DSH event-seq watermark. Trim must not decrease this. */
export function eventSeqWatermark(manifest: Manifest): number {
  return manifest.next_event_seq ?? manifest.total_events;
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
  const data = parsed.data;
  const seqs = data.fragments.map((f) => f.seq);
  for (let i = 1; i < seqs.length; i++) {
    if (seqs[i]! <= seqs[i - 1]!) {
      throw new ManifestCorruptError("manifest fragments must be ordered ascending by seq");
    }
  }
  let header: SessionHeaderFields | null = null;
  if (data.header != null) {
    const h = sessionHeaderSchema.safeParse(data.header);
    if (h.success) header = h.data;
  }
  return { ...data, header };
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
