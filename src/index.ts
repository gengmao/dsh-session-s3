export {
  createProvider,
  type CreateProviderOptions,
  type SessionEvent,
  type SessionPersistenceProvider,
} from "./provider.js";
export { S3PersistenceBackend, type S3TornMarker } from "./backend.js";
export { S3SessionPersistence } from "./persistence.js";

import { S3SessionPersistence } from "./persistence.js";
import type { PluginConfig } from "./config.js";
import type { Context } from "@deepseek-ai/cordis";

/** Cordis function-plugin entry. Prefer the default class export. */
export function apply(ctx: Context, config: PluginConfig): S3SessionPersistence {
  return new S3SessionPersistence(ctx, config);
}

export default S3SessionPersistence;
