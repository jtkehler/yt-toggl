# Global carry and Other design

## Purpose and approved behavior

Keep channel-based recording and ordinary channel entries, while automatically
including short visits in later entries. The user prioritizes total recorded time
over exact channel attribution and approved these product decisions:

- Combine below-minimum channel totals into one **Other** row under **Unsent by
  channel**.
- Make closed short time available to the **next channel to close across any
  tab**, not the next video to start.
- Test the minimum against carry plus the receiving channel's time. Keep carrying
  the combined time if it remains below the minimum.
- Date merged entries today when they are created, including older carried time.
- Keep **Merge & Sync** as a manual way to send the remaining Other time without
  waiting for the minimum or another channel to close.

The remainder specifies implementation choices for review. This document
supersedes the same-channel-only carry rule in the earlier video-ledger design
for merge mode. Update AGENTS.md to reflect that exception during implementation.

## Scope and constraints

Keep the dependency-free userscript and CommonJS exports in `yt-toggl.user.js`.
Preserve playback validation, additive concurrent playback, cumulative checkpoint
idempotency, stable channel identity, exact inactivity handling, the bounded
cross-tab checkpoint window, and the existing delivery worker and recovery rules.

Keep `mergeBelowMinimum`: true enables global automatic carry; false continues to
discard newly closed sub-minimum channel totals. Previously saved carry is not
silently discarded when the setting changes to false. It remains visible in Other
for manual merging or discard, and is not automatically attached while that
setting is false.

Preserve the current IndexedDB ledger, including accumulated short time and queued
entries. Do not import legacy GM history, create tab-owned carry, or introduce
runtime dependencies. This feature does not add daily accounting, reconstruct
past daily totals, or update entries that have already been sent to Toggl.

## Durable carry and source ownership

Add a `carry` object store to the existing database with an in-place IndexedDB
version upgrade. Store one global carry item containing the original source
ranges. Each range retains its record ID, credited offset bounds, duration, and
original start. Source video and channel identity remain available through the
underlying viewing records; carry never increases another video's recorded total.

When a closed channel is too short to send, atomically move its pending source
ranges into carry and advance those records' consumed offsets. Here, consumed
means the prefix has left the record's available suffix; its time may now belong
to carry, a batch, or an explicit discard. Preserve cumulative historical duration
and clear the pending start anchor as for existing batch allocation. Subsequent
playback therefore starts a fresh available suffix and inactivity episode.

A deliverable source range belongs to exactly one of:

1. A viewing record's unbatched suffix.
2. The global carry item.
3. A frozen outgoing batch.

Moving a range between these states happens in one native IndexedDB transaction.
Repeated checkpoints cannot recreate carried, queued, sent, or discarded credit.
Keep in-memory transaction state consistent with store writes so multiple channel
closures processed in one pass cannot reuse a source range.

Existing schema-version-one records and batches survive the upgrade unchanged.
Their pending credit enters the new closure flow normally. Old script instances
must close their database connections on version change and cannot reopen the
upgraded database at the old version. Document reloading all YouTube tabs after
updating, consistent with the existing installation instructions.

## Closure order and automatic merging

Read current records and carry inside the allocation transaction. Order all
eligible channel closures by their inactivity deadlines, ascending. For equal
deadlines, use a deterministic channel key: stable channel ID when present,
otherwise the normalized lowercase name. Use a stable record ID as a final
tie-break if necessary. For the same saved credit and closure cutoff, the result
must not depend on tab order, object-store iteration order, locale-sensitive
sorting, or which page invokes finalization first.

In merge mode, process each closure in that order:

1. Read the channel's available source ranges and the currently available carry.
2. In merge mode, compare their combined milliseconds with the minimum, also
   requiring a duration that rounds to at least one second.
3. If the combined amount is still too short, move this channel's ranges into
   carry. That channel episode is closed and will not repeatedly compete as a
   receiver on later timer ticks.
4. If the combined amount qualifies, freeze one batch containing both sets of
   ranges. Use the receiving channel with the existing `makeDescription` hook.
   Clear the claimed carry and advance the receiving records' offsets in the
   same transaction.
5. A qualifying channel with no carry creates an ordinary channel batch with the
   existing start-date behavior.

For a one-minute minimum, closed A contributes 20 seconds, closed B contributes
25 seconds, and C later closes with 30 seconds: A and B wait in Other, then C
receives a 75-second entry. C does not have to reach the minimum on its own.

An actively accruing short channel may be displayed in Other, but its credit is
not automatic carry until its channel closes. The total displayed in Other is
therefore not itself an automatic-send trigger. A background channel can receive
carry before the video most recently opened in the foreground.

Use the same globally ordered closure routine for timer finalization and closure
triggered by resumed playback. On the checkpoint path, use the incoming validated
interval's start to establish which deadlines have expired before new credit;
do not finalize an old buffered checkpoint merely because the transaction runs
later. Preserve continuous-progress bridging and FIFO checkpoint replay. Apply
new credit only after any required prior closure, and never rewrite a frozen
batch when a delayed observer subsequently contributes.

Normal finalization must not consume carry without a receiving channel closure.
If no more channels close, the remaining carry stays available for later playback
or the manual action.

## Ordinary Sync and manual Merge & Sync

Ordinary **Sync** retains its broadcast and bounded 500 ms checkpoint window. It
then forces available channels to close through the same ordered routine. Process
already-expired channels before forced early closures; for the latter, use their
would-be inactivity deadlines and the same tie-break. Apply the combined minimum
in merge mode. A carry-only remainder stays saved when no channel closes.

Place **Merge & Sync** on the Other row. Its scope is the saved global carry plus
all currently unbatched channel totals represented by Other. The row's combined
duration supplies the visible preview. Reuse the bounded observer-checkpoint
request, then recompute membership from authoritative records inside one
transaction: a channel that has reached the minimum is now a separate named row
and is not included by this action.

Create one batch described by `CONFIG.mergedEntryDescription` (default
**YouTube — merged**), bypassing the configured
minimum and inactivity wait. Round once after combining milliseconds. If the
result rounds to zero seconds, leave it saved rather than consuming it. If another
operation has already consumed all applicable time, return a harmless no-op.
Freeze only the credit available at this transaction; later checkpoints remain
eligible for new batches.

The manual action does not merge or change items already in Delivery. It uses the
existing worker to send its new batch and continues to record playback while
delivery is pending. No additional channel-selection interface is needed for the
collapsed Other row.

The user additionally requested a configurable manual-merge name, including no
name. `mergedEntryDescription` accepts any string, including `""` for an unnamed
entry. Pass the empty string through to Toggl, and display **(No description)**
locally for an unnamed queued entry. Freeze the configured text in the batch;
automatic carry continues to use the receiving channel's description.

## Dates and frozen payloads

For an automatic batch that includes carry, or a manually merged batch, use the
merge transaction's current timestamp as the outgoing start. “Today” means the
browser's local calendar date at that moment; serialize the timestamp as UTC for
the existing API request. Do not shift merged entries back using `dayBoundary`.
This deliberately assigns older carried time to the merge date, as requested.

Ordinary channel batches with no carry retain their existing earliest-source
start and `dayBoundary` behavior. Preserve original source timestamps in all
cases. Mark the batch as merged so this distinction is explicit and testable.

Freeze description, source membership, duration, start, workspace, and optional
project before networking. Delivery delayed until another day, configuration
changes, and explicit retries keep the frozen timestamp and payload. Never add
new carry to an already queued, sending, uncertain, blocked, or sent batch.

## Status and discard behavior

Build the display from two distinct kinds of saved time:

- Named rows: each channel's unbatched total that meets the effective minimum.
- One synthetic Other row: durable carry plus all unbatched channel totals below
  that minimum, including the positive-duration rounding guard.

Other is a display group, not a fabricated YouTube channel identity. Carried
source prefixes are excluded from unbatched totals, so each millisecond appears
once. Hide Other when empty. A channel whose fresh unbatched total reaches the
minimum moves to its own row; previously closed carry remains in Other.

Show the combined duration and contributing channel count on Other. Distinguish
time already waiting for a receiver from time still awaiting inactivity when
both are present. Keep the current-video readout based on actual video records.
If the UI shows progress toward a sendable combined amount, distinguish the
channel's own time from shared carry so it does not promise that carry to every
active channel. Reuse keyed DOM nodes to preserve keyboard focus during updates.

Give Other a **Discard** action with the existing confirmation style. It consumes
the same freshly evaluated scope as manual merge in one transaction: carry plus
currently short unbatched totals. Named-row discard applies to that channel's
available suffix. Extend **Discard all unsent** to clear carry atomically alongside
its existing scopes. Preserve cumulative recording history, sending/sent entries,
and attempt/rate metadata. Incoming credit after any discard remains eligible.

## Errors, concurrency, and configuration

Before a merge-mode closure pass or manual merge changes source ownership,
validate the destination and relevant allocation settings. If validation fails,
suspend allocation for that pass, leave carry and unbatched credit recoverable,
and surface the current error. Recording continues to accumulate unbatched credit;
once configuration is corrected, evaluate the then-saved groups and deadlines.
Do not partially process a pass or skip an earlier receiver because its allocation
could not be completed. Missing API credentials or delivery capabilities do not
prevent capture, and networking retains its separate configuration checks.

An aborted transaction must roll back source-offset updates, carry changes, and
batch creation together. Concurrent finalization, ordinary Sync, manual merge, and
discard serialize through IndexedDB. Exactly one transaction can take a given
source range. Existing Web Locks continue to serialize network delivery.

Preserve clock-rollback handling for pending inactivity deadlines and request
limits. Carry has no live inactivity deadline to extend; its original source
timestamps stay fixed. Preserve missing-capability capture, uncertain-outcome
handling, explicit retry/dismissal, rate limits, and token exclusion from storage.

## Files and verification

Implementation changes belong in:

- `yt-toggl.user.js`: carry storage and ownership, ordered closures, allocation,
  snapshots, manual merge, discard, UI, and inline configuration comments.
- `test/yt-toggl.test.js`: pure ordering, threshold, rounding, configuration, and
  merged-versus-ordinary date behavior.
- `test/ledger-cases.js`: native IndexedDB upgrade, transfer, allocation,
  concurrency, rollback, and recovery scenarios.
- `test/browser-ui-cases.js`: Other grouping, totals, threshold transitions,
  buttons, empty/readiness states, and focus stability.
- `test/browser-runtime-cases.js`: checkpoint flushing, real application actions,
  delayed observers, and continued playback after merge or discard.
- `README.md` and `AGENTS.md`: user-visible behavior and updated invariants;
  update release metadata consistently with the implementation.

Required acceptance cases include:

1. A 20s + B 25s + C 30s yields one 75s C entry, with distinct source ranges.
2. Carry plus a short receiver can meet the minimum; active donors cannot be
   claimed before closure. Repeated finalization cannot reuse closed carry.
3. Due closures produce the same receiver with reversed record insertion order,
   either connection invoking finalization, equal deadlines, and resume-triggered
   closure competing with timer finalization.
4. Simultaneous merge/Sync/discard operations never duplicate or lose credited
   time. Inject failure at each transactional write boundary and verify rollback.
5. Continued playback and repeated, stale, or delayed cumulative checkpoints
   cannot resurrect transferred time; new suffixes preserve their own starts.
6. Ordinary Sync retains the minimum; manual merge bypasses it. A rounded-zero
   remainder, empty merge, and channel crossing the minimum during the flush
   window behave as specified.
7. Merged dates use the creation day, including before a configured day cutoff;
   ordinary dates retain existing behavior. Retries after midnight are unchanged.
8. Existing ledger records and every batch state survive upgrade. Missing setup
   or capabilities preserve time. Disabling automatic carry preserves old carry.
9. Other counts carry and short active totals once, remains a single row when
   its combined total exceeds the minimum, and retains usable actions and focus.
10. Existing playback, identity, clock, delivery, and discard regressions pass;
    replace assertions that intentionally enforced the superseded same-channel
    carry behavior with coverage for the new policy and discard mode.

Run `npm test`, `npm run test:browser`, `node --check yt-toggl.user.js`, and
`git diff --check` after implementation. Browser checks use native Firefox and
mocked networking. Do not make real Toggl requests for automated verification.
