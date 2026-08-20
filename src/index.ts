export {
  CasConflictError,
  CasRetryExhaustedError,
  ConfigError,
  FragmentCorruptError,
  ManifestCorruptError,
  S3AccessError,
  S3LogError,
  StaleFragmentSeqError,
  StaleWriterError,
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
  seqFromFragmentKey,
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
  appendFragmentRef,
  createS3CasStore,
  createS3Client,
  isNotFound,
  isPreconditionFailed,
  nextFreeFragmentSeq,
  publishFragment,
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
export { S3PersistenceBackend, type S3TornMarker } from "./backend.js";
export { S3SessionPersistence } from "./persistence.js";

import "./polyfill.js";
import { S3SessionPersistence } from "./persistence.js";
import type { PluginConfig } from "./config.js";
import type { Context } from "@deepseek-ai/cordis";

/** Cordis function-plugin entry. Prefer the default class export. */
export function apply(ctx: Context, config: PluginConfig): S3SessionPersistence {
  return new S3SessionPersistence(ctx, config);
}

export default S3SessionPersistence;
