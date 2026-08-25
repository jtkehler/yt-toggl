# YouTube Watch Time → Toggl

`yt-toggl.user.js` is a dependency-free Violentmonkey userscript that measures eligible YouTube playback locally and creates one completed Toggl Track entry when a viewing session ends.

It supports ordinary desktop videos, live streams, and Shorts. Consecutive videos from the same channel share a session in one tab; different tabs always retain separate sessions and short-time carry.

## Install

1. Install [Violentmonkey](https://violentmonkey.github.io/).
2. Open the raw [yt-toggl.user.js](./yt-toggl.user.js) file in the browser and accept Violentmonkey's installation prompt. When working from a local checkout, create a new Violentmonkey script and paste the file into its editor instead.
3. Edit the `CONFIG` object near the top of the installed script:

   ```js
   const CONFIG = {
     togglApiToken: "",
     togglWorkspaceId: 0,
     togglProjectId: null,
     inactivityMinutes: 10,
     minimumDurationMinutes: 1,
     mergeBelowMinimum: true,
     maxRequestsPerHour: 30,
   };
   ```

4. Set `togglApiToken` to the API token from your Toggl Track profile and `togglWorkspaceId` to the numeric destination workspace. Set `togglProjectId` to a numeric project ID or leave it as `null`.
5. Save the script and reload an open YouTube page. Open the stopwatch button in the YouTube masthead, left of **Create**; configuration errors appear in its panel without stopping local tracking.

Treat the API token like a password. Do not commit or share a configured copy of the userscript.

The default Toggl description is the channel name. To customize it, edit the small function immediately below `CONFIG`:

```js
function makeDescription(channel) {
  return channel.name || channel.id || "YouTube";
}
```

## Configuration

| Setting | Meaning |
| --- | --- |
| `togglApiToken` | Toggl API token used as the Basic Auth username; the password is the literal `api_token`. |
| `togglWorkspaceId` | Positive numeric workspace ID used in both the API path and request body. |
| `togglProjectId` | Optional positive numeric project ID. `null` omits the field. |
| `inactivityMinutes` | A session closes after this much time without validated eligible playback. Must be greater than zero. |
| `minimumDurationMinutes` | Finalized sessions shorter than this threshold are carried or discarded. Set to `0` to disable the minimum. |
| `mergeBelowMinimum` | `true` carries short sessions forward within the same logical tab; `false` permanently discards each short session. |
| `maxRequestsPerHour` | Local rolling-hour attempt cap. The default matches Toggl's documented free-workspace quota. |

Changing `mergeBelowMinimum` to `false` does not silently delete carry that already exists. Open the status panel and use **Discard current carry** if that is what you want.

## What counts as watch time

The userscript samples real elapsed time and validates every credited interval against media progress:

- Pauses, seeking, buffering, stalls, ended media, and YouTube-served ads are excluded.
- Thumbnail hover previews are excluded; only YouTube's primary player surface or active Shorts player is considered.
- Playback at 2× still contributes one minute for one real minute watched.
- Background playback counts; page visibility is deliberately not used as an eligibility condition.
- Long timer delays are capped by validated media progress, and both wall and monotonic clocks are checked so browser or machine suspension does not invent time.
- A live session closes when either its wall-clock or monotonic inactivity deadline is reached. The wall deadline catches machine suspension on platforms whose monotonic clock pauses; the monotonic deadline prevents a backward clock correction from delaying closure. Delayed media progress keeps the session continuous only when neither clock contains a full inactivity window unexplained by that progress, so throttled background playback remains eligible without letting a brief post-wake advance hide a suspension gap. A large forward wall-clock jump can split a session early because it is indistinguishable from suspension using browser clocks alone.
- Live streams use the same progress state machine and do not depend on a finite media duration.

The script prefers YouTube's stable channel ID and falls back to the normalized channel name while metadata is loading. On watch and Shorts routes, playback remains ineligible while the route and player video IDs disagree. A different channel immediately closes the current session. Navigation to another video from the same channel only resets the media-progress baseline and keeps the session open.

## Minimum-duration behavior

In discard mode, every finalized session below the minimum is removed. At or above the boundary it is queued normally.

In merge mode, a short finalized session becomes carry owned by that logical tab. On a later finalization:

- if carry plus the current session is still below the minimum, both remain carried;
- once the sum reaches the minimum, one entry is created and the carry is cleared;
- the current (receiving) session supplies the channel description and start timestamp.

For example, 30 seconds from channel A followed by 2 minutes from channel B creates one 150-second entry described as channel B, starting when B began.

Because earlier carry is added to the receiving session's duration, the entry's implied endpoint can be later than the time it was finalized.

## Status, Sync, and recovery

The Shadow-DOM control appears only in the top-level YouTube page, not embedded frames such as live chat. Its button sits in the YouTube masthead, ahead of **Create**; if the masthead is unavailable the button falls back to the lower-right corner of the page. Because the masthead is hidden in fullscreen, the panel is reachable only outside fullscreen.

The button itself reports state, never time. It takes an accent ring while a session is open, and pulses only while playback is actually earning credit; a pause, a stall, a seek, ended media, or an ad break holds the session open but stops the pulse, and the panel reads **TRACKING PAUSED** rather than **NOW TRACKING**. A dot appears when something needs a decision: a configuration error, a queue entry to retry or dismiss, or stale carry from a closed tab waiting to be attached or discarded.

Opening the panel shows the current session, the channel, and how long remains until the session passes `minimumDurationMinutes` and counts as kept rather than carried, along with current-tab carry, all finalized queue items, and errors or entries that need a decision. When `mergeBelowMinimum` is `true`, existing carry is measured against that minimum together with the current session, because they are finalized as one entry.

**Sync all tabs** broadcasts through Violentmonkey storage. Every open YouTube tab independently finalizes its current session under the same minimum rule. A player that is still eligible immediately starts a fresh zero-length session. Below-minimum carry remains local and visible.

Each logical tab gets an ID in `sessionStorage`, while active sessions and carry are saved in Violentmonkey storage. Reloading a tab therefore keeps its active session and carry without crediting the reload gap. A closed tab cannot run code; after its inactivity deadline, the next visited YouTube page recovers its saved active session when no live owner responds. Fresh heartbeats and cross-tab probes prevent a wall-clock jump from recovering a live tab, and an unavailable probe transport defers destructive recovery.

Carry from a permanently closed tab is never silently merged into another tab. Once stale, it appears under **Stale tab carry** with explicit **Attach to this tab** and **Discard** actions. Attachments first persist a transfer journal and use per-part IDs; recovery completes the designated target after an interruption without duplicating or losing carry.

If a transfer journal is malformed or was written by an unsupported script version, ordinary tracking continues and the status panel shows **Unreadable carry transfer**. Update and reload all YouTube tabs first when versions differ. The explicit discard action removes only the matching journal and preserves every saved tab record; because an interrupted transfer may already have written carry to more than one record, ownership can remain ambiguous after that discard.

## Toggl delivery and failures

Finalized entries are saved before networking. A cross-tab single-flight worker sends at most one request per second and no more than `maxRequestsPerHour` attempts in a rolling hour. It also honors `X-Toggl-Quota-Remaining`, `X-Toggl-Quota-Resets-In`, and `Retry-After` responses.

The worker sends exactly one `POST /api/v9/workspaces/{workspace_id}/time_entries` per queued item with:

- `workspace_id`
- `created_with: "yt-toggl"`
- the generated `description`
- the receiving session's UTC `start`
- a positive integer `duration`
- `project_id` only when configured

`stop` is deliberately omitted, so the positive-duration entry is completed rather than running. Authentication is `Basic base64(<token>:api_token)` through `GM_xmlhttpRequest`; the userscript grants network access only to `api.track.toggl.com`.

Known quota and rate-limit rejections remain pending for later delivery. Authentication and other non-retryable 4xx responses are marked **Blocked** so they do not burn the request allowance repeatedly.

Timeouts, network failures after dispatch, interrupted in-flight requests, and 5xx responses are **Uncertain**: Toggl's create endpoint has no idempotency key, so an automatic retry could duplicate an entry that was actually created. Check Toggl first, then explicitly choose **Retry** or **Dismiss** in the status panel.

If every YouTube tab is closed, nothing can upload in the background. Saved sessions and queue items are recovered the next time a YouTube page runs the userscript.

API references:

- [Toggl time-entry creation](https://engineering.toggl.com/docs/track/api/time_entries/)
- [Toggl authentication](https://engineering.toggl.com/docs/authentication/)
- [Toggl quotas and rate limits](https://engineering.toggl.com/docs/track/)
- [Violentmonkey privileged APIs](https://violentmonkey.github.io/api/gm/)

## Tests

Node 18 or newer is sufficient; there are no packages to install.

```sh
npm test
```

The tests exercise session boundaries, suspension and clock corrections, crash-safe and unreadable carry transfer, carry/discard behavior, tab isolation and cleanup, route/player navigation races, playback speed, seeks, stalls, ads, live/Shorts behavior, collapsed status rendering, playback-eligibility and stale-carry signalling, masthead mounting and re-injection, panel dismissal, global Sync, reload and stale-session recovery, request spacing and quota exhaustion, request payloads, authentication failures, and uncertain POST outcomes. They do not contact YouTube or Toggl.
