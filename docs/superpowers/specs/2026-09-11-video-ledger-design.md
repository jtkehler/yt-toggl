# Video ledger design

Approved in conversation: replace tab sessions with global per-video viewing records; use IndexedDB; add simultaneous playback; batch by channel after channel-wide inactivity or Sync; apply minimum after combining videos; retain short time for its channel in merge mode. No legacy-history support or migration.

Keep a dependency-free installable `yt-toggl.user.js` with CommonJS exports. Reuse player selection, progress validation, quota classification, and the masthead/Shadow DOM visual style while fixing the audit's attribution, preview-event, stalled-status, focus, and error-state defects.

Each page samples its selected player and produces cumulative checkpoints under a unique viewing-record ID. A record stores video ID/title, channel, first-play and latest validated playback times, total credited milliseconds, and consumed milliseconds. Reloads use a fresh sampler baseline and ID; old records are already globally available. Repeated checkpoints do not duplicate duration. A pending start anchor records the first playback after a batch consumed the previous prefix.

Native IndexedDB stores viewing records, immutable batches, and rate/error metadata. Readwrite transactions serialize checkpoint/finalization and batch consumption. Normal finalization closes channels at their exact inactivity boundary. Incoming playback must finalize an expired prior channel episode before crediting new playback when the new interval does not bridge the old deadline. Background delay is validated by media progress and both clocks. Late contributions never mutate an outgoing batch.

Observers retain unacknowledged checkpoints in FIFO order so storage delays cannot lose the first post-consumption interval. A transaction samples the trusted current clock and translates delayed checkpoint activity using its elapsed age. Backward wall-clock adjustment and activity persistence are atomic across database connections; original viewing timestamps remain unchanged.

Batch creation freezes video contribution offsets, channel description, earliest included first-play time, integer duration (round once after summing milliseconds), and workspace/project destination. Short totals stay pending only for the same channel in merge mode; discard mode consumes the short closed batch without creating a request. Sync asks live observers to checkpoint, then finalizes globally; unresponsive observers cannot block indefinitely and their later credit belongs to the next batch.

A Web Lock serializes networking; IndexedDB is the authority for claims and attempts. No cached-GM lease fallback. Capture works if a send capability is missing and surfaces an actionable notice. Persist a sending claim before networking, reserve attempts, preserve future timestamps after clock rollback, and enforce at least one second between actual requests (conservative completion-based spacing is acceptable). Recover interrupted sends as uncertain. No automatic ambiguous retries. Retain sent receipts and source membership; explicit retry/dismiss is conditional on current batch status.

Keep the API token in source configuration, never IndexedDB. Database storage belongs to `www.youtube.com` and is removed by clearing site data; no migration code reads old GM history. No actual Toggl writes are needed for verification.

The UI shows actual validated accrual, current video, global unsent channel totals, queued/uncertain entries with timestamps, and Sync. Reuse keyed nodes to preserve focus. Resolved errors do not count as outstanding attention. History remains local; no per-second event log, manual carry transfer, logical-tab identity, or stale-tab recovery UI.
