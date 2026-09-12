# AGENTS.md

## Project intent

Maintain a dependency-free Violentmonkey userscript that records eligible YouTube playback per video in IndexedDB and creates completed Toggl Track entries from channel batches. The installable source and testable core both live in `yt-toggl.user.js`; keep CommonJS exports working for Node and native-browser tests.

## Behavioral invariants

- Credit real elapsed playback time, independent of playback speed. Validate it with media progress and exclude pauses, buffering, stalls, seeks, ended media, and YouTube-served ads. Background playback remains eligible.
- Viewing records belong to videos across tabs/windows in the same browser profile and origin. Concurrent playback adds together. Cumulative checkpoints must be idempotent; reloads start fresh progress baselines.
- Group by stable channel ID, using name fallback only when unambiguous. Close each channel after its exact inactivity boundary across observers, or global Sync. Channel switches do not immediately close other channels.
- Apply the minimum after combining a channel's video credit. Merge mode retains short credit only for that channel; discard mode consumes the closed sub-minimum channel total. Never transfer credit between channels.
- Global Sync requests observer checkpoints and atomically freezes the available channel totals. Later playback belongs to new batches, including contributions from observers that miss the bounded flush window.
- Use native IndexedDB transactions for credit, consumed offsets, immutable queue items, receipts, and rate state. No shared GM array or cached-value lease. No legacy-history migration.
- Freeze source membership, earliest included start, duration, and workspace/project destination before networking. Keep delivery cross-tab single-flight using Web Locks, at least one second apart, within the rolling-hour attempt cap (including clock rollback), and respectful of quota-reset headers.
- Never automatically retry ambiguous create outcomes such as timeouts, interrupted sends, or 5xx responses; require explicit retry or dismissal.
- Send a positive-duration completed entry to the Toggl v9 workspace endpoint using `<token>:api_token` Basic Auth. Omit `stop` and omit `project_id` when it is `null`.
- Never persist the API token in origin-accessible IndexedDB. Missing delivery capabilities must not discard recorded time. Surface current errors without treating resolved diagnostic history as an outstanding issue.

## Files and verification

- `yt-toggl.user.js`: userscript metadata, editable `CONFIG`, pure core, browser runtime, and UI.
- `test/yt-toggl.test.js`: dependency-free `node:test` coverage for measurement, discovery, runtime boundaries, and API behavior.
- `test/browser-smoke.cjs`, `test/ledger-cases.js`, `test/browser-ui-cases.js`, `test/browser-runtime-cases.js`: native Firefox IndexedDB, concurrency, DOM, and application lifecycle checks with mocked networking.
- `README.md`: installation, configuration, behavior, and recovery documentation.

Do not add runtime dependencies. After changes, run:

```sh
npm test
node --check yt-toggl.user.js
git diff --check
```

For database, delivery, or UI changes also run `npm run test:browser` (Firefox required; override its path with `FIREFOX_BIN`). Do not use real Toggl requests for automated verification.
