"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const {
  SessionMachine,
  attachCarry,
  buildTogglRequest,
  carryDurationMs,
  channelFromVideoData,
  channelsEqual,
  classifyAttempt,
  configFingerprint,
  createTabRecord,
  discardCarry,
  encodeBasicAuth,
  enqueueUnique,
  finalizeTabRecord,
  markInterruptedRequestsUncertain,
  normalizeQueue,
  parseResponseHeaders,
  recoverExpiredRecord,
  requestSpacingDelay,
  rollingAttemptWindow,
  selectActiveVideo,
  validateConfig,
  validatedPlaybackMs,
} = require("../yt-toggl.user.js");

const SECOND = 1000;
const MINUTE = 60 * SECOND;

function config(overrides = {}) {
  return {
    togglApiToken: "test-token",
    togglWorkspaceId: 123,
    togglProjectId: null,
    inactivityMinutes: 10,
    minimumDurationMinutes: 1,
    mergeBelowMinimum: true,
    maxRequestsPerHour: 30,
    ...overrides,
  };
}

function channel(name, id = `UC-${name}`) {
  return { id, name };
}

function snapshot(nowMs, mediaTime, overrides = {}) {
  const eligible = overrides.eligible === undefined ? true : overrides.eligible;
  return {
    nowMs,
    mediaTime,
    eligible,
    progressAllowed:
      overrides.progressAllowed === undefined ? eligible : overrides.progressAllowed,
    channel: channel("A"),
    mediaKey: "video-1",
    playbackRate: 1,
    playedRanges: [[0, 100000]],
    discontinuityToken: 0,
    ...overrides,
  };
}

function idFactory(seed = "test") {
  let sequence = 0;
  return (prefix) => `${seed}-${prefix}-${++sequence}`;
}

function machine(overrides = {}, tabId = "tab-1") {
  return new SessionMachine(config(overrides), createTabRecord(tabId, 0), {
    idFactory: idFactory(tabId),
  });
}

function finish(currentMachine, nowMs, mediaTime, overrides = {}) {
  return currentMachine.sync(
    snapshot(nowMs, mediaTime, {
      eligible: false,
      progressAllowed: true,
      ...overrides,
    }),
  );
}

test("15 minutes play, 2 minutes pause, and 5 minutes play creates one 1200-second entry", () => {
  const tracker = machine();
  tracker.tick(snapshot(0, 0));
  tracker.tick(snapshot(15 * MINUTE, 15 * 60));
  tracker.tick(snapshot(15 * MINUTE, 15 * 60, { eligible: false, progressAllowed: true }));
  tracker.tick(snapshot(17 * MINUTE, 15 * 60, { eligible: false, progressAllowed: true }));
  tracker.tick(snapshot(17 * MINUTE, 15 * 60));
  tracker.tick(snapshot(22 * MINUTE, 20 * 60));

  const entries = finish(tracker, 22 * MINUTE, 20 * 60);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].duration, 1200);
  assert.equal(entries[0].description, "A");
});

test("inactivity finalizes at exactly the configured boundary, not before", () => {
  const tracker = machine({ minimumDurationMinutes: 0 });
  tracker.tick(snapshot(0, 0));
  tracker.tick(snapshot(MINUTE, 60));
  tracker.tick(snapshot(MINUTE, 60, { eligible: false, progressAllowed: true }));

  assert.deepEqual(
    tracker.tick(snapshot(11 * MINUTE - 1, 60, { eligible: false, progressAllowed: true })),
    [],
  );
  const entries = tracker.tick(
    snapshot(11 * MINUTE, 60, { eligible: false, progressAllowed: true }),
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0].reason, "inactivity");
  assert.equal(entries[0].duration, 60);
});

test("a session exactly at the minimum queues while one millisecond below carries", () => {
  const exact = createTabRecord("exact", 0);
  exact.active = {
    id: "exact-session",
    channel: channel("Exact"),
    firstPlayMs: 0,
    lastEligibleAtMs: MINUTE,
    durationMs: MINUTE,
  };
  const exactResult = finalizeTabRecord(exact, config(), (value) => value.name, "test", MINUTE);
  assert.equal(exactResult.disposition, "queued");
  assert.equal(exactResult.entry.duration, 60);

  const short = createTabRecord("short", 0);
  short.active = { ...exact.active, id: "short-session", durationMs: MINUTE - 1 };
  const shortResult = finalizeTabRecord(short, config(), (value) => value.name, "test", MINUTE);
  assert.equal(shortResult.disposition, "carried");
  assert.equal(shortResult.entry, null);
  assert.equal(carryDurationMs(shortResult.record.carry), MINUTE - 1);
});

test("30 seconds from A plus 2 minutes from B becomes one 150-second B entry starting at B", () => {
  const tracker = machine();
  tracker.tick(snapshot(0, 0, { channel: channel("A"), mediaKey: "a" }));
  tracker.tick(snapshot(30 * SECOND, 30, { channel: channel("A"), mediaKey: "a" }));
  const changeEntries = tracker.tick(
    snapshot(30 * SECOND, 0, { channel: channel("B"), mediaKey: "b" }),
  );
  assert.deepEqual(changeEntries, []);
  assert.equal(carryDurationMs(tracker.record.carry), 30 * SECOND);

  tracker.tick(snapshot(150 * SECOND, 120, { channel: channel("B"), mediaKey: "b" }));
  const entries = finish(tracker, 150 * SECOND, 120, {
    channel: channel("B"),
    mediaKey: "b",
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].duration, 150);
  assert.equal(entries[0].description, "B");
  assert.equal(entries[0].start, new Date(30 * SECOND).toISOString());
  assert.equal(carryDurationMs(tracker.record.carry), 0);
});

test("several short sessions carry until their combined duration reaches one minute", () => {
  const tracker = machine();
  const channels = [channel("A"), channel("B"), channel("C")];
  tracker.tick(snapshot(0, 0, { channel: channels[0], mediaKey: "a" }));
  tracker.tick(snapshot(20 * SECOND, 20, { channel: channels[0], mediaKey: "a" }));
  tracker.tick(snapshot(20 * SECOND, 0, { channel: channels[1], mediaKey: "b" }));
  tracker.tick(snapshot(40 * SECOND, 20, { channel: channels[1], mediaKey: "b" }));
  tracker.tick(snapshot(40 * SECOND, 0, { channel: channels[2], mediaKey: "c" }));
  tracker.tick(snapshot(60 * SECOND, 20, { channel: channels[2], mediaKey: "c" }));
  const entries = finish(tracker, 60 * SECOND, 20, {
    channel: channels[2],
    mediaKey: "c",
  });

  assert.equal(entries.length, 1);
  assert.equal(entries[0].duration, 60);
  assert.equal(entries[0].description, "C");
  assert.equal(entries[0].start, new Date(40 * SECOND).toISOString());
});

test("discard mode permanently removes each sub-minimum session", () => {
  const tracker = machine({ mergeBelowMinimum: false });
  tracker.tick(snapshot(0, 0, { channel: channel("A"), mediaKey: "a" }));
  tracker.tick(snapshot(30 * SECOND, 30, { channel: channel("A"), mediaKey: "a" }));
  assert.deepEqual(
    tracker.tick(snapshot(30 * SECOND, 0, { channel: channel("B"), mediaKey: "b" })),
    [],
  );
  tracker.tick(snapshot(60 * SECOND, 30, { channel: channel("B"), mediaKey: "b" }));
  assert.deepEqual(
    finish(tracker, 60 * SECOND, 30, { channel: channel("B"), mediaKey: "b" }),
    [],
  );
  assert.equal(carryDurationMs(tracker.record.carry), 0);
});

test("separate tabs never consume one another's carry", () => {
  const first = machine({}, "tab-a");
  const second = machine({}, "tab-b");
  first.tick(snapshot(0, 0));
  first.tick(snapshot(30 * SECOND, 30));
  finish(first, 30 * SECOND, 30);
  second.tick(snapshot(0, 0, { channel: channel("B"), mediaKey: "b" }));
  second.tick(snapshot(40 * SECOND, 40, { channel: channel("B"), mediaKey: "b" }));
  finish(second, 40 * SECOND, 40, { channel: channel("B"), mediaKey: "b" });

  assert.equal(carryDurationMs(first.record.carry), 30 * SECOND);
  assert.equal(carryDurationMs(second.record.carry), 40 * SECOND);
});

test("carry survives serialization and supports explicit attachment and discard", () => {
  const sourceMachine = machine({}, "closed-tab");
  sourceMachine.tick(snapshot(0, 0));
  sourceMachine.tick(snapshot(30 * SECOND, 30));
  finish(sourceMachine, 30 * SECOND, 30);
  const persistedSource = JSON.parse(JSON.stringify(sourceMachine.record));
  const target = createTabRecord("current-tab", MINUTE);

  const attached = attachCarry(target, persistedSource, MINUTE);
  assert.equal(carryDurationMs(attached.target.carry), 30 * SECOND);
  assert.equal(carryDurationMs(attached.source.carry), 0);
  assert.equal(carryDurationMs(discardCarry(attached.target).carry), 0);
});

test("same-channel SPA navigation continues one session", () => {
  const tracker = machine({ minimumDurationMinutes: 0 });
  const sameChannel = channel("A");
  tracker.tick(snapshot(0, 0, { channel: sameChannel, mediaKey: "video-1" }));
  tracker.tick(snapshot(30 * SECOND, 30, { channel: sameChannel, mediaKey: "video-1" }));
  assert.deepEqual(
    tracker.tick(snapshot(30 * SECOND, 0, { channel: sameChannel, mediaKey: "video-2" })),
    [],
  );
  tracker.tick(snapshot(50 * SECOND, 20, { channel: sameChannel, mediaKey: "video-2" }));
  const entries = finish(tracker, 50 * SECOND, 20, {
    channel: sameChannel,
    mediaKey: "video-2",
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].duration, 50);
});

test("different-channel SPA navigation immediately finalizes the previous session", () => {
  const tracker = machine({ minimumDurationMinutes: 0 });
  tracker.tick(snapshot(0, 0, { channel: channel("A"), mediaKey: "a" }));
  tracker.tick(snapshot(20 * SECOND, 20, { channel: channel("A"), mediaKey: "a" }));
  const entries = tracker.tick(
    snapshot(20 * SECOND, 0, { channel: channel("B"), mediaKey: "b" }),
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0].description, "A");
  assert.equal(entries[0].duration, 20);
  assert.equal(tracker.record.active.channel.name, "B");
});

test("channel IDs take precedence, with channel-name fallback during identity upgrades", () => {
  assert.equal(channelsEqual({ id: "UC1", name: "Same" }, { id: "UC2", name: "Same" }), false);
  assert.equal(channelsEqual({ id: "", name: "Same" }, { id: "UC1", name: "same" }), true);
  assert.equal(channelFromVideoData({ channel_id: "UC9", author: "Creator" }).id, "UC9");
});

test("2× playback counts real elapsed wall time", () => {
  const tracker = machine({ minimumDurationMinutes: 0 });
  tracker.tick(snapshot(0, 0, { playbackRate: 2 }));
  tracker.tick(snapshot(MINUTE, 120, { playbackRate: 2 }));
  const entries = finish(tracker, MINUTE, 120, { playbackRate: 2 });
  assert.equal(entries[0].duration, 60);
});

test("seeks and media jumps are not counted", () => {
  const tracker = machine({ minimumDurationMinutes: 0 });
  tracker.tick(snapshot(0, 0));
  tracker.tick(snapshot(10 * SECOND, 10));
  tracker.tick(snapshot(11 * SECOND, 500, { discontinuityToken: 1 }));
  tracker.tick(snapshot(21 * SECOND, 510, { discontinuityToken: 1 }));
  const entries = finish(tracker, 21 * SECOND, 510, { discontinuityToken: 1 });
  assert.equal(entries[0].duration, 20);

  assert.equal(
    validatedPlaybackMs(snapshot(0, 0), snapshot(SECOND, 500)),
    0,
    "jump rejection also works without a seeking event",
  );
});

test("buffering and stalls contribute no watch time", () => {
  const tracker = machine({ minimumDurationMinutes: 0 });
  tracker.tick(snapshot(0, 0));
  tracker.tick(snapshot(10 * SECOND, 10));
  tracker.tick(snapshot(10 * SECOND, 10, { eligible: false, progressAllowed: true }));
  tracker.tick(snapshot(70 * SECOND, 10, { eligible: false, progressAllowed: true }));
  tracker.tick(snapshot(70 * SECOND, 10));
  tracker.tick(snapshot(80 * SECOND, 20));
  const entries = finish(tracker, 80 * SECOND, 20);
  assert.equal(entries[0].duration, 20);
});

test("YouTube-served ads are excluded without changing the content channel", () => {
  const tracker = machine({ minimumDurationMinutes: 0 });
  tracker.tick(snapshot(0, 0));
  tracker.tick(snapshot(30 * SECOND, 30));
  tracker.tick(
    snapshot(30 * SECOND, 0, {
      eligible: false,
      progressAllowed: false,
      channel: null,
      mediaKey: "ad",
    }),
  );
  tracker.tick(
    snapshot(90 * SECOND, 60, {
      eligible: false,
      progressAllowed: false,
      channel: null,
      mediaKey: "ad",
    }),
  );
  tracker.tick(snapshot(90 * SECOND, 30));
  tracker.tick(snapshot(120 * SECOND, 60));
  const entries = finish(tracker, 120 * SECOND, 60);
  assert.equal(entries[0].duration, 60);
});

test("live streams use the duration-independent playback state machine", () => {
  const tracker = machine({ minimumDurationMinutes: 0 });
  tracker.tick(snapshot(0, 5000, { mediaKey: "live", playedRanges: [[4990, 5000]] }));
  tracker.tick(snapshot(2 * MINUTE, 5120, { mediaKey: "live", playedRanges: [[4990, 5120]] }));
  const entries = finish(tracker, 2 * MINUTE, 5120, {
    mediaKey: "live",
    playedRanges: [[4990, 5120]],
  });
  assert.equal(entries[0].duration, 120);
});

test("active Shorts video selection prefers genuine playback", () => {
  const regularPaused = { paused: true, ended: false, readyState: 4, closest: () => null };
  const activeShort = { paused: false, ended: false, readyState: 4, closest: () => ({}) };
  const preloadedShort = { paused: true, ended: false, readyState: 4, closest: () => ({}) };
  assert.equal(selectActiveVideo([regularPaused, activeShort, preloadedShort]), activeShort);
});

test("global Sync finalizes simultaneous tabs independently and starts fresh sessions", () => {
  const first = machine({ minimumDurationMinutes: 0 }, "tab-a");
  const second = machine({ minimumDurationMinutes: 0 }, "tab-b");
  first.tick(snapshot(0, 0, { channel: channel("A"), mediaKey: "a" }));
  second.tick(snapshot(0, 0, { channel: channel("B"), mediaKey: "b" }));
  first.tick(snapshot(MINUTE, 60, { channel: channel("A"), mediaKey: "a" }));
  second.tick(snapshot(2 * MINUTE, 120, { channel: channel("B"), mediaKey: "b" }));

  const firstEntries = first.sync(snapshot(MINUTE, 60, { channel: channel("A"), mediaKey: "a" }));
  const secondEntries = second.sync(
    snapshot(2 * MINUTE, 120, { channel: channel("B"), mediaKey: "b" }),
  );
  assert.equal(firstEntries[0].duration, 60);
  assert.equal(secondEntries[0].duration, 120);
  assert.equal(first.record.active.durationMs, 0);
  assert.equal(second.record.active.durationMs, 0);
  assert.notEqual(first.record.active.id, second.record.active.id);
});

test("manual Sync keeps sub-minimum carry visible and starts fresh eligible playback", () => {
  const tracker = machine();
  tracker.tick(snapshot(0, 0));
  tracker.tick(snapshot(30 * SECOND, 30));
  const entries = tracker.sync(snapshot(30 * SECOND, 30));
  assert.deepEqual(entries, []);
  assert.equal(carryDurationMs(tracker.record.carry), 30 * SECOND);
  assert.equal(tracker.record.active.durationMs, 0);
});

test("page reload preserves the active session and never invents time during reload", () => {
  const beforeReload = machine({ minimumDurationMinutes: 0 });
  beforeReload.tick(snapshot(0, 0));
  beforeReload.tick(snapshot(30 * SECOND, 30));
  const persisted = JSON.parse(JSON.stringify(beforeReload.record));

  const afterReload = new SessionMachine(config({ minimumDurationMinutes: 0 }), persisted, {
    idFactory: idFactory("tab-1-reloaded"),
  });
  afterReload.tick(snapshot(30 * SECOND, 30));
  afterReload.tick(snapshot(60 * SECOND, 60));
  const entries = finish(afterReload, 60 * SECOND, 60);
  assert.equal(entries[0].duration, 60);
  assert.equal(entries[0].start, new Date(0).toISOString());
});

test("expired persisted sessions are recovered at the exact inactivity boundary", () => {
  const record = createTabRecord("closed", 0);
  record.active = {
    id: "closed-session",
    channel: channel("A"),
    firstPlayMs: 0,
    lastEligibleAtMs: MINUTE,
    durationMs: 2 * MINUTE,
  };
  assert.equal(recoverExpiredRecord(record, 11 * MINUTE - 1, config()).disposition, "unchanged");
  const recovered = recoverExpiredRecord(record, 11 * MINUTE, config());
  assert.equal(recovered.disposition, "queued");
  assert.equal(recovered.entry.duration, 120);
  assert.equal(recovered.record.active, null);
});

test("the local rolling-hour cap blocks the 31st attempt until the oldest expires", () => {
  const now = 10 * 60 * MINUTE;
  const attempts = Array.from({ length: 30 }, (_, index) => now - (30 - index) * SECOND);
  const state = rollingAttemptWindow(attempts, now, 30);
  assert.equal(state.allowed, false);
  assert.equal(state.retryAtMs, attempts[0] + 60 * MINUTE);
  assert.equal(rollingAttemptWindow(attempts.slice(1), now, 30).allowed, true);
});

test("request spacing enforces one attempt per second", () => {
  assert.equal(requestSpacingDelay(10_000, 10_250), 750);
  assert.equal(requestSpacingDelay(10_000, 11_000), 0);
  assert.equal(requestSpacingDelay(10_000, 12_000), 0);
  assert.equal(requestSpacingDelay(12_000, 10_000), 1000, "clock rollback cannot cause a long sleep");
});

test("wall time that advances during suspension is rejected when the monotonic clock does not", () => {
  const previous = snapshot(0, 0, { monotonicMs: 0 });
  const current = snapshot(60 * MINUTE, 3600, { monotonicMs: SECOND });
  assert.equal(validatedPlaybackMs(previous, current), 0);
});

test("Toggl quota headers are parsed and quota rejections remain pending", () => {
  const now = 1_000_000;
  const result = classifyAttempt(
    {
      type: "response",
      status: 402,
      responseHeaders: "X-Toggl-Quota-Remaining: 0\r\nX-Toggl-Quota-Resets-In: 90\r\n",
      responseText: "quota exhausted",
    },
    now,
  );
  assert.equal(result.status, "pending");
  assert.equal(result.nextAttemptAtMs, now + 90 * SECOND);
  assert.equal(result.quotaUntilMs, now + 90 * SECOND);

  assert.deepEqual(parseResponseHeaders("X-Test: one\r\nx-test: two\r\n"), {
    "x-test": "one, two",
  });
});

test("429 responses are known-unsent and retry later", () => {
  const now = 2_000_000;
  const result = classifyAttempt(
    {
      type: "response",
      status: 429,
      responseHeaders: "Retry-After: 12\r\nX-Toggl-Quota-Resets-In: 5\r\n",
      responseText: "",
    },
    now,
  );
  assert.equal(result.status, "pending");
  assert.equal(result.nextAttemptAtMs, now + 12 * SECOND);
});

test("authentication failures are blocked for an explicit correction and retry", () => {
  const result = classifyAttempt({ type: "response", status: 403, responseText: "Forbidden" });
  assert.equal(result.status, "blocked");
  assert.match(result.message, /authentication failed/i);
  assert.equal(result.stopWorker, true);
  assert.equal(result.authFailure, true);
  assert.equal(configFingerprint(config()), configFingerprint(config()));
  assert.notEqual(
    configFingerprint(config()),
    configFingerprint(config({ togglApiToken: "corrected-token" })),
  );
});

test("timeouts, interrupted sends, and 5xx outcomes are uncertain", () => {
  assert.equal(classifyAttempt({ type: "timeout" }).status, "uncertain");
  assert.equal(classifyAttempt({ type: "interrupted" }).status, "uncertain");
  assert.equal(classifyAttempt({ type: "response", status: 408, responseText: "" }).status, "uncertain");
  assert.equal(
    classifyAttempt({ type: "response", status: 503, responseText: "upstream timeout" }).status,
    "uncertain",
  );
});

test("an in-flight entry left by page closure requires an explicit decision", () => {
  const [entry] = markInterruptedRequestsUncertain([
    {
      id: "entry:in-flight",
      description: "A",
      start: new Date(0).toISOString(),
      duration: 60,
      status: "sending",
      sendingSinceMs: 1234,
    },
  ]);
  assert.equal(entry.status, "uncertain");
  assert.equal(entry.sendingSinceMs, 0);
  assert.match(entry.lastError, /check Toggl before retrying/i);
});

test("completed-entry payload is positive, includes optional project, and omits stop", () => {
  const entry = {
    description: "Creator",
    start: "2026-08-23T12:00:00.000Z",
    duration: 150,
  };
  const request = buildTogglRequest(entry, config({ togglProjectId: 456 }));
  assert.equal(request.url, "https://api.track.toggl.com/api/v9/workspaces/123/time_entries");
  assert.deepEqual(request.body, {
    workspace_id: 123,
    created_with: "yt-toggl",
    description: "Creator",
    start: "2026-08-23T12:00:00.000Z",
    duration: 150,
    project_id: 456,
  });
  assert.equal(Object.hasOwn(request.body, "stop"), false);
  assert.equal(encodeBasicAuth("abc"), "Basic YWJjOmFwaV90b2tlbg==");
});

test("queue insertion is idempotent across finalize-before-clear recovery", () => {
  const entry = {
    id: "entry:session-1",
    description: "A",
    start: new Date(0).toISOString(),
    duration: 60,
    status: "pending",
  };
  const queue = enqueueUnique([], [entry, entry]);
  assert.equal(queue.length, 1);
  assert.equal(normalizeQueue([entry, entry]).length, 1);
});

test("configuration accepts a zero minimum but rejects missing credentials", () => {
  assert.deepEqual(validateConfig(config({ minimumDurationMinutes: 0 })), []);
  const errors = validateConfig(config({ togglApiToken: "", togglWorkspaceId: 0 }));
  assert.equal(errors.length, 2);
});

test("userscript metadata is directly installable and declares only local dependencies", () => {
  const source = fs.readFileSync(require.resolve("../yt-toggl.user.js"), "utf8");
  assert.match(source, /\/\/ ==UserScript==/);
  assert.match(source, /\/\/ @match\s+https:\/\/www\.youtube\.com\/\*/);
  assert.match(source, /\/\/ @grant\s+GM_xmlhttpRequest/);
  assert.match(source, /\/\/ @grant\s+GM_getValue/);
  assert.match(source, /\/\/ @connect\s+api\.track\.toggl\.com/);
  assert.doesNotMatch(source, /\/\/ @require\b/);
});

test("browser bootstrap mounts status under Trusted Types enforcement and stays offline", async () => {
  function findById(node, id) {
    if (node.id === id) return node;
    for (const child of node.children) {
      const match = findById(child, id);
      if (match) return match;
    }
    return null;
  }

  function makeNode(tagName = "div") {
    const node = {
      tagName: tagName.toUpperCase(),
      id: "",
      children: [],
      dataset: {},
      classList: { contains: () => false },
      hidden: false,
      isConnected: false,
      textContent: "",
      addEventListener() {},
      setAttribute(name, value) {
        this[name] = value;
      },
      getAttribute() {
        return null;
      },
      querySelector() {
        return null;
      },
      closest() {
        return null;
      },
      appendChild(child) {
        this.children.push(child);
        child.isConnected = true;
        return child;
      },
      append(...children) {
        this.children.push(...children);
      },
      replaceChildren(...children) {
        this.children = children;
      },
      attachShadow() {
        const shadow = makeNode("shadow-root");
        shadow.getElementById = (id) => findById(shadow, id);
        Object.defineProperty(shadow, "innerHTML", {
          set() {
            throw new TypeError("This document requires 'TrustedHTML' assignment.");
          },
        });
        this.shadowRoot = shadow;
        return shadow;
      },
    };
    return node;
  }

  const body = makeNode("body");
  const documentElement = makeNode("html");
  const document = {
    body,
    documentElement,
    createElement: (tagName) => makeNode(tagName),
    querySelectorAll: () => [],
    querySelector: () => null,
    getElementById: () => null,
    addEventListener() {},
  };
  const values = new Map();
  const listeners = new Map();
  const sessionValues = new Map();
  let requestCount = 0;
  let sequence = 0;

  const context = {
    URL,
    TextEncoder,
    Date,
    Math,
    JSON,
    Promise,
    Symbol,
    console,
    document,
    location: {
      href: "https://www.youtube.com/watch?v=test",
      pathname: "/watch",
      search: "?v=test",
    },
    performance: { now: () => 1000 },
    crypto: { randomUUID: () => `uuid-${++sequence}` },
    navigator: {
      locks: {
        request: async (_name, _options, callback) => callback({ name: _name }),
      },
    },
    sessionStorage: {
      getItem: (key) => sessionValues.get(key) || null,
      setItem: (key, value) => sessionValues.set(key, value),
    },
    BroadcastChannel: class {
      addEventListener() {}
      postMessage() {}
      close() {}
    },
    GM_getValue: (key, fallback) => (values.has(key) ? values.get(key) : fallback),
    GM_setValue: (key, value) => {
      const oldValue = values.get(key);
      values.set(key, value);
      for (const callback of listeners.get(key) || []) callback(key, oldValue, value, false);
    },
    GM_deleteValue: (key) => values.delete(key),
    GM_listValues: () => [...values.keys()],
    GM_addValueChangeListener: (key, callback) => {
      if (!listeners.has(key)) listeners.set(key, []);
      listeners.get(key).push(callback);
      return listeners.get(key).length;
    },
    GM_xmlhttpRequest: () => {
      requestCount += 1;
    },
    unsafeWindow: {},
    btoa: (input) => Buffer.from(input, "binary").toString("base64"),
    setTimeout,
    clearTimeout,
    setInterval: () => 1,
    clearInterval() {},
  };
  context.window = {
    addEventListener() {},
    confirm: () => true,
  };

  const source = fs.readFileSync(require.resolve("../yt-toggl.user.js"), "utf8");
  vm.runInNewContext(source, context, { filename: "yt-toggl.user.js" });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(requestCount, 0);
  assert.equal(body.children.some((child) => child.id === "yt-toggl-status-host"), true);
  const tabKeys = [...values.keys()].filter((key) => key.startsWith("yt-toggl:tab:v1:"));
  assert.equal(tabKeys.length, 1);
  assert.equal(values.get(tabKeys[0]).active, null);
});
