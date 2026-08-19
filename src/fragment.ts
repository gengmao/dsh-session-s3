import { createHash } from "node:crypto";
import { FragmentCorruptError } from "./errors.js";

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

export function serializeFragment(events: readonly unknown[]): Buffer {
  if (events.length === 0) return Buffer.alloc(0);
  const lines = events.map((event, index) => jsonLine(event, index));
  return Buffer.from(`${lines.join("\n")}\n`, "utf8");
}

export function parseFragment(buf: Buffer): unknown[] {
  const text = buf.toString("utf8");
  if (text.length === 0) return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const events: unknown[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    try {
      events.push(JSON.parse(line));
    } catch (cause) {
      throw new FragmentCorruptError(`fragment line ${i + 1} is not valid JSON`, { cause });
    }
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

export function checkpointKey(seq: number): string {
  if (!Number.isInteger(seq) || seq < 0) {
    throw new FragmentCorruptError(`checkpoint seq must be a non-negative integer, got ${seq}`);
  }
  return `checkpoints/cp-${seq.toString().padStart(8, "0")}.json`;
}
