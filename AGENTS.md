# AGENTS.md

## Project intent

Maintain a dependency-free Violentmonkey userscript that measures eligible YouTube playback locally and creates completed Toggl Track entries when sessions finish. The installable source and testable core both live in `yt-toggl.user.js`; keep the CommonJS exports working for Node tests.

## Behavioral invariants

- Credit real elapsed playback time, independent of playback speed. Validate it with media progress and exclude pauses, buffering, stalls, seeks, ended media, and YouTube-served ads. Background playback remains eligible.
- Group consecutive videos by stable channel ID, falling back to channel name. A channel change finalizes immediately; inactivity uses the configured exact boundary.
- Keep active sessions and short-duration carry isolated per logical browser tab. Never merge stale closed-tab carry automatically; require explicit attach or discard.
- In merge mode, carried time joins the current finalized session. The current session supplies the description and first-play timestamp. In discard mode, remove each sub-minimum session.
- Global Sync finalizes every open tab independently and starts a fresh session for any still-playing media.
- Persist finalized queue items before networking. Keep Toggl delivery cross-tab single-flight, at least one second apart, within the rolling-hour attempt cap, and respectful of quota-reset headers.
- Never automatically retry ambiguous create outcomes such as timeouts, interrupted sends, or 5xx responses; require explicit retry or dismissal.
- Send a positive-duration completed entry to the Toggl v9 workspace endpoint using `<token>:api_token` Basic Auth. Omit `stop` and omit `project_id` when it is `null`.

## Files and verification

- `yt-toggl.user.js`: userscript metadata, editable `CONFIG`, pure core, browser runtime, and UI.
- `test/yt-toggl.test.js`: dependency-free `node:test` coverage, including mocked browser startup.
- `README.md`: installation, configuration, behavior, and recovery documentation.

Do not add runtime dependencies. After changes, run:

```sh
npm test
node --check yt-toggl.user.js
```
