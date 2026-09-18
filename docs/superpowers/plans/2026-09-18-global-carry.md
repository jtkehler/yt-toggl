# Global Carry Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for the coupled userscript changes, with an independent final code review. Steps use checkbox syntax for tracking.

**Goal:** Automatically merge closed short channel time into the next closing channel and provide one Other row with manual merge/discard.

**Architecture:** Extend the existing IndexedDB ledger with a durable global carry store. Record offsets move atomically into carry or immutable batches; one deterministic closure routine serves recording and finalization. Derive Other from carry and short unbatched channel groups and reuse the existing delivery worker.

**Tech Stack:** Dependency-free JavaScript, native IndexedDB/Web Locks, Node 18+, Firefox browser fixtures.

**Spec:** `docs/superpowers/specs/2026-09-18-global-carry-design.md`

## Global Constraints

- Keep the dependency-free userscript and CommonJS exports in `yt-toggl.user.js`.
- Preserve cumulative credit, actual per-video history, current database content, and frozen queued payloads.
- Use the next channel to close across all tabs; order equal deadlines by stable channel key.
- Merged entries use the merge timestamp without the dayBoundary transform; ordinary channel entries retain their existing dates.
- Never automatically retry ambiguous network outcomes or persist the API token.
- Tests use mocked networking, never real Toggl requests.

## Task 1: Durable global carry, ordered closures, and manual operations

**Files:** `yt-toggl.user.js`, `test/yt-toggl.test.js`, `test/ledger-cases.js`.

**Interfaces:** Extend `VideoLedger.snapshot()` with `carry: {id: "global", sources, durationMs}` while keeping `pendingChannels` as raw unbatched channel groups. Add `VideoLedger.other(state, config)` returning `{groups, sources, durationMs, carryMs, channelCount}`; `mergeOther(config, {nowMs})` creates a batch or returns null; `discardOther(config)` consumes that same freshly evaluated scope. `finalize` and `record` share `closeGroups(state, stores, config, cutoffMs, nowMs, force)`.

- [x] Add a native IndexedDB failing sequence using the existing fixture helpers:

```js
await ledger.record(cp("a", 20000, 100000, "A"), config);
await ledger.finalize(config, { nowMs: 180000 });
await ledger.record(cp("b", 25000, 200000, "B"), config);
await ledger.finalize(config, { nowMs: 285000 });
await ledger.record(cp("c", 30000, 300000, "C"), config);
await ledger.finalize(config, { nowMs: 390000 });
const snap = await ledger.snapshot();
assert(snap.batches.length === 1 && snap.batches[0].duration === 75);
assert(snap.batches[0].channel.id === "C" && snap.carry.durationMs === 0);
```

- [x] Run the browser suite and confirm the expected new-policy failure before source edits.
- [x] Open the existing database at version 2, adding the `carry` store. Include it in transactions and normalize the absent singleton to empty sources. Preserve existing stores on upgrade.
- [x] Extract range construction, source consumption, and batch construction so automatic and manual paths share atomic ownership changes:

```js
const sources = group.pending.map(record => ({ recordId: record.id,
  fromMs: record.consumedMs, toMs: record.durationMs,
  durationMs: record.durationMs - record.consumedMs,
  startMs: record.pendingStartMs }));
const merged = carry.sources.length > 0;
const start = merged ? new Date(nowMs).toISOString()
  : togglStartTime(group.firstPlayMs, dayBoundaryMinutes(config));
```

- [x] Sort eligible groups by deadline then stable channel key. Below-minimum combined credit moves to carry; qualifying credit becomes one immutable receiving-channel batch. Validate allocation settings before moving ownership in merge mode. Discard mode retains existing short-discard behavior and leaves old carry alone.
- [x] Replace the same-channel-only pre-credit closure with ordered closure at the incoming interval start, preserving duplicate rejection, trusted clocks, and FIFO checkpoints. Timer/forced finalization calls the same routine.
- [x] Add manual merge and Other discard. Manual merge uses `new Date(nowMs).toISOString()`, `CONFIG.mergedEntryDescription` (default `YouTube — merged`, empty string allowed), and bypasses minimum/inactivity but never consumes a rounded-zero total. Validate string descriptions, freeze the configured value, and show `(No description)` locally for unnamed batches. Bulk discard also clears carry.
- [x] Cover version-one upgrade, active donors, ordering/ties/reversed insertion, resumed playback, combined thresholds, carry-only repeat finalization, disabled carry, missing setup, rounding, stale checkpoints, frozen dates/payloads, and claim/merge/discard races. Inject failure after every relevant store write and require snapshots to remain identical.
- [x] Run Node and browser tests. Review source ownership and transaction scopes before proceeding.

## Task 2: Other UI and real application actions

**Files:** `yt-toggl.user.js`, `test/browser-ui-cases.js`, `test/browser-runtime-cases.js`.

**Interfaces:** `BrowserApp.mergeOther()` uses the existing bounded checkpoint request then calls ledger `mergeOther`; `BrowserApp.discardOther()` confirms and calls ledger `discardOther`. StatusControl derives Other via `ledger.other(view, config)` and maintains one stable keyed synthetic row, never a fake channel ID.

- [x] Add failing browser UI/runtime assertions for a single Other row and the real actions before implementing them. A fixture with A=20s, B=25s, and a named C=70s must show Other=45s and C=70s. Add 15s of durable carry and expect Other=60s, still one row.
- [x] Implement Other's duration/channel-count detail, available-carry versus waiting-for-closure detail, Merge & Sync, and Discard. Named rows retain their own discard. Hide the empty row and preserve stable nodes and focus.
- [x] Share the observer checkpoint/500ms window between ordinary Sync and manual merge, keeping networking asynchronous. Refresh and broadcast changed state after mutations.
- [x] Keep threshold captions honest: display current channel credit and separately available shared carry, without promising that carry to every active channel. Enable bulk discard when carry is the only unsent work.
- [x] Exercise canceled discard, readiness, continued playback after manual merge/discard, a threshold crossing during the flush window, and bounded late-observer behavior in the actual BrowserApp fixture.
- [x] Run browser tests and review the exact rendered DOM and persisted results.

## Task 3: Documentation, release metadata, and final review

**Files:** `README.md`, `AGENTS.md`, `package.json`, userscript metadata, this plan.

- [x] Document automatic carry, Other membership/actions, literal merge-day attribution, retained carry when merge mode is disabled, database upgrade, and reload-all-tabs guidance. Replace the obsolete same-channel-only rule in AGENTS.md.
- [x] Bump package and userscript versions consistently to 2.2.0 and update trailing CONFIG comments.
- [x] Run all required gates:

```sh
npm test
npm run test:browser
node --check yt-toggl.user.js
git diff --check
```

- [x] Request an independent code review against the approved spec; resolve material findings and rerun the affected checks.
- [x] Mark completed tasks in this plan and report the implementation and verification outcome.

## Execution notes

- Baseline is clean commit `6d0a222`; the existing 36 Node tests passed when the spec was committed.
- Work in the current clean checkout on `feat/global-carry`. The user's implementation request authorizes the work; no additional execution-choice approval is needed.
- All production changes share one file, so implementation proceeds inline. A separate reviewer can inspect the completed change while final documentation and verification run.

- Core and full-feature reviews found no actionable correctness issues; independent conservation and ordering probes passed.
- Final verification passed: all 37 Node tests, the complete native Firefox suite, userscript syntax checking, and diff whitespace checking. Browser fixtures used mocked networking; no live YouTube or Toggl verification was performed.
