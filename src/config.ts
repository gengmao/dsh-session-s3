import { z } from "zod";
import { ConfigError } from "./errors.js";

const pluginConfigSchema = z
  .object({
    bucket: z.string().min(1, "bucket is required"),
    prefix: z.string().min(1).optional(),
    region: z.string().min(1).optional(),
    endpoint: z.string().min(1).optional(),
    forcePathStyle: z.boolean().optional(),
    accessKeyId: z.string().min(1).optional(),
    secretAccessKey: z.string().min(1).optional(),
    flushThresholdEvents: z.number().int().positive().optional(),
    flushThresholdBytes: z.number().int().positive().optional(),
    preparedSessionCacheSize: z.number().int().positive().optional(),
    writeBatchMaxDelayMs: z.number().int().positive().optional(),
  })
  .strict();

export type PluginConfig = z.infer<typeof pluginConfigSchema>;

export interface ResolvedPluginConfig {
  bucket: string;
  prefix: string;
  region: string;
  endpoint?: string;
  forcePathStyle: boolean;
  accessKeyId?: string;
  secretAccessKey?: string;
  flushThresholdEvents: number;
  flushThresholdBytes: number;
  preparedSessionCacheSize?: number;
  writeBatchMaxDelayMs?: number;
}

export const DEFAULT_PREFIX = "dsh/";
export const DEFAULT_REGION = "auto";
export const DEFAULT_FLUSH_EVENTS = 50;
export const DEFAULT_FLUSH_BYTES = 262144;

function collectZodIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.join(".") || "config";
    return `${path}: ${issue.message}`;
  });
}

export function parseConfig(input: unknown): ResolvedPluginConfig {
  const parsed = pluginConfigSchema.safeParse(input ?? {});
  if (!parsed.success) {
    throw new ConfigError(collectZodIssues(parsed.error));
  }

  const issues: string[] = [];
  const cfg = parsed.data;

  if (cfg.accessKeyId && !cfg.secretAccessKey) {
    issues.push("secretAccessKey: required when accessKeyId is set");
  }
  if (cfg.secretAccessKey && !cfg.accessKeyId) {
    issues.push("accessKeyId: required when secretAccessKey is set");
  }
  if (cfg.endpoint) {
    try {
      const url = new URL(cfg.endpoint);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        issues.push("endpoint: must be an http(s) URL");
      }
    } catch {
      issues.push("endpoint: must be a valid URL");
    }
  }
  if (issues.length > 0) throw new ConfigError(issues);

  const endpoint = cfg.endpoint;
  const forcePathStyle = cfg.forcePathStyle ?? Boolean(endpoint);

  return {
    bucket: cfg.bucket,
    prefix: normalizePrefix(cfg.prefix ?? DEFAULT_PREFIX),
    region: cfg.region ?? DEFAULT_REGION,
    endpoint,
    forcePathStyle,
    accessKeyId: cfg.accessKeyId ?? process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: cfg.secretAccessKey ?? process.env.AWS_SECRET_ACCESS_KEY,
    flushThresholdEvents: cfg.flushThresholdEvents ?? DEFAULT_FLUSH_EVENTS,
    flushThresholdBytes: cfg.flushThresholdBytes ?? DEFAULT_FLUSH_BYTES,
    preparedSessionCacheSize: cfg.preparedSessionCacheSize,
    writeBatchMaxDelayMs: cfg.writeBatchMaxDelayMs,
  };
}

export function normalizePrefix(prefix: string): string {
  const trimmed = prefix.replace(/^\/+/, "").replace(/\/+$/, "");
  return trimmed.length === 0 ? "dsh/" : `${trimmed}/`;
}

export function sessionKeyPrefix(prefix: string, sessionId: string): string {
  return `${normalizePrefix(prefix)}sessions/${sessionId}/`;
}
