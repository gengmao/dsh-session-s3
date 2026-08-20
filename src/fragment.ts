import { createHash, randomBytes } from "node:crypto";
import { FragmentCorruptError } from "./errors.js";

const WAL_HEADER_KEY = "_dsh_frag";

export function jsonLine(event: unknown, index = 0): string {
  let json: string | undefined;
  try {
    json = JSON.stringify(event);
  } catch (cause) {
    throw new FragmentCorruptError(`event ${index} is not JSON-serializable`, { cause });
  }
  if (typeof json !== "string") {
    throw new FragmentCorruptError(`event ${index} is not JSON-serializable`);
  }
  return json;
}

export function serializeFragment(
  events: readonly unknown[],
  opts?: { unique?: boolean },
): Buffer {
  if (events.length === 0) return Buffer.alloc(0);
  const lines = events.map((event, index) => jsonLine(event, index));
  if (opts?.unique) {
    const header = JSON.stringify({
      [WAL_HEADER_KEY]: 1,
      ts: Date.now(),
      nonce: randomBytes(8).toString("hex"),
    });
    return Buffer.from(`${header}\n${lines.join("\n")}\n`, "utf8");
  }
  return Buffer.from(`${lines.join("\n")}\n`, "utf8");
}

function isWalHeader(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>)[WAL_HEADER_KEY] === 1
  );
}

export function parseFragment(buf: Buffer): unknown[] {
  const text = buf.toString("utf8");
  if (text.length === 0) return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const events: unknown[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (cause) {
      throw new FragmentCorruptError(`fragment line ${i + 1} is not valid JSON`, { cause });
    }
    if (i === 0 && isWalHeader(parsed)) continue;
    events.push(parsed);
  }
  return events;
}

export function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

export function fragmentKey(seq: number): string {
  if (!Number.isInteger(seq) || seq < 1) {
    throw new FragmentCorruptError(`fragment seq must be a positive integer, got ${seq}`);
  }
  return `fragments/${seq.toString().padStart(8, "0")}.jsonl`;
}

/** Parse `fragments/00000003.jsonl` (optionally prefixed). */
export function seqFromFragmentKey(key: string): number | null {
  const match = /(?:^|\/)fragments\/(\d+)\.jsonl$/.exec(key);
  if (!match) return null;
  const seq = Number(match[1]);
  return Number.isInteger(seq) && seq >= 1 ? seq : null;
}
