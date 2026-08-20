# Design rationale

This document explains why wal3-Lite uses immutable fragments and a
compare-and-swap (CAS) manifest, where the commit boundary is, and which
failure modes remain outside the Phase 1 design. `SPEC.md` is the normative
contract; this document records the reasoning behind it.

## Design goals

Phase 1 is designed to:

- keep already-published event bytes immutable;
- make an interrupted write lose at most the unpublished batch, not the
  previously committed prefix;
- preserve concurrent writers' bytes without a bucket-wide lock;
- detect missing or modified fragments before parsing them;
- use the object store as the only durable dependency; and
- fit DSH's official `SessionPersistence` / `PersistenceCoordinator`
  composition.

It does not promise exactly-once event semantics across processes, a
cryptographic commitment over the whole log, safe deletion under arbitrary
concurrent readers, or automatic orphan collection. DSH's supported topology
is **one live owner per session**. The plugin documents that assumption and
fail-closes a stale writer at the manifest CAS; it does not add leases,
heartbeats, fencing epochs, or multi-writer merge.

## Two layers share one storage protocol

The repository exposes two entry points because DSH orchestration and a small
standalone WAL have different responsibilities.

| Layer | Role | Enforced semantics |
| --- | --- | --- |
| `S3SessionPersistence` + `S3PersistenceBackend` | The DSH plugin seam | DSH headers and events, coordinator preparation and repair, contiguous event-seq checks at batch entry, list/snapshot behavior |
| `createProvider()` + `S3SessionLog` | A five-method library helper | Arbitrary JSON events, in-memory buffering, thresholds, fragment-count trimming |
| `CasStore` / `S3CasStore` | Shared storage primitive | Conditional create/update, object lookup, delete, and prefix listing |

The two public APIs therefore have similar storage behavior but are not
interchangeable. In particular, `flushThresholdEvents` and
`flushThresholdBytes` configure only the library helper. DSH batching is
controlled by `PersistenceCoordinator`, primarily through
`writeBatchMaxDelayMs`.

DSH session creation is intentionally lazy. `create()` registers preparation
state with the coordinator, but the first `appendBatch` materializes the S3
manifest and header. This avoids durable empty sessions and makes `list()` a
view of sessions that have stored content, not merely sessions that were
prepared in one process. The first published header wins; later manifest
updates preserve it.

## Why not one mutable JSONL object

S3 exposes whole-object PUT, not an atomic append. Appending to one JSONL
object would require read-modify-write or a local staging file. With two
writers, both can read the same old value and one can replace the other's
suffix. A process failure can also leave local state and the remote object at
different durability points.

wal3-Lite instead makes each flushed batch a new object. Once published, that
object is never rewritten by the protocol. This has three useful effects:

1. A failed write cannot modify the bytes of an earlier fragment.
2. Integrity failure is localized to a fragment boundary.
3. Writers contend on small metadata, not on a growing event object.

This changes the durability unit from "the file" to "one fragment plus its
manifest reference." Events still held in an in-memory buffer are not durable;
they become durable only when the manifest update succeeds.

## Why the manifest is authoritative

The object listing cannot define the log. A fragment may have been uploaded by
a writer that crashed before publishing it, and a compatible object store may
not make listing visibility line up exactly with the write that created it.
Inferring the log from `fragments/` would therefore revive orphaned batches and
make ordering ambiguous.

`manifest.json` is the reachability index. A fragment is part of the logical
log if and only if the current manifest references it. The manifest also keeps
the session header, aggregate counts, and a monotonic `next_event_seq`
watermark in a single versioned snapshot. Each flush rewrites that whole
object, so bytes transferred grow with fragment count; Phase 1 expects
`trim`/`compact` on long-lived logs.

There is one manifest per session. Unrelated sessions never contend on a
global lock; concurrent writes to the same session deliberately serialize on
that session's manifest.

## Conditional writes and the linearization point

The protocol uses the two S3 preconditions for different purposes:

| Object | Operation | Reason |
| --- | --- | --- |
| New fragment | `If-None-Match: *` | A fragment key is single-assignment; an occupied key must not be overwritten |
| New manifest | `If-None-Match: *` | Only one writer may create the initial version |
| Existing manifest | `If-Match: <etag>` | Update only the version that the writer read |

An ETag is treated as an opaque version token, not as a content checksum. It
is quoted because HTTP entity-tag syntax requires quotes. Fragment integrity
uses an explicit SHA-256 stored in the manifest.

The successful conditional PUT of `manifest.json` is the write's
**linearization point**. Uploading a fragment is preparation; publishing its
reference is the commit. A 412 on the manifest is an expected race: the writer
reloads the manifest, reapplies its mutation, and retries with exponential
backoff and jitter. A fragment-key 412 is also expected (an orphan or a
concurrent PUT occupies that seq): the writer LISTs `fragments/` for the true
max occupied seq and retries at `max(manifest+1, maxOccupied+1, seq+1)`. A
dense run of crash-orphans therefore costs one LIST, not one retry per seq. A
non-conflict S3 error is surfaced because retrying it blindly cannot prove
whether the server committed the request.

This design requires a backend that atomically enforces `If-Match` and
`If-None-Match`. A service that accepts the headers but ignores them can lose
manifest updates and is unsafe for this plugin.

## Write state machine

For the library WAL, a flush moves through four states:

1. Snapshot the current in-memory buffer prefix.
2. Serialize it once and create an immutable fragment.
3. CAS-append the fragment reference to `manifest.json`.
4. Drop only the snapshotted prefix from memory.

The ordering is intentional. Events appended while a flush is in flight stay
in the buffer, and a failed CAS leaves the snapshot available to retry.
`flushTail` serializes flush calls made on the same `S3SessionLog` instance;
the object-store preconditions serialize independent instances.

| Failure boundary | Durable result | Recovery behavior |
| --- | --- | --- |
| Before fragment PUT | No new remote state | Retry the buffered batch |
| Fragment PUT succeeds; manifest PUT does not | Unreferenced orphan | Readers ignore it; a later writer LISTs occupied keys and publishes at the next free fragment seq |
| Manifest CAS returns 412 | Another manifest version won | Reload, remutate, and retry |
| Manifest CAS succeeds; response is lost | Batch may already be published | `S3SessionLog` recognizes the same tail SHA-256 and event count on retry |
| Manifest succeeds; process dies before buffer drop | Batch is published | The same library retry check avoids republishing the buffered snapshot |

The last two rows use content-based retry recognition in `S3SessionLog`.
Consequently, two intentionally consecutive library batches with identical
serialized bytes and event counts are indistinguishable from a retry and may
collapse into one logical batch. Callers that require identical duplicate
batches to remain distinct need an event or batch identity in the payload.

The DSH backend shares the fragment-and-manifest commit protocol, but its
coordinator owns buffering and retry behavior. Do not assume the standalone
helper's in-memory retry recognition is a cross-process exactly-once protocol.

## Storage sequence is not event sequence

There are three related counters with different meanings:

| Value | Meaning |
| --- | --- |
| `FragmentRef.seq` | A one-based storage ordinal used in fragment names; gaps are legal when orphan keys are skipped |
| `SessionEvent.seq` | DSH's zero-based semantic event position inside a session |
| `manifest.total_events` | The number of events in currently referenced fragments |

Manifest CAS totally orders fragment references. It does not rewrite or
reserve `SessionEvent.seq` values inside those fragments.

DSH assumes one cross-process writer for a `SessionId`. The coordinator
enforces one owner only inside a single process. The S3 plugin therefore
does **not** merge two writers. `S3PersistenceBackend.appendBatch` re-reads
`total_events` **inside** the manifest CAS mutate:

1. If the committed tail already has this batch's SHA-256, treat it as a lost
   CAS response and succeed (idempotent).
2. If `events[0].seq !== total_events`, throw `StaleWriterError`. The fragment
   already PUT is an unreachable orphan.
3. Otherwise append the fragment reference.

That is fail-closed stale-writer detection. The race that used to publish
both batches as distinct fragments with colliding payload seqs now commits
exactly one. Preventing two processes from *attempting* the write still
belongs to DSH (one live owner). CAS is the defensive check for when that
assumption is violated, not a lease protocol.

The library helper (`S3SessionLog`) still stores opaque JSON. Concurrent
library flushes reallocate a stale fragment ordinal above the committed tail
and re-upload; they do not append `[2, 1]` to the manifest. Corruption-scenario
tests against the WAL distinguish "storage remains readable" from the backend's
fail-closed path.

## Read and integrity policy

A reader loads one manifest snapshot, walks its fragment references in order,
verifies each fragment's SHA-256, and then parses its JSONL. Objects that are
not referenced are invisible even if they share the fragment prefix.

The DSH backend handles corruption according to its position:

- A missing, unparsable, or hash-mismatched **last** fragment becomes a torn
  marker. `inspect()` can report the intact prefix without mutating storage;
  `load()` lets the coordinator commit the repair.
- The same failure in an **interior** fragment is fatal. Silently skipping an
  interior gap would join two event ranges whose relationship is unknown.
- `list()` and `listSnapshots()` inspect manifests only and isolate errors per
  session. One broken session cannot prevent workspace discovery, but a
  schema-invalid or temporarily unreadable manifest may be omitted from the
  list, and a session with a corrupt fragment may still be listed until it is
  loaded.

Phase 1 integrity is deliberately local. Manifest schema validation checks
field types and strictly increasing fragment ordinals, while per-fragment
SHA-256 protects referenced bytes. There is no setsum or Merkle root binding
the complete ordered fragment set, and the manifest's aggregate totals are not
a whole-log cryptographic proof.

## Repair, trim, and garbage

Removal reverses the write order:

1. CAS-update the manifest so dropped objects are no longer reachable.
2. Delete the now-unreferenced fragment objects.

Deleting first could leave the current manifest pointing at a missing object.
With manifest-first deletion, an interrupted cleanup leaks storage but leaves
the current logical log readable. `trim()` also verifies the fragments it will
keep before changing reachability.

`commitRepair` is fail-closed against a concurrent append. The torn marker
carries the manifest ETag and the torn fragment's SHA-256 from `loadStored`.
Inside the CAS mutate, repair proceeds only if the live tail is still that
fragment. If a later fragment has been published, repair throws
`StaleWriterError` and leaves the new fragment referenced. If the tail is
already below `dropFromSeq`, repair is a no-op.

This ordering does not protect a reader that fetched an old manifest before
trim and then fetches a fragment after it was deleted. That reader receives a
`FragmentCorruptError`. Phase 1 therefore assumes no trim during active reads.

Automatic orphan collection is deferred because an unreferenced fragment may
belong to a slow writer that has not yet attempted its manifest CAS. Safe GC
needs at least a grace period plus a fresh reachability check, and stronger
designs also use leases or fencing. Treating every unreferenced object as
immediately dead would reintroduce a delete-versus-publish race.

## Operational tradeoffs

- **Request count:** an uncontended flush is one manifest GET, one fragment PUT, and one conditional manifest PUT. The first GET's ETag is reused for the CAS; a second GET happens only after a 412. Reads cost one manifest GET plus one GET per referenced fragment.
- **Manifest growth:** each append reads and rewrites the complete fragment
  reference array. Metadata work therefore grows with fragment count; batching
  limits that cost, while Phase 2 compaction/verified GC is needed for
  long-lived high-fragment sessions.
- **Hot sessions:** contention and retries are per session. More concurrent
  writers to one session increase manifest CAS pressure; different sessions
  scale independently.
- **Batch size:** for `createProvider()`, smaller flush thresholds reduce the
  amount of process-local buffered data but increase object count and CAS
  traffic. Larger thresholds do the reverse. In DSH, coordinator batching and
  `writeBatchMaxDelayMs` determine this tradeoff.
- **Listing:** session discovery uses `ListObjectsV2` with `Delimiter: "/"` over `sessions/` (one GET per session manifest, not per fragment). Per-session correctness never derives the event log from a bucket listing.
- **Cost of history:** without compaction or verified GC, immutable objects
  trade additional storage and requests for a smaller corruption blast radius.

## Alternatives not used in Phase 1

| Alternative | Why it is not the Phase 1 mechanism |
| --- | --- |
| Rewrite one JSONL object | Growing copy cost and lost-update risk under concurrent writers |
| Reconstruct the log by listing fragments | Cannot distinguish committed fragments from orphans |
| Content-address fragments only | Deduplicates bytes but does not publish an ordered log or resolve concurrent heads |
| Delete old objects before updating metadata | Can leave the published manifest pointing at missing data |
| External lock or sequence allocator | Would solve stronger semantic coordination but adds a non-S3 dependency and failure domain |
| Global setsum / Merkle commitment | Stronger ordered-log verification is reserved for Phase 2 |

The resulting boundary is deliberate: wal3-Lite makes publication atomic at
the fragment-reference level and keeps committed bytes immutable. It does not
claim to be a distributed transaction protocol for DSH event semantics.
