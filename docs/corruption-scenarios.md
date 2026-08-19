# 7 DSH JSONL corruption scenarios vs wal3-Lite

Field-confirmed session-log corruption in
[`dsh-session-persistence-jsonl`](https://github.com/deepseek-ai/deepseek-harness),
replayed against this plugin. Tests: `test/corruption-scenarios.test.ts`.

JSONL concatenates every writer into **one** `session.jsonl[.zstd]` and the
scanner requires `events[i].seq === i`. A seq rewind in the committed region
makes the **entire session unloadable**. wal3-Lite never mutates a fragment and
commits writers through a single CAS `manifest.json`, so the durable prefix
stays readable.

| # | Discussion | JSONL failure | wal3-Lite |
| --- | --- | --- | --- |
| 1 | [#1333](https://github.com/deepseek-ai/deepseek-harness/discussions/1333) cross-process seq | Two processes assign `seq = log.length`; overlapping seqs, load refuses | Two fragments via CAS; log parses; payload seq dups are visible, not fatal |
| 2 | [#1452](https://github.com/deepseek-ai/deepseek-harness/discussions/1452) multi-process write | Duplicate batches in one file: `expected N, got N-4` | Stale writer lands a **new** fragment; prefix intact |
| 3 | [#1497](https://github.com/deepseek-ai/deepseek-harness/discussions/1497) torn tail | Crash mid-append tears the same file as the prefix | Crash after fragment PUT / before manifest CAS → orphan ignored; prefix intact |
| 4 | [#1473](https://github.com/deepseek-ai/deepseek-harness/discussions/1473) list poison | One bad first-frame throws out of `list()`, workspace boot dies | Per-session S3 prefix; sibling session still reads; only the bad id throws |
| 5 | [#1586](https://github.com/deepseek-ai/deepseek-harness/discussions/1586) recovery vs legacy writer | Synthetic closers + live results reuse seq in one file | Both batches stored as separate fragments; readable |
| 6 | [#2167](https://github.com/deepseek-ai/deepseek-harness/discussions/2167) stale-view re-append | Resume re-appends last 4 committed events | Re-append is a new fragment; original 4 bytes unchanged |
| 7 | [#2342](https://github.com/deepseek-ai/deepseek-harness/discussions/2342) repair vs live writer | `commitRepair` injects `step/end`+`turn/end` under a live writer | Repair and live chunks are distinct objects; live tokens preserved |

## What this plugin actually fixes

Storage-layer: torn writes, missing fsync (S3 PutObject durability), and
same-session concurrent flush. Fragments are immutable; the manifest is the
only compare-and-swap point.

## What this plugin does not fix

Payload `SessionEvent.seq` is still assigned by the DSH coordinator from
in-memory `log.length`. Two writers can still *emit* colliding seqs. wal3-Lite
will store both. A drop-in `SessionPersistence` backend should additionally
**reject** an append whose first event seq does not equal the stored next-seq
(the contract `append` already documents). That check belongs in the
coordinator seam, not in fragment hashing.

Until that seam is wired, colliding payload seqs are **detectable** (`seq`
rewinds in `readAll()`) and **not fatal** (the session still loads).
