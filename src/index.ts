export {
  CasConflictError,
  CasRetryExhaustedError,
  ConfigError,
  FragmentCorruptError,
  ManifestCorruptError,
  S3AccessError,
  S3LogError,
} from "./errors.js";
export {
  parseConfig,
  type PluginConfig,
  type ResolvedPluginConfig,
  DEFAULT_FLUSH_BYTES,
  DEFAULT_FLUSH_EVENTS,
  DEFAULT_PREFIX,
  DEFAULT_REGION,
} from "./config.js";
export {
  checkpointKey,
  fragmentKey,
  jsonLine,
  parseFragment,
  serializeFragment,
  sha256Hex,
} from "./fragment.js";
export {
  emptyManifest,
  parseManifest,
  serializeManifest,
  type CheckpointRef,
  type FragmentRef,
  type Manifest,
} from "./manifest.js";
export { casUpdate, prefixStore, type CasStore, type CasUpdateOptions } from "./cas.js";
export {
  createS3CasStore,
  createS3Client,
  isNotFound,
  isPreconditionFailed,
  quoteEtag,
  S3CasStore,
  S3SessionLog,
  type S3SessionLogOptions,
  type S3SessionLogStats,
} from "./s3log.js";
export {
  createProvider,
  type CreateProviderOptions,
  type SessionEvent,
  type SessionPersistenceProvider,
} from "./provider.js";
export {
  S3PersistenceBackend,
  type PersistEvent,
  type PersistHeader,
  type S3TornMarker,
  type SessionLocation,
  type SessionSnapshot,
  type StoredPrefix,
} from "./backend.js";
export {
  S3SessionPersistence,
  S3SessionRuntime,
  type SessionInspection,
} from "./persistence.js";

import { S3SessionPersistence } from "./persistence.js";
import type { PluginConfig } from "./config.js";
import type { Context } from "@deepseek-ai/cordis";

/**
 * Cordis function-plugin entry. Prefer the default class export: Cordis
 * instantiates it as `ctx.sessionPersistence`.
 */
export function apply(ctx: Context, config: PluginConfig): S3SessionPersistence {
  return new S3SessionPersistence(ctx, config);
}

export default S3SessionPersistence;
