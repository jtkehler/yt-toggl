# Youtube Toggl Sync

A dependency-free Violentmonkey userscript that records YouTube watch time locally per video, then combines videos from the same channel into completed Toggl Track entries.

Records are shared across YouTube tabs and windows in the same browser profile. Ordinary desktop videos, live streams, and Shorts use the same elapsed-playback measurement.

## Install and configure

1. Install [Violentmonkey](https://violentmonkey.github.io/).
2. Open [yt-toggl.user.js](./yt-toggl.user.js) as a raw userscript and install it.
3. Edit `CONFIG` in Violentmonkey, set your Toggl API token and workspace ID, save, and reload your YouTube tabs.

| Setting | Meaning |
| --- | --- |
| `togglApiToken` | Your Toggl Track API token; authentication uses `<token>:api_token`. |
| `togglWorkspaceId` | Positive numeric workspace ID. |
| `togglProjectId` | Optional positive numeric project ID; `null` omits it. |
| `inactivityMinutes` | Close a channel after this much time without validated playback. Default: 10. |
| `minimumDurationMinutes` | Minimum combined channel duration. Default: 1; use 0 to disable. |
| `mergeBelowMinimum` | `true` retains short time for the same channel; `false` discards a closed channel total below the minimum. Must be a boolean. |
| `dayBoundary` | Optional local start of day in 24-hour `"HH:MM"` format, e.g. `"04:00"`. Default: `null` (off). |
| `maxRequestsPerHour` | Local rolling-hour attempt cap. Default: 30. |

Playback can be recorded before credentials are complete. Time stays unbatched until a valid workspace/project destination is configured. An outgoing batch freezes its destination; changing configuration does not retarget existing batches.

## Recording and grouping

The script samples real elapsed playback and validates it against media progress. Pauses, buffering, stalls, seeks, ended media, YouTube-served ads, and thumbnail previews earn no time. A pause or end event can still save the eligible tail immediately before it. One real minute at 2× contributes one minute. Background playback remains eligible; both wall and monotonic elapsed time constrain credit.

Each viewing record stores the video ID/title, channel identity, timestamps, and cumulative credited milliseconds. Repeated checkpoints do not add the same time twice. Reopening a video starts a fresh sampling baseline and can create another record; totals combine records for the same video. Simultaneous playback adds together: the same video playing in two tabs for five minutes contributes ten minutes.

Channel IDs take precedence over names. Name-only records join a known channel only when the name is unambiguous. Conflicting route/player metadata remains ineligible, and unrelated page links cannot supply the creator ID.

Each channel closes independently after its inactivity period, even if another channel is playing. Switching channels does not immediately send the previous channel. Resumed playback after an expired gap belongs to the next batch; continuous validated playback can bridge a delayed sampling interval.

The minimum applies **after combining videos from the same channel**. Twenty seconds from A's first video plus fifty seconds from A's second video creates a 70-second A entry. B's time remains separate.

In merge mode, a below-minimum channel total stays pending until later watching of that channel reaches the minimum at a subsequent closure or Sync. In discard mode, closing that below-minimum total consumes it without uploading. Duration is rounded once after summing milliseconds; sub-second totals that round to zero remain pending in merge mode or are discarded in discard mode.

A batch starts at its earliest included first-play timestamp and uses the sum of credited durations. Gaps and simultaneous playback mean its implied continuous interval may differ from the actual viewing intervals. Video records and batch membership remain available locally.

With `dayBoundary: "04:00"`, a batch whose earliest included start is between midnight (inclusive) and 04:00 (exclusive) is sent with a start of **23:59:00 on the previous calendar day**. Starts at or after 04:00 keep their original timestamp. The adjustment uses the browser's local timezone when the batch is created, including daylight-saving changes; match your Toggl report timezone to it for the same date attribution. Only the outgoing start changes: recorded playback timestamps and credited duration stay intact.

The earliest included start governs the entire channel batch, including batches containing videos on both sides of the cutoff. A new batch after Sync uses the start of its newly included playback. The adjusted start is frozen before delivery, so changing the option does not alter already queued entries or retries. Invalid boundary values show a configuration error and leave uploadable time unbatched until corrected.

Toggl assigns entries to their start date; its support team has recorded custom day boundaries as a [feature request](https://community.toggl.com/t/feature-request-discussion-custom-end-of-day-time-for-daily-tracking/2215) and [confirmed that a pre-midnight start counts toward the previous day](https://community.toggl.com/t/tasks-completed-before-2am-should-count-towards-previous-days-goals/2639).

## Status and Sync

The status button lives in YouTube's masthead, with a floating fallback when the masthead is unavailable. It appears only in the top-level page. Open it outside fullscreen to see the current video's recorded total, unsent totals by channel, delivery status, and errors.

The button pulses only while playback has validated progress. An unpaused player that stops advancing displays paused tracking. Attention indicates configuration/capability errors or entries requiring a decision; resolved historical errors do not keep it active. Action nodes stay stable during updates so keyboard focus is preserved.

**Sync** asks other live YouTube pages to checkpoint and waits up to 500 ms before freezing the globally available channel totals under the same minimum rule. Suspended or unresponsive pages cannot hold Sync open; their later contributions belong to another batch. Continued playback contributes to the next batch. Without BroadcastChannel, Sync still freezes the already persisted global records.

Outgoing batches have fixed source membership and payloads. Recording more videos cannot change a queued, sending, or uncertain batch. Retry and Discard act only on the current permitted state; successful receipts remain recorded locally.

Use **Discard** on an **Unsent by channel** row to clear that channel's saved, unbatched time, or on a **Delivery** row to discard that individual pending, blocked, or uncertain entry. **Discard all unsent** clears saved unbatched time and all discardable delivery entries across YouTube tabs in one operation. Each action asks for confirmation. Entries already sending are kept, and nothing is deleted from Toggl.

Discard applies to the time already saved when the operation runs. Later playback and checkpoints arriving afterward remain eligible. Cumulative viewing history stays local so repeated checkpoints cannot restore discarded time; the current video's recorded total therefore still includes discarded time. Discard works before credentials are configured and when delivery is unavailable.

## Storage and delivery

Version 2 uses a fresh IndexedDB database on `https://www.youtube.com`. Transactions serialize recording and batch allocation across tabs without relying on Violentmonkey's separate value caches. No migration reads old tab sessions, carry, or GM queues; old extension data is left unused. Reload all YouTube tabs after updating so old script instances stop running.

Local history and unsent work share YouTube's site-storage lifecycle: clearing YouTube site data removes them. This is browser-profile-local storage, not cross-device sync or an extension-private database. The API token remains in the userscript configuration and is never written into IndexedDB.

Delivery requires native Web Locks, available in modern Firefox and Chromium browsers. If a required delivery capability is unavailable, recording continues and the panel explains the issue. The worker persists a sending claim before networking, enforces a conservative delay of at least one second after a completed request before the next, preserves recent attempts through backward clock corrections, and honors quota-reset and Retry-After headers.

Requests use `POST /api/v9/workspaces/{workspace_id}/time_entries`, Basic token authentication, `created_with: "yt-toggl"`, a positive duration, and a UTC start. `stop` is omitted; `project_id` is omitted when null.

Quota and rate-limit rejections remain pending. Authentication and other nonretryable rejections become blocked. Timeouts, network/interrupted sends, HTTP 408, and 5xx responses become **uncertain**. Check Toggl before explicitly retrying or discarding: local transactions cannot guarantee that a remote create request did not succeed.

Nothing runs while all YouTube pages are closed. Persisted records are finalized and queued work resumes when another page runs the userscript. The last uncheckpointed interval can be lost if a page or browser closes abruptly.

## Verification

No packages need to be installed. Node 18 or newer runs the pure-core suite:

```sh
npm test
node --check yt-toggl.user.js
git diff --check
```

Native IndexedDB and Shadow DOM checks run in an isolated headless Firefox profile:

```sh
npm run test:browser
```

Firefox defaults to `/usr/bin/firefox`; set `FIREFOX_BIN` to another executable path. The runner uses a local HTTP server, a disposable profile, native database/Web Locks, and mocked delivery. Tests cover concurrent writes, idempotent checkpoints, channel thresholds, exact inactivity, immutable allocation, uncertain recovery, request spacing, clock rollback, real keyboard focus, and status actions. Discard checks include individual scopes, cancellation, atomic bulk changes, delivery races, and continued playback. They make no real YouTube or Toggl requests and do not establish live YouTube DOM compatibility.

API references: [Toggl time entries](https://engineering.toggl.com/docs/track/api/time_entries/), [authentication](https://engineering.toggl.com/docs/authentication/), [quotas and rate limits](https://engineering.toggl.com/docs/track/), [Violentmonkey privileged APIs](https://violentmonkey.github.io/api/gm/).
