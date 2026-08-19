import { CasConflictError, CasRetryExhaustedError } from "./errors.js";

export interface CasStore {
  get(key: string): Promise<{ body: Buffer; etag: string } | null>;
  putIfAbsent(key: string, body: Buffer): Promise<string>;
  putIfMatch(key: string, body: Buffer, etag: string): Promise<string>;
  delete(key: string): Promise<void>;
}

export interface CasUpdateOptions {
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
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
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const existing = await store.get(key);
      const current = existing ? parse(existing.body) : null;
      const next = mutate(current);
      const body = serialize(next);
      const etag = existing
        ? await store.putIfMatch(key, body, existing.etag)
        : await store.putIfAbsent(key, body);
      return { value: next, etag };
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
