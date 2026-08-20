import { CasConflictError, CasRetryExhaustedError } from "./errors.js";

export interface CasStore {
  get(key: string): Promise<{ body: Buffer; etag: string } | null>;
  putIfAbsent(key: string, body: Buffer): Promise<string>;
  putIfMatch(key: string, body: Buffer, etag: string): Promise<string>;
  delete(key: string): Promise<void>;
  /** Keys relative to this store, optionally filtered by prefix. */
  listKeys(prefix?: string): Promise<string[]>;
  /** Immediate child prefixes (trailing slash) under `prefix`. */
  listPrefixes(prefix?: string): Promise<string[]>;
}

export function prefixStore(inner: CasStore, prefix: string): CasStore {
  const p = prefix.endsWith("/") || prefix.length === 0 ? prefix : `${prefix}/`;
  const rel = (key: string) => `${p}${key.replace(/^\/+/, "")}`;
  return {
    get: (key) => inner.get(rel(key)),
    putIfAbsent: (key, body) => inner.putIfAbsent(rel(key), body),
    putIfMatch: (key, body, etag) => inner.putIfMatch(rel(key), body, etag),
    delete: (key) => inner.delete(rel(key)),
    listKeys: async (sub = "") => {
      const keys = await inner.listKeys(rel(sub));
      return keys.map((key) => (key.startsWith(p) ? key.slice(p.length) : key));
    },
    listPrefixes: async (sub = "") => {
      const prefixes = await inner.listPrefixes(rel(sub));
      return prefixes.map((key) => (key.startsWith(p) ? key.slice(p.length) : key));
    },
  };
}

export interface CasUpdateOptions {
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /**
   * First-attempt snapshot so the uncontended path can skip a GET.
   * `null` means known-absent (putIfAbsent). After a 412, casUpdate reloads.
   */
  known?: { body: Buffer; etag: string } | null;
}

const DEFAULT_MAX_RETRIES = 10;

export async function defaultSleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt: number, random: () => number): number {
  const base = 25 * 2 ** attempt;
  const jitter = Math.floor(random() * 25);
  return base + jitter;
}

export async function casUpdate<T>(
  store: CasStore,
  key: string,
  mutate: (current: T | null) => T,
  parse: (body: Buffer) => T,
  serialize: (value: T) => Buffer,
  opts?: CasUpdateOptions,
): Promise<{ value: T; etag: string }> {
  const maxRetries = opts?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const sleep = opts?.sleep ?? defaultSleep;
  const random = opts?.random ?? Math.random;

  let lastError: unknown;
  let snapshot: { body: Buffer; etag: string } | null | undefined = opts?.known;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const current = snapshot !== undefined ? snapshot : await store.get(key);
      snapshot = undefined;
      const value = mutate(current ? parse(current.body) : null);
      const body = serialize(value);
      const etag = current
        ? await store.putIfMatch(key, body, current.etag)
        : await store.putIfAbsent(key, body);
      return { value, etag };
    } catch (error) {
      lastError = error;
      if (!(error instanceof CasConflictError)) throw error;
      if (attempt === maxRetries) break;
      await sleep(backoffMs(attempt, random));
    }
  }
  const exhausted = new CasRetryExhaustedError(key, maxRetries + 1);
  if (lastError instanceof Error) exhausted.cause = lastError;
  throw exhausted;
}
