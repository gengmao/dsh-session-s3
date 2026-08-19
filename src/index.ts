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
export { casUpdate, type CasStore, type CasUpdateOptions } from "./cas.js";
export {
  createS3CasStore,
  createS3Client,
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

import { createProvider, type SessionPersistenceProvider } from "./provider.js";
import type { PluginConfig } from "./config.js";

export interface CordisLikeContext {
  [key: string]: unknown;
}

/**
 * Cordis / DSH plugin entry. Validates config loudly and exposes the
 * SessionPersistence provider on the context as `sessionPersistenceS3`.
 *
 * The exact upstream `SessionPersistence` abstract class (locate/create/
 * prepare/inspect/list) is NOT wired here — see README. Reconcile against
 * `@deepseek-ai/dsh-session-persistence` before swapping this in for jsonl.
 */
export function apply(ctx: CordisLikeContext, config: PluginConfig): SessionPersistenceProvider {
  const provider = createProvider(config);
  ctx.sessionPersistenceS3 = provider;
  return provider;
}

export default apply;
