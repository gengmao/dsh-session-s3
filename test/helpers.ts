import { CasConflictError } from "../src/errors.js";
import type { CasStore } from "../src/cas.js";

export class MemoryCasStore implements CasStore {
  readonly objects = new Map<string, { body: Buffer; etag: string }>();
  failNextPutIfAbsent = 0;
  failNextPutIfMatch = 0;
  /** After a successful fragment putIfAbsent, throw (models crash before CAS). */
  crashAfterFragmentPut = false;
  /** After a successful conditional PUT, throw (models lost CAS response). */
  crashAfterSuccessfulConditionalPut = false;
  /** Run once after a successful fragment PUT, before the caller continues to CAS. */
  afterFragmentPut: (() => Promise<void>) | null = null;
  getCount = 0;
  putCount = 0;
  private seq = 0;
  private readonly delayMs: number;

  constructor(opts?: { delayMs?: number }) {
    this.delayMs = opts?.delayMs ?? 0;
  }

  async get(key: string): Promise<{ body: Buffer; etag: string } | null> {
    await this.tick();
    this.getCount += 1;
    const hit = this.objects.get(key);
    if (!hit) return null;
    return { body: Buffer.from(hit.body), etag: hit.etag };
  }

  async putIfAbsent(key: string, body: Buffer): Promise<string> {
    await this.tick();
    if (this.failNextPutIfAbsent > 0) {
      this.failNextPutIfAbsent -= 1;
      throw new CasConflictError(`injected 412 on putIfAbsent ${key}`);
    }
    if (this.objects.has(key)) {
      throw new CasConflictError(`412 If-None-Match on ${key}`);
    }
    const etag = this.nextEtag();
    this.objects.set(key, { body: Buffer.from(body), etag });
    this.putCount += 1;
    if (this.crashAfterFragmentPut && /(?:^|\/)fragments\/\d+\.jsonl$/.test(key)) {
      this.crashAfterFragmentPut = false;
      throw new Error("simulated crash after fragment PUT, before manifest CAS");
    }
    if (this.afterFragmentPut && /(?:^|\/)fragments\/\d+\.jsonl$/.test(key)) {
      const hook = this.afterFragmentPut;
      this.afterFragmentPut = null;
      await hook();
    }
    if (this.crashAfterSuccessfulConditionalPut && /(?:^|\/)manifest\.json$/.test(key)) {
      this.crashAfterSuccessfulConditionalPut = false;
      throw new Error("simulated lost CAS response");
    }
    return etag;
  }

  async putIfMatch(key: string, body: Buffer, etag: string): Promise<string> {
    await this.tick();
    if (this.failNextPutIfMatch > 0) {
      this.failNextPutIfMatch -= 1;
      throw new CasConflictError(`injected 412 on putIfMatch ${key}`);
    }
    const cur = this.objects.get(key);
    if (!cur || cur.etag !== etag) {
      throw new CasConflictError(`412 If-Match on ${key}`);
    }
    const next = this.nextEtag();
    this.objects.set(key, { body: Buffer.from(body), etag: next });
    this.putCount += 1;
    if (this.crashAfterSuccessfulConditionalPut && /(?:^|\/)manifest\.json$/.test(key)) {
      this.crashAfterSuccessfulConditionalPut = false;
      throw new Error("simulated lost CAS response");
    }
    return next;
  }

  async delete(key: string): Promise<void> {
    await this.tick();
    this.objects.delete(key);
  }

  keys(): string[] {
    return [...this.objects.keys()].sort();
  }

  async listKeys(prefix = ""): Promise<string[]> {
    await this.tick();
    return this.keys().filter((key) => key.startsWith(prefix));
  }

  /** Overwrite bytes in place (same etag) — models bitrot / a torn object. */
  smash(key: string, body: Buffer): void {
    const cur = this.objects.get(key);
    if (!cur) throw new Error(`smash: missing ${key}`);
    this.objects.set(key, { body: Buffer.from(body), etag: cur.etag });
  }

  private nextEtag(): string {
    this.seq += 1;
    return `etag-${this.seq}`;
  }

  private async tick(): Promise<void> {
    if (this.delayMs > 0) {
      await new Promise((r) => setTimeout(r, this.delayMs));
    }
  }
}

export const fastCas = {
  sleep: async () => undefined,
  random: () => 0,
};
