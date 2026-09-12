# Video Ledger Implementation Plan

> **For agentic workers:** Execute the bounded tasks below with focused independent review. Tests precede new behavior; shared source integration belongs to the main agent.

**Goal:** Replace tab-owned sessions with durable global video records and channel-based completed Toggl batches.

**Architecture:** Per-player samplers produce cumulative viewing checkpoints. IndexedDB atomically stores credit and allocates it to immutable channel batches. A Web-Lock worker delivers them and a cached UI presents global state.

**Tech Stack:** Vanilla JavaScript, IndexedDB, Web Locks, BroadcastChannel, privileged `GM_xmlhttpRequest`, Node `node:test`, native Firefox browser verification.

**Spec:** `docs/superpowers/specs/2026-09-11-video-ledger-design.md`

## Global Constraints

- No runtime dependencies; retain CommonJS exports in the installable userscript.
- Add concurrent playback; group by stable channel ID with conservative name fallback.
- Minimum applies after channel aggregation; retain short credit for its channel in merge mode.
- Close after channel-wide inactivity or global Sync; preserve validated background playback.
- Fresh schema; no legacy migration or deleting existing stored user history during development.
- Persist immutable batches before networking; never automatically retry ambiguous POST outcomes.
- No credentials in IndexedDB; no actual Toggl requests during tests.

## Task 1: Transactional ledger and delivery

- [x] Write browser tests for two database connections, cumulative-checkpoint idempotence, same-channel merging, exact inactivity, short retention/discard, atomic consumed offsets, immutable batches, and delivery recovery.
- [x] Confirm the tests fail against the old exported API.
- [x] Implement `VideoLedger.open()`, `record(checkpoint, config)`, `finalize(config, {nowMs, force})`, `snapshot()`, and conditional retry/dismiss, using native readwrite transactions.
- [x] Implement `TogglWorker` with a single Web Lock, transactional claims, attempts/quota state, conservative post-completion request spacing, and uncertain recovery.
- [x] Verify with a real IndexedDB engine and mocked requests; independently review transaction and delivery boundaries.

## Task 2: Playback and browser runtime

- [x] Replace session tests with sampler regressions for speeds, suspend, seek, stalls, exact inactivity gap reporting, media changes, repeated checkpoints, and no reload-gap credit.
- [x] Implement `PlaybackRecorder.observe(snapshot)` producing `{checkpoint, creditedMs}` and a fresh record on content discontinuities requiring a new viewing record.
- [x] Retain discovery with scoped channel metadata and ignore preview media events; include title and stable video ID in observations.
- [x] Replace logical-tab ownership/recovery with database initialization, serialized checkpoints, cross-page refresh/Sync notifications, and pagehide/pageshow sampling resets.
- [x] Preserve paused/ended tail credit without counting invalid intervals; distinguish validated accrual from playable flags.

## Task 3: UI and documentation

- [x] Test status state, global totals, uncertain-entry actions, unchanged-node identity, and cleared attention.
- [x] Keep the masthead button and Trusted Types-safe Shadow DOM, replace carry/tab sections with video/channel and immutable batch details, and update only changed nodes.
- [x] Update README, AGENTS.md, userscript/package version, and test commands for the approved behavior and storage lifecycle.

## Task 4: Acceptance and review

- [x] Run `npm test`, `node --check yt-toggl.user.js`, and `git diff --check`.
- [x] Run real-browser IndexedDB/concurrency tests and a DOM integration fixture with networking mocked.
- [x] Independently review the final diff for compliance and concrete regressions; resolve important findings and rerun affected checks.
- [x] Record actual results and any live-YouTube verification limitation in the final handoff.

## Implementation evidence

- `npm test`: 31/31 Node tests passed.
- `node --check yt-toggl.user.js` and `git diff --check`: passed.
- `npm run test:browser`: passed in native Firefox with 12 ledger scenario groups, 2 real Shadow DOM groups, and 1 actual BrowserApp lifecycle group. Delivery was mocked throughout.
- Independent review findings were reproduced and resolved: missing upload APIs no longer gate recording; queued checkpoints retain FIFO interval boundaries; trusted wall-clock adjustment and delayed checkpoint persistence share a transaction.
- The native runtime regression covers startup, delayed storage, global Sync, and a BFCache baseline reset. Database tests use separate connections and native Web Locks.
- No live YouTube DOM compatibility claim and no real Toggl requests. Legacy data is neither migrated nor deleted. No runtime dependencies added.
