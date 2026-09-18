"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const api = require("../yt-toggl.user.js");
const fs = require("node:fs");
const vm = require("node:vm");
const cfg = (overrides = {}) => ({ ...api.CONFIG, togglApiToken: "fake", togglWorkspaceId: 123, ...overrides });
const channel = { id: "UC-A", name: "A" };
const s = (nowMs, mediaTime, overrides = {}) => ({ nowMs, monotonicMs: nowMs, mediaTime,
  mediaKey: "video-A", videoId: "video-A", title: "Video A", channel,
  eligible: true, progressAllowed: true, playbackRate: 1, playedRanges: [[0, 100000]], discontinuityToken: 0, ...overrides });
const recorder = (overrides = {}) => {
  assert.equal(typeof api.PlaybackRecorder, "function", "exports a video recorder");
  let sequence = 0;
  return new api.PlaybackRecorder(cfg(overrides), { idFactory: () => `record-${++sequence}` });
};
test("cumulative checkpoints never emit an interval twice", () => {
  const r = recorder(); assert.equal(r.observe(s(1000, 0)).checkpoint, null);
  const a = r.observe(s(2000, 1)).checkpoint;
  assert.equal(a.videoId, "video-A"); assert.equal(a.durationMs, 1000); assert.equal(a.firstPlayMs, 1000);
  assert.equal(r.observe(s(2000, 1)).checkpoint, null);
  const b = r.observe(s(3000, 2)).checkpoint;
  assert.equal(a.id, b.id); assert.equal(b.durationMs, 2000);
});
test("same-channel video navigation creates separate viewing records", () => {
  const r = recorder(); r.observe(s(0, 0)); const a = r.observe(s(1000, 1)).checkpoint;
  const other = { mediaKey: "video-B", videoId: "video-B" };
  r.observe(s(1000, 0, other)); const b = r.observe(s(2000, 1, other)).checkpoint;
  assert.notEqual(a.id, b.id); assert.equal(b.videoId, "video-B"); assert.equal(b.durationMs, 1000);
});
test("reload resets the baseline without crediting the reload gap", () => {
  const r = recorder(); r.observe(s(0, 0)); const a = r.observe(s(1000, 1)).checkpoint;
  r.reset(); assert.equal(r.observe(s(60000, 60)).checkpoint, null);
  const b = r.observe(s(61000, 61)).checkpoint;
  assert.notEqual(a.id, b.id); assert.equal(b.durationMs, 1000); assert.equal(b.firstPlayMs, 60000);
});
test("concurrent video observers contribute additively", () => {
  const a = recorder(), b = recorder(); a.observe(s(0, 0)); b.observe(s(0, 0));
  assert.equal(a.observe(s(300000, 300)).creditedMs + b.observe(s(300000, 300)).creditedMs, 600000);
});
test("playback speed and rate changes credit elapsed time", () => {
  const r = recorder(); r.observe(s(0, 0, { playbackRate: 2 }));
  assert.equal(r.observe(s(60000, 120, { playbackRate: 2 })).creditedMs, 60000);
  assert.equal(r.observe(s(61000, 122)).creditedMs, 1000);
  assert.equal(r.observe(s(62000, 123)).creditedMs, 1000);
});
test("pause/ended tail is credited while accrual indication stops", () => {
  const r = recorder(); r.observe(s(0, 0));
  assert.equal(r.observe(s(1000, 1, { eligible: false })).creditedMs, 1000);
  assert.equal(r.isTracking, false);
  assert.equal(r.observe(s(60000, 1, { eligible: false })).creditedMs, 0);
});
test("playable stalled media earns no time and stops tracking indication", () => {
  const r = recorder(); r.observe(s(0, 0)); r.observe(s(1000, 1)); assert.equal(r.isTracking, true);
  for (let now = 2000; now <= 6000; now += 1000) {
    assert.equal(r.observe(s(now, 1)).creditedMs, 0); assert.equal(r.isTracking, false);
  }
});
test("seeks and ad-neutral samples prevent phantom progress", () => {
  const r = recorder(); r.observe(s(0, 0));
  assert.equal(r.observe(s(1000, 30, { discontinuityToken: 1 })).creditedMs, 0);
  assert.equal(r.observe(s(2000, 31, { discontinuityToken: 1 })).creditedMs, 1000);
  assert.equal(r.observe(s(3000, 32, { channel: null, eligible: false, progressAllowed: false })).creditedMs, 0);
  assert.equal(r.observe(s(4000, 33)).creditedMs, 0);
});
test("media jumps and suspension cannot invent watch time", () => {
  assert.equal(api.validatedPlaybackMs(s(0, 0), s(1000, 100)), 0);
  assert.equal(api.validatedPlaybackMs(s(1000, 0), s(1000000, 500, { monotonicMs: 1000 })), 0);
  assert.equal(api.validatedPlaybackMs(s(0, 0), s(10000, 3)), 3000);
});
test("accumulated stall closes at exact inactivity before resumed playback", () => {
  const r = recorder({ inactivityMinutes: 10 / 60 }); r.observe(s(0, 0));
  const a = r.observe(s(1000, 1)).checkpoint; r.observe(s(10000, 1));
  const b = r.observe(s(12000, 2)).checkpoint;
  assert.notEqual(a.id, b.id); assert.equal(b.durationMs, 1000); assert.equal(b.intervalStartMs, 11000);
});
test("delayed continuous background playback stays in one recording", () => {
  const r = recorder({ inactivityMinutes: 1 }); r.observe(s(0, 0));
  const a = r.observe(s(1000, 1)).checkpoint, b = r.observe(s(601000, 601)).checkpoint;
  assert.equal(a.id, b.id); assert.equal(b.durationMs, 601000);
});
test("suspended interval with brief resumed progress records only the tail", () => {
  const r = recorder({ inactivityMinutes: 1 }); r.observe(s(0, 0));
  const a = r.observe(s(1000, 1)).checkpoint, b = r.observe(s(600000, 2, { monotonicMs: 2000 })).checkpoint;
  assert.notEqual(a.id, b.id); assert.equal(b.durationMs, 1000); assert.equal(b.firstPlayMs, 599000);
});
test("stable IDs distinguish creators with identical display names", () => {
  assert.equal(api.channelsEqual({ id: "UC-A", name: "Same" }, { id: "UC-B", name: "Same" }), false);
  assert.equal(api.channelsEqual({ id: "UC-A", name: "Same" }, { name: "Same" }), true);
});
test("clock rollback preserves the hourly attempt cap", () => {
  const result = api.rollingAttemptWindow(Array.from({ length: 30 }, (_, i) => 100000 + i * 1000), 99000, 30);
  assert.equal(result.allowed, false); assert.equal(result.attempts.length, 30);
});
test("hourly attempts expire at the exact boundary", () => {
  const a = Array.from({ length: 30 }, (_, i) => 1000 + i * 1000);
  assert.equal(api.rollingAttemptWindow(a, 3600999, 30).allowed, false);
  assert.equal(api.rollingAttemptWindow(a, 3601000, 30).allowed, true);
});
test("outgoing destination is frozen and optional fields omitted", () => {
  const r = api.buildTogglRequest({ description: "A", duration: 70, start: "2026-09-11T00:00:00Z", workspaceId: 987, projectId: null }, cfg({ togglProjectId: 12 }));
  assert.equal(r.url, "https://api.track.toggl.com/api/v9/workspaces/987/time_entries");
  assert.deepEqual(r.body, { workspace_id: 987, created_with: "yt-toggl", description: "A", duration: 70, start: "2026-09-11T00:00:00Z" });
});
test("project and Basic token authentication follow Toggl API contract", () => {
  assert.equal(api.buildTogglRequest({ description: "A", duration: 1, start: "2026-09-11T00:00:00Z", workspaceId: 123, projectId: 9 }, cfg()).body.project_id, 9);
  assert.equal(api.encodeBasicAuth("fake"), `Basic ${Buffer.from("fake:api_token").toString("base64")}`);
});
for (const outcome of [{ type: "timeout" }, { type: "network-error" }, { type: "aborted" }, { type: "response", status: 408 }, { type: "response", status: 500 }]) {
  test(`ambiguous ${outcome.status || outcome.type} requires a decision`, () => assert.equal(api.classifyAttempt(outcome, 10000).status, "uncertain"));
}
test("quota resets and Retry-After rejections remain pending", () => {
  const q = api.classifyAttempt({ type: "response", status: 402, responseHeaders: "X-Toggl-Quota-Resets-In: 30" }, 10000);
  assert.equal(q.status, "pending"); assert.equal(q.nextAttemptAtMs, 40000);
  assert.equal(api.classifyAttempt({ type: "response", status: 429, responseHeaders: "Retry-After: 120" }, 10000).nextAttemptAtMs, 130000);
});
test("authentication failure is blocked", () => assert.equal(api.classifyAttempt({ type: "response", status: 401 }, 10000).status, "blocked"));
test("minimum zero is supported and merge mode must be a boolean", () => {
  assert.deepEqual(api.validateConfig(cfg({ minimumDurationMinutes: 0 })), []);
  assert.ok(api.validateConfig(cfg({ mergeBelowMinimum: "false" })).length > 0);
});

test("manual merge descriptions allow empty text and reject non-string values", () => {
  for (const mergedEntryDescription of ["YouTube", "", undefined]) {
    assert.deepEqual(api.validateConfig(cfg({ mergedEntryDescription })), []);
  }
  for (const mergedEntryDescription of [null, 0, false, {}]) {
    assert.ok(api.validateConfig(cfg({ mergedEntryDescription })).some(error => error.includes("mergedEntryDescription")));
  }
  const request = api.buildTogglRequest({ description: "", duration: 5,
    start: "2026-09-18T12:00:00Z", workspaceId: 123, projectId: null }, cfg());
  assert.equal(request.body.description, "");
});

function allocateAt(start, overrides = {}) {
  const firstPlayMs = Date.parse(start);
  const record = { id: "boundary-record", videoId: "boundary-video", title: "Boundary video", channel,
    firstPlayMs, pendingStartMs: firstPlayMs, lastEligibleAtMs: firstPlayMs + 70000,
    durationMs: 70000, consumedMs: 0 };
  const ledger = new api.VideoLedger();
  return ledger.allocate(ledger.groups([record])[0], cfg(overrides), firstPlayMs + 70000,
    { records: { put() {} }, batches: { add() {} } });
}

function inTimezone(timezone, check) {
  const previous = process.env.TZ;
  try { process.env.TZ = timezone; check(); }
  finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

test("day boundary is off by default and validates strict local HH:MM values", () => {
  assert.equal(api.CONFIG.dayBoundary, null);
  for (const dayBoundary of [null, undefined, "00:00", "04:00", "04:30", "23:59"]) {
    assert.deepEqual(api.validateConfig(cfg({ dayBoundary })), [], String(dayBoundary));
  }
  for (const dayBoundary of ["", "4:00", "04:0", "24:00", "04:60", "-1:00", "04:00:00", " 04:00", "04:00\n", 4, false, true, {}]) {
    assert.ok(api.validateConfig(cfg({ dayBoundary })).some((error) => error.includes("dayBoundary")), String(dayBoundary));
  }
});

test("disabled or midnight day boundary preserves the exact outgoing timestamp", () => {
  inTimezone("UTC", () => {
    const start = "2026-09-11T02:30:12.345Z";
    for (const dayBoundary of [null, undefined, "00:00"]) {
      assert.equal(allocateAt(start, { dayBoundary }).start, start);
    }
  });
});

test("day boundary shifts midnight through just before cutoff to previous 23:59", () => {
  inTimezone("UTC", () => {
    for (const start of ["2026-09-11T00:00:00.000Z", "2026-09-11T02:30:12.345Z", "2026-09-11T03:59:59.999Z"]) {
      const batch = allocateAt(start, { dayBoundary: "04:00" });
      assert.equal(batch.start, "2026-09-10T23:59:00.000Z", start);
      assert.equal(batch.duration, 70);
      assert.equal(batch.durationMs, 70000);
      assert.equal(batch.sources[0].startMs, Date.parse(start));
    }
    for (const start of ["2026-09-11T04:00:00.000Z", "2026-09-11T12:00:00.000Z", "2026-09-11T23:59:59.999Z"]) {
      assert.equal(allocateAt(start, { dayBoundary: "04:00" }).start, start);
    }
    assert.equal(allocateAt("2026-09-11T04:29:59.999Z", { dayBoundary: "04:30" }).start, "2026-09-10T23:59:00.000Z");
    assert.equal(allocateAt("2026-09-11T04:30:00.000Z", { dayBoundary: "04:30" }).start, "2026-09-11T04:30:00.000Z");
  });
});

test("day boundary uses calendar dates across month, year, and leap-day changes", () => {
  inTimezone("UTC", () => {
    for (const [start, expected] of [
      ["2026-01-01T02:00:00.000Z", "2025-12-31T23:59:00.000Z"],
      ["2026-03-01T02:00:00.000Z", "2026-02-28T23:59:00.000Z"],
      ["2024-03-01T02:00:00.000Z", "2024-02-29T23:59:00.000Z"],
    ]) assert.equal(allocateAt(start, { dayBoundary: "04:00" }).start, expected);
  });
});

test("day boundary uses local time and previous-day DST offset", () => {
  inTimezone("America/Los_Angeles", () => {
    for (const [start, expected] of [
      ["2026-03-08T10:30:00.000Z", "2026-03-08T07:59:00.000Z"],
      ["2026-11-01T08:30:00.000Z", "2026-11-01T06:59:00.000Z"],
      ["2026-11-01T09:30:00.000Z", "2026-11-01T06:59:00.000Z"],
      ["2026-03-08T11:00:00.000Z", "2026-03-08T11:00:00.000Z"],
    ]) assert.equal(allocateAt(start, { dayBoundary: "04:00" }).start, expected);
  });
  inTimezone("Asia/Kathmandu", () => {
    assert.equal(allocateAt("2026-09-10T18:45:00.000Z", { dayBoundary: "04:00" }).start, "2026-09-10T18:14:00.000Z");
  });
});

function discoveryFixture() {
  let data = { video_id: "current", author: "Actual creator", title: "Video title" };
  const player = { classList: { contains: () => false }, getVideoData: () => data };
  const video = { tagName: "VIDEO", paused: false, ended: false, readyState: 4, seeking: false,
    playbackRate: 1, currentTime: 10, played: { length: 1, start: () => 0, end: () => 10 },
    closest: (selector) => selector === "#movie_player" ? player : null };
  const listeners = new Map();
  const context = { module: { exports: {} }, URL, TextEncoder, Math, Date,
    location: { href: "https://www.youtube.com/watch?v=current", pathname: "/watch", search: "?v=current" },
    document: { querySelectorAll: () => [video],
      querySelector: () => ({ textContent: "Unrelated", getAttribute: () => "/channel/UC-Recommendation" }),
      addEventListener: (name, callback) => listeners.set(name, callback) },
    window: { addEventListener() {} }, performance: { now: () => 10000 }, unsafeWindow: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve("../yt-toggl.user.js"), "utf8"), context);
  return { core: context.module.exports, context, video, player, listeners, setData: (value) => { data = value; } };
}
test("unrelated links cannot supply the current video's channel ID", () => {
  const f = discoveryFixture(); const result = f.core.discoverMedia();
  assert.equal(result.eligible, true); assert.equal(result.channel.id, "");
  assert.equal(result.channel.name, "Actual creator"); assert.equal(result.title, "Video title");
});
test("watch and Shorts route conflicts remain neutral", () => {
  const f = discoveryFixture(); f.setData({ video_id: "old", channel_id: "UC-old", author: "Old" });
  assert.equal(f.core.discoverMedia().eligible, false);
  f.context.location.href = "https://www.youtube.com/shorts/current";
  assert.equal(f.core.discoverMedia().channel, null);
});
test("identified initial metadata supports missing player methods without trusting stale authors", () => {
  const f = discoveryFixture(); f.setData({ author: "Stale" });
  f.context.unsafeWindow.ytInitialPlayerResponse = { videoDetails: { videoId: "current", channelId: "UC-current", author: "Current", title: "Title" } };
  assert.equal(f.core.discoverMedia().channel.id, "UC-current");
  assert.equal(f.core.discoverMedia().channel.name, "Current");
});
test("ads and incidental previews are ineligible", () => {
  const f = discoveryFixture(); f.player.classList.contains = (value) => value === "ad-showing";
  assert.equal(f.core.discoverMedia().eligible, false);
  f.video.closest = () => null; assert.equal(f.core.selectActiveVideo([f.video]), null);
});
test("preview seeking does not invalidate the selected player's baseline", () => {
  const f = discoveryFixture(); let ticks = 0;
  const app = Object.create(f.core.BrowserApp.prototype);
  Object.assign(app, { discontinuityToken: 0, tick: () => { ticks += 1; } });
  app.bindEvents(); f.listeners.get("seeking")({ target: { tagName: "VIDEO", closest: () => null } });
  assert.equal(app.discontinuityToken, 0); assert.equal(ticks, 0);
  f.listeners.get("seeking")({ target: f.video });
  assert.equal(app.discontinuityToken, 1); assert.equal(ticks, 1);
});
test("top-level bootstrap is independent of upload capability and excludes frames", () => {
  const source = fs.readFileSync(require.resolve("../yt-toggl.user.js"), "utf8")
    .replace("new BrowserApp(CONFIG).start();", "globalThis.booted = true;");
  const top = {}; top.self = top; top.top = top;
  const context = { window: top, document: {} };
  vm.runInNewContext(source, context);
  assert.equal(context.booted, true, "capture starts even without GM_xmlhttpRequest");
  const frame = { window: { self: {}, top: {} }, document: {} };
  vm.runInNewContext(source, frame); assert.equal(frame.booted, undefined);
});
