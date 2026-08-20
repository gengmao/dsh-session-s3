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
| 1 | [#1333](https://github.com/deepseek-ai/deepseek-harness/discussions/1333) cross-process seq | Two processes assign `seq = log.length`; overlapping seqs, load refuses | Two fragments via CAS; log parses; payload seq dups are visible, not fatal at the storage layer |
| 2 | [#1452](https://github.com/deepseek-ai/deepseek-harness/discussions/1452) multi-process write | Duplicate batches in one file: `expected N, got N-4` | Stale writer lands a **new** fragment; prefix intact |
| 3 | [#1497](https://github.com/deepseek-ai/deepseek-harness/discussions/1497) torn tail | Crash mid-append tears the same file as the prefix | Crash after fragment PUT / before manifest CAS → orphan ignored; prefix intact |
| 4 | [#1473](https://github.com/deepseek-ai/deepseek-harness/discussions/1473) list poison | One bad first-frame throws out of `list()`, workspace boot dies | `list()` reads manifests only; a smashed fragment does not poison siblings |
| 5 | [#1586](https://github.com/deepseek-ai/deepseek-harness/discussions/1586) recovery vs legacy writer | Synthetic closers + live results reuse seq in one file | Both batches stored as separate fragments; readable |
| 6 | [#2167](https://github.com/deepseek-ai/deepseek-harness/discussions/2167) stale-view re-append | Resume re-appends last 4 committed events | Re-append is a new fragment; original 4 bytes unchanged |
| 7 | [#2342](https://github.com/deepseek-ai/deepseek-harness/discussions/2342) repair vs live writer | `commitRepair` injects `step/end`+`turn/end` under a live writer | Repair and live chunks are distinct objects; live tokens preserved |

## What this plugin actually fixes

Storage-layer: torn writes, missing fsync (S3 PutObject durability), and
same-session concurrent flush. Fragments are immutable; the manifest is the
only compare-and-swap point.

`S3SessionPersistence` is a first-party-shaped backend: it extends
`SessionPersistence`, implements `PersistenceBackend`, and constructs
`PersistenceCoordinator(ctx, this)`. The coordinator **rejects** an append
whose first event `seq` ≠ stored next-seq, and cold `load` emits synthetic
interrupted-turn closers. `instanceof SessionPersistence` is true.

## What this plugin does not fix

Two **processes** can still each hold a coordinator with a stale in-memory
cursor (the same class of bug as JSONL [#2167](https://github.com/deepseek-ai/deepseek-harness/discussions/2167)
without a cross-process lock). wal3-Lite will store both as distinct fragments;
the payload seqs may collide. Cross-process CAS on the manifest prevents
silent overwrite of bytes, not colliding coordinator-assigned seqs.
