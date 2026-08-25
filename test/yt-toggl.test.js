"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const {
  BrowserApp,
  SessionMachine,
  TogglWorker,
  attachCarry,
  beginCarryTransfer,
  buildTogglRequest,
  carryDurationMs,
  carryTransferIssue,
  channelFromVideoData,
  channelsEqual,
  classifyAttempt,
  completeCarryTransfer,
  configFingerprint,
  createCarryTransfer,
  createTabRecord,
  discardCarry,
  discardCarryTransferJournal,
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
  tabRecordIsPrunable,
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

function faultingStore(initialValues = {}) {
  const values = new Map(
    Object.entries(initialValues).map(([key, value]) => [key, JSON.parse(JSON.stringify(value))]),
  );
  let remainingMutations = null;
  const mutate = (callback) => {
    if (remainingMutations === 0) throw new Error("simulated storage interruption");
    if (remainingMutations !== null) remainingMutations -= 1;
    callback();
  };
  return {
    values,
    arm(successfulMutationsBeforeFailure) {
      remainingMutations = successfulMutationsBeforeFailure;
    },
    disarm() {
      remainingMutations = null;
    },
    get(key, fallback) {
      return JSON.parse(JSON.stringify(values.has(key) ? values.get(key) : fallback));
    },
    keys() {
      return [...values.keys()];
    },
    set(key, value) {
      mutate(() => values.set(key, JSON.parse(JSON.stringify(value))));
    },
    delete(key) {
      mutate(() => values.delete(key));
    },
  };
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

test("machine suspension closes an inactive session before resumed playback", () => {
  const tracker = machine({ minimumDurationMinutes: 0 });
  tracker.tick(snapshot(0, 0, { monotonicMs: 0 }));
  tracker.tick(snapshot(5 * MINUTE, 5 * 60, { monotonicMs: 5 * MINUTE }));
  tracker.tick(
    snapshot(5 * MINUTE, 5 * 60, {
      monotonicMs: 5 * MINUTE,
      eligible: false,
      progressAllowed: true,
    }),
  );
  const wakeMs = 3 * 60 * MINUTE + 5 * MINUTE;
  const wakeEntries = tracker.tick(
    snapshot(wakeMs, 5 * 60, { monotonicMs: 5 * MINUTE }),
  );
  assert.equal(wakeEntries.length, 1);
  assert.equal(wakeEntries[0].reason, "inactivity");
  assert.equal(wakeEntries[0].duration, 5 * 60);

  tracker.tick(
    snapshot(wakeMs + 2 * MINUTE, 7 * 60, { monotonicMs: 7 * MINUTE }),
  );
  const resumedEntries = finish(tracker, wakeMs + 2 * MINUTE, 7 * 60, {
    monotonicMs: 7 * MINUTE,
  });
  assert.equal(resumedEntries.length, 1);
  assert.equal(resumedEntries[0].duration, 2 * 60);
  assert.equal(resumedEntries[0].start, new Date(wakeMs).toISOString());
});

test("machine suspension closes a playing session before post-wake progress", () => {
  const tracker = machine({ minimumDurationMinutes: 0 });
  tracker.tick(snapshot(0, 0, { monotonicMs: 0 }));
  tracker.tick(snapshot(5 * MINUTE, 5 * 60, { monotonicMs: 5 * MINUTE }));

  const wakeMs = 3 * 60 * MINUTE + 5 * MINUTE + SECOND;
  const wakeEntries = tracker.tick(
    snapshot(wakeMs, 5 * 60 + 1, { monotonicMs: 5 * MINUTE + SECOND }),
  );
  assert.equal(wakeEntries.length, 1);
  assert.equal(wakeEntries[0].reason, "inactivity");
  assert.equal(wakeEntries[0].duration, 5 * 60);

  tracker.tick(
    snapshot(wakeMs + 2 * MINUTE, 7 * 60 + 1, {
      monotonicMs: 7 * MINUTE + SECOND,
    }),
  );
  const resumedEntries = finish(tracker, wakeMs + 2 * MINUTE, 7 * 60 + 1, {
    monotonicMs: 7 * MINUTE + SECOND,
  });
  assert.equal(resumedEntries.length, 1);
  assert.equal(resumedEntries[0].duration, 2 * 60 + 1);
  assert.equal(resumedEntries[0].start, new Date(wakeMs - SECOND).toISOString());
});

test("the wall inactivity deadline fires at its exact boundary when monotonic time is short", () => {
  const tracker = machine({ minimumDurationMinutes: 0 });
  tracker.tick(snapshot(0, 0, { monotonicMs: 0 }));
  tracker.tick(snapshot(MINUTE, 60, { monotonicMs: MINUTE }));
  tracker.tick(
    snapshot(MINUTE, 60, {
      monotonicMs: MINUTE,
      eligible: false,
      progressAllowed: true,
    }),
  );
  assert.deepEqual(
    tracker.tick(
      snapshot(11 * MINUTE - 1, 60, {
        monotonicMs: MINUTE + SECOND,
        eligible: false,
        progressAllowed: true,
      }),
    ),
    [],
  );
  const entries = tracker.tick(
    snapshot(11 * MINUTE, 60, {
      monotonicMs: MINUTE + 2 * SECOND,
      eligible: false,
      progressAllowed: true,
    }),
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0].reason, "inactivity");
});

test("a backward wall correction re-anchors suspension recovery", () => {
  const tracker = machine({ minimumDurationMinutes: 0 });
  const initialWallMs = 60 * MINUTE;
  tracker.tick(snapshot(initialWallMs, 0, { monotonicMs: 0 }));
  tracker.tick(snapshot(initialWallMs + MINUTE, 60, { monotonicMs: MINUTE }));
  tracker.tick(
    snapshot(initialWallMs + MINUTE, 60, {
      monotonicMs: MINUTE,
      eligible: false,
      progressAllowed: true,
    }),
  );

  const correctedWallMs = 30 * MINUTE;
  tracker.tick(
    snapshot(correctedWallMs, 60, {
      monotonicMs: MINUTE,
      eligible: false,
      progressAllowed: true,
    }),
  );
  assert.deepEqual(
    tracker.tick(
      snapshot(correctedWallMs + 10 * MINUTE - 1, 60, {
        monotonicMs: MINUTE,
        eligible: false,
        progressAllowed: true,
      }),
    ),
    [],
  );
  const entries = tracker.tick(
    snapshot(correctedWallMs + 10 * MINUTE, 60, {
      monotonicMs: MINUTE,
      eligible: false,
      progressAllowed: true,
    }),
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0].reason, "inactivity");
});

test("a recreated deadline re-anchors a persisted timestamp after a backward correction", () => {
  const record = createTabRecord("recreated-after-correction", 0);
  record.active = {
    id: "persisted-session",
    channel: channel("A"),
    firstPlayMs: 50 * MINUTE,
    lastEligibleAtMs: 60 * MINUTE,
    durationMs: 10 * MINUTE,
  };
  let tracker = new SessionMachine(config({ minimumDurationMinutes: 0 }), record);
  const correctedWallMs = 30 * MINUTE;
  assert.deepEqual(
    tracker.tick(
      snapshot(correctedWallMs, 10 * 60, {
        monotonicMs: 0,
        eligible: false,
        progressAllowed: true,
      }),
    ),
    [],
  );
  assert.equal(tracker.record.active.lastEligibleAtMs, correctedWallMs);
  tracker = new SessionMachine(config({ minimumDurationMinutes: 0 }), tracker.record);
  assert.deepEqual(
    tracker.tick(
      snapshot(correctedWallMs + 5 * MINUTE, 10 * 60, {
        monotonicMs: 0,
        eligible: false,
        progressAllowed: true,
      }),
    ),
    [],
  );
  assert.deepEqual(
    tracker.tick(
      snapshot(correctedWallMs + 10 * MINUTE - 1, 10 * 60, {
        monotonicMs: 0,
        eligible: false,
        progressAllowed: true,
      }),
    ),
    [],
  );
  const entries = tracker.tick(
    snapshot(correctedWallMs + 10 * MINUTE, 10 * 60, {
      monotonicMs: 0,
      eligible: false,
      progressAllowed: true,
    }),
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0].reason, "inactivity");
});

test("a backward wall re-anchor survives reload after part of the inactivity period", () => {
  const initialWallMs = 60 * MINUTE;
  let tracker = machine({ minimumDurationMinutes: 0 });
  tracker.tick(snapshot(initialWallMs, 0, { monotonicMs: 0 }));
  tracker.tick(snapshot(initialWallMs + MINUTE, 60, { monotonicMs: MINUTE }));
  tracker.tick(
    snapshot(initialWallMs + MINUTE, 60, {
      monotonicMs: MINUTE,
      eligible: false,
      progressAllowed: true,
    }),
  );

  const correctedWallMs = 30 * MINUTE;
  tracker.tick(
    snapshot(correctedWallMs, 60, {
      monotonicMs: MINUTE,
      eligible: false,
      progressAllowed: true,
    }),
  );
  assert.equal(tracker.record.active.lastEligibleAtMs, correctedWallMs);

  tracker = new SessionMachine(config({ minimumDurationMinutes: 0 }), tracker.record);
  assert.deepEqual(
    tracker.tick(
      snapshot(correctedWallMs + 5 * MINUTE, 60, {
        monotonicMs: 0,
        eligible: false,
        progressAllowed: true,
      }),
    ),
    [],
  );
  assert.deepEqual(
    tracker.tick(
      snapshot(correctedWallMs + 10 * MINUTE - 1, 60, {
        monotonicMs: 0,
        eligible: false,
        progressAllowed: true,
      }),
    ),
    [],
  );
  const entries = tracker.tick(
    snapshot(correctedWallMs + 10 * MINUTE, 60, {
      monotonicMs: 0,
      eligible: false,
      progressAllowed: true,
    }),
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0].reason, "inactivity");
});

test("validated delayed background playback resets both inactivity deadlines", () => {
  const tracker = machine({ minimumDurationMinutes: 0 });
  tracker.tick(snapshot(0, 0, { monotonicMs: 0 }));
  assert.deepEqual(
    tracker.tick(snapshot(11 * MINUTE, 11 * 60, { monotonicMs: 11 * MINUTE })),
    [],
  );
  const entries = finish(tracker, 11 * MINUTE, 11 * 60, {
    monotonicMs: 11 * MINUTE,
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].duration, 11 * 60);
});

test("delayed progress bridges only gaps shorter than the inactivity boundary", () => {
  const continuous = machine({ minimumDurationMinutes: 0 }, "continuous-gap");
  continuous.tick(snapshot(0, 0, { monotonicMs: 0 }));
  continuous.tick(snapshot(5 * MINUTE, 5 * 60, { monotonicMs: 5 * MINUTE }));
  assert.deepEqual(
    continuous.tick(snapshot(16 * MINUTE, 7 * 60, { monotonicMs: 16 * MINUTE })),
    [],
  );
  const continuousEntries = finish(continuous, 16 * MINUTE, 7 * 60, {
    monotonicMs: 16 * MINUTE,
  });
  assert.equal(continuousEntries.length, 1);
  assert.equal(continuousEntries[0].duration, 7 * 60);

  const expired = machine({ minimumDurationMinutes: 0 }, "expired-gap");
  expired.tick(snapshot(0, 0, { monotonicMs: 0 }));
  expired.tick(snapshot(5 * MINUTE, 5 * 60, { monotonicMs: 5 * MINUTE }));
  const expiredEntries = expired.tick(
    snapshot(17 * MINUTE, 7 * 60, { monotonicMs: 17 * MINUTE }),
  );
  assert.equal(expiredEntries.length, 1);
  assert.equal(expiredEntries[0].reason, "inactivity");
  assert.equal(expiredEntries[0].duration, 5 * 60);
  assert.equal(expired.record.active.durationMs, 2 * MINUTE);
  assert.equal(expired.record.active.firstPlayMs, 15 * MINUTE);
});

test("recreated machines preserve a seeded monotonic inactivity deadline", () => {
  const record = createTabRecord("recreated", 0);
  record.active = {
    id: "persisted-session",
    channel: channel("A"),
    firstPlayMs: 0,
    lastEligibleAtMs: 0,
    durationMs: MINUTE,
  };
  let tracker = new SessionMachine(config({ minimumDurationMinutes: 0 }), record);
  assert.deepEqual(
    tracker.tick(
      snapshot(10 * MINUTE - 1, 60, {
        monotonicMs: 5 * SECOND,
        eligible: false,
        progressAllowed: true,
      }),
    ),
    [],
  );
  tracker = new SessionMachine(config({ minimumDurationMinutes: 0 }), tracker.record, {
    inactivityDeadline: tracker.inactivityDeadline,
  });
  const entries = tracker.tick(
    snapshot(0, 60, {
      monotonicMs: 5 * SECOND + 1,
      eligible: false,
      progressAllowed: true,
    }),
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0].reason, "inactivity");
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

test("persisted carry transfers recover every interrupted write without duplication or loss", () => {
  const journalKey = "yt-toggl:carry-transfer:v1";
  const sourceKey = "yt-toggl:tab:v1:source";
  const targetKey = "yt-toggl:tab:v1:target";

  for (let cut = 0; cut <= 3; cut += 1) {
    const source = createTabRecord("source", 0);
    source.carry = {
      parts: [{ id: "moved", durationMs: 30 * SECOND, sourceTabId: "source", createdAtMs: 1 }],
    };
    const target = createTabRecord("target", 0);
    target.carry = {
      parts: [{ id: "existing", durationMs: 5 * SECOND, sourceTabId: "target", createdAtMs: 1 }],
    };
    const transfer = createCarryTransfer(source, "target", "target-instance", 100, () => "transfer-1");
    const store = faultingStore({ [sourceKey]: source, [targetKey]: target });
    store.arm(cut);
    assert.throws(
      () => beginCarryTransfer(store, transfer),
      /simulated storage interruption/,
      `cut ${cut} should interrupt the durable sequence`,
    );
    store.disarm();

    if (store.values.has(journalKey)) {
      completeCarryTransfer(store);
      assert.equal(completeCarryTransfer(store), null, "recovery itself is idempotent");
    }

    const recoveredSource = store.get(sourceKey, createTabRecord("source", 0));
    const recoveredTarget = store.get(targetKey, createTabRecord("target", 0));
    const sourceIds = recoveredSource.carry.parts.map((part) => part.id);
    const targetIds = recoveredTarget.carry.parts.map((part) => part.id);
    assert.equal(store.values.has(journalKey), false);
    assert.equal(targetIds.includes("existing"), true);
    assert.equal(
      [...sourceIds, ...targetIds].filter((id) => id === "moved").length,
      1,
      `cut ${cut} must leave one global copy`,
    );
    assert.equal(targetIds.includes("moved"), cut > 0);
    assert.equal(sourceIds.includes("moved"), cut === 0);
  }
});

test("carry transfer recovery preserves later source state and newer target ownership", () => {
  const sourceKey = "yt-toggl:tab:v1:source";
  const targetKey = "yt-toggl:tab:v1:target";
  const source = createTabRecord("source", 0);
  source.carry = {
    parts: [{ id: "moved", durationMs: 30 * SECOND, sourceTabId: "source", createdAtMs: 1 }],
  };
  const target = createTabRecord("target", 0);
  const transfer = createCarryTransfer(source, "target", "old-target-instance", 100, () => "transfer-1");
  const store = faultingStore({ [sourceKey]: source, [targetKey]: target });
  store.arm(2);
  assert.throws(() => beginCarryTransfer(store, transfer), /simulated storage interruption/);
  store.disarm();

  const revivedSource = store.get(sourceKey, null);
  revivedSource.active = {
    id: "new-source-session",
    channel: channel("Source"),
    firstPlayMs: 200,
    lastEligibleAtMs: 200,
    durationMs: 0,
  };
  revivedSource.carry.parts.push({
    id: "later",
    durationMs: 7 * SECOND,
    sourceTabId: "source",
    createdAtMs: 200,
  });
  store.values.set(sourceKey, revivedSource);
  const revivedTarget = store.get(targetKey, null);
  revivedTarget.heartbeatMs = 300;
  revivedTarget.instanceId = "new-target-instance";
  store.values.set(targetKey, revivedTarget);

  const result = completeCarryTransfer(store);
  assert.deepEqual(result.source.carry.parts.map((part) => part.id), ["later"]);
  assert.equal(result.source.active.id, "new-source-session");
  assert.deepEqual(result.target.carry.parts.map((part) => part.id), ["moved"]);
  assert.equal(result.target.heartbeatMs, 300);
  assert.equal(result.target.instanceId, "new-target-instance");

  const targetWithoutInstance = createTabRecord("target-without-instance", 300);
  const secondTransfer = createCarryTransfer(
    source,
    "target-without-instance",
    "recovered-target-instance",
    100,
    () => "transfer-2",
  );
  const secondStore = faultingStore({
    [sourceKey]: source,
    "yt-toggl:tab:v1:target-without-instance": targetWithoutInstance,
  });
  const secondResult = beginCarryTransfer(secondStore, secondTransfer);
  assert.equal(secondResult.target.heartbeatMs, 300);
  assert.equal(secondResult.target.instanceId, "recovered-target-instance");
});

test("carry transfer recovery survives interruptions while removing legacy owners", () => {
  const part = { id: "moved", durationMs: 30 * SECOND, sourceTabId: "source", createdAtMs: 1 };
  const unrelated = (id, sourceTabId) => ({
    id,
    durationMs: SECOND,
    sourceTabId,
    createdAtMs: 2,
  });

  for (let cut = 1; cut <= 5; cut += 1) {
    const source = createTabRecord("source", 0);
    source.carry = { parts: [part] };
    const target = createTabRecord("target", 0);
    const oldA = createTabRecord("old-a", 0);
    oldA.carry = { parts: [part, unrelated("keep-a", "old-a")] };
    oldA.active = {
      id: "active-a",
      channel: channel("A"),
      firstPlayMs: 10,
      lastEligibleAtMs: 10,
      durationMs: 10,
    };
    const oldB = createTabRecord("old-b", 0);
    oldB.carry = { parts: [unrelated("keep-b", "old-b"), part] };
    const store = faultingStore({
      "yt-toggl:tab:v1:source": source,
      "yt-toggl:tab:v1:target": target,
      "yt-toggl:tab:v1:old-a": oldA,
      "yt-toggl:tab:v1:old-b": oldB,
    });
    const transfer = createCarryTransfer(source, "target", "target-instance", 100, () => "transfer");

    store.arm(cut);
    assert.throws(() => beginCarryTransfer(store, transfer), /simulated storage interruption/);
    store.disarm();
    completeCarryTransfer(store);

    const records = [...store.values.entries()].filter(([key]) =>
      key.startsWith("yt-toggl:tab:v1:"),
    );
    assert.deepEqual(
      records
        .filter(([_key, value]) => value.carry.parts.some((candidate) => candidate.id === part.id))
        .map(([key]) => key),
      ["yt-toggl:tab:v1:target"],
      `cut ${cut} leaves one designated owner`,
    );
    assert.deepEqual(store.get("yt-toggl:tab:v1:old-a", null).carry.parts.map(({ id }) => id), [
      "keep-a",
    ]);
    assert.equal(store.get("yt-toggl:tab:v1:old-a", null).active.id, "active-a");
    assert.deepEqual(store.get("yt-toggl:tab:v1:old-b", null).carry.parts.map(({ id }) => id), [
      "keep-b",
    ]);
  }
});

test("an explicit transfer removes legacy duplicate parts from every non-target tab", () => {
  const part = { id: "legacy-duplicate", durationMs: 30 * SECOND, sourceTabId: "source", createdAtMs: 1 };
  const source = createTabRecord("source", 0);
  source.carry = { parts: [part] };
  const oldTarget = createTabRecord("old-target", 0);
  oldTarget.carry = { parts: [part] };
  const newTarget = createTabRecord("new-target", 0);
  const store = faultingStore({
    "yt-toggl:tab:v1:source": source,
    "yt-toggl:tab:v1:old-target": oldTarget,
    "yt-toggl:tab:v1:new-target": newTarget,
  });
  const transfer = createCarryTransfer(source, "new-target", "new-instance", 100, () => "transfer-1");
  beginCarryTransfer(store, transfer);

  const owners = [...store.values.entries()]
    .filter(([key]) => key.startsWith("yt-toggl:tab:v1:"))
    .filter(([_key, record]) => record.carry.parts.some((candidate) => candidate.id === part.id))
    .map(([key]) => key);
  assert.deepEqual(owners, ["yt-toggl:tab:v1:new-target"]);
});

test("unreadable carry journals are preserved without blocking unrelated tab mutation", async () => {
  const journalKey = "yt-toggl:carry-transfer:v1";
  for (const [rawTransfer, kind] of [
    [{ schemaVersion: 1, id: "broken" }, "malformed"],
    [{ schemaVersion: 2, id: "from-a-newer-version" }, "unsupported-schema"],
    [
      {
        schemaVersion: 1,
        id: "partially-damaged",
        sourceTabId: "source",
        targetTabId: "target",
        parts: [
          { id: "valid", durationMs: SECOND, sourceTabId: "source", createdAtMs: 1 },
          { id: "damaged", durationMs: 0, sourceTabId: "source", createdAtMs: 1 },
        ],
      },
      "malformed",
    ],
    ...["", "   "].map((partId) => [
      {
        schemaVersion: 1,
        id: `bad-part-${JSON.stringify(partId)}`,
        sourceTabId: "source",
        targetTabId: "target",
        parts: [{ id: partId, durationMs: SECOND, sourceTabId: "source", createdAtMs: 1 }],
      },
      "malformed",
    ]),
  ]) {
    const store = faultingStore({ [journalKey]: rawTransfer });
    const result = completeCarryTransfer(store);
    assert.equal(result.status, "unreadable");
    assert.equal(result.kind, kind);
    assert.deepEqual(result.rawTransfer, rawTransfer);
    assert.deepEqual(store.get(journalKey, null), rawTransfer);
  }

  const invalid = { schemaVersion: 1, id: "still-broken" };
  const store = faultingStore({ [journalKey]: invalid });
  const app = Object.create(BrowserApp.prototype);
  app.store = store;
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      locks: {
        request: async (_name, _options, callback) => callback({ name: _name }),
      },
    },
  });
  try {
    await app.withTabsLock(() => store.set("unrelated-mutation", { completed: true }));
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    else delete globalThis.navigator;
  }
  assert.deepEqual(store.get("unrelated-mutation", null), { completed: true });
  assert.deepEqual(store.get(journalKey, null), invalid);
});

test("discarding an unreadable journal is exact and never mutates saved tab carry", () => {
  const journalKey = "yt-toggl:carry-transfer:v1";
  const part = { id: "carry", durationMs: 30 * SECOND, sourceTabId: "source", createdAtMs: 1 };
  const source = createTabRecord("source", 0);
  source.carry = { parts: [part] };
  const target = createTabRecord("target", 0);
  const rawTransfer = {
    schemaVersion: 2,
    id: "future-transfer",
    sourceTabId: "source",
    targetTabId: "target",
    parts: [part],
  };
  const store = faultingStore({
    [journalKey]: rawTransfer,
    "yt-toggl:tab:v1:source": source,
    "yt-toggl:tab:v1:target": target,
  });
  const originalSource = store.get("yt-toggl:tab:v1:source", null);
  const originalTarget = store.get("yt-toggl:tab:v1:target", null);
  const issue = carryTransferIssue(rawTransfer);
  const validTransfer = createCarryTransfer(source, "target", "target-instance", 100, () => "valid");

  assert.throws(
    () => discardCarryTransferJournal(store, `${issue.fingerprint}:stale`),
    /changed and was not discarded/i,
  );
  assert.throws(
    () => beginCarryTransfer(store, validTransfer),
    /another carry transfer must be recovered/i,
  );
  assert.equal(discardCarryTransferJournal(store, issue.fingerprint), true);
  assert.equal(store.get(journalKey, null), null);
  assert.deepEqual(store.get("yt-toggl:tab:v1:source", null), originalSource);
  assert.deepEqual(store.get("yt-toggl:tab:v1:target", null), originalTarget);

  beginCarryTransfer(store, validTransfer);
  assert.deepEqual(
    store.get("yt-toggl:tab:v1:target", null).carry.parts.map(({ id }) => id),
    ["carry"],
  );
});

test("only foreign stale empty tab records are prunable", () => {
  const stale = createTabRecord("stale", 0);
  assert.equal(tabRecordIsPrunable(stale, "current", 10 * MINUTE - 1, config()), false);
  assert.equal(tabRecordIsPrunable(stale, "current", 10 * MINUTE, config()), true);
  assert.equal(tabRecordIsPrunable(stale, "stale", 10 * MINUTE, config()), false);

  stale.active = {
    id: "zero-duration",
    channel: channel("A"),
    firstPlayMs: 0,
    lastEligibleAtMs: 0,
    durationMs: 0,
  };
  assert.equal(tabRecordIsPrunable(stale, "current", 10 * MINUTE, config()), false);
  stale.active = null;
  stale.carry = {
    parts: [{ id: "carry", durationMs: 1, sourceTabId: "stale", createdAtMs: 1 }],
  };
  assert.equal(tabRecordIsPrunable(stale, "current", 10 * MINUTE, config()), false);
});

test("simultaneous duplicate resolvers leave exactly one owner of the persisted tab ID", async () => {
  const candidateTabId = "shared-tab";
  const apps = [Object.create(BrowserApp.prototype), Object.create(BrowserApp.prototype)];
  for (const [index, app] of apps.entries()) {
    Object.assign(app, {
      store: {},
      tabId: candidateTabId,
      reusedTabId: true,
      instanceId: `instance-${index}`,
      sample: { existing: true },
      inactivityDeadline: { sessionId: "session", atMonotonicMs: 1 },
    });
    app.probeTab = async (tabId) =>
      apps.some((other) => other !== app && other.tabId === tabId);
  }

  const lockTails = new Map();
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const sessionStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      locks: {
        async request(name, _options, callback) {
          const previous = lockTails.get(name) || Promise.resolve();
          let release;
          const gate = new Promise((resolve) => {
            release = resolve;
          });
          lockTails.set(name, previous.then(() => gate));
          await previous;
          try {
            return await callback({ name });
          } finally {
            release();
          }
        },
      },
    },
  });
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: { setItem() {} },
  });
  try {
    await Promise.all(apps.map((app) => app.resolveDuplicatedTabId()));
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    else delete globalThis.navigator;
    if (sessionStorageDescriptor) {
      Object.defineProperty(globalThis, "sessionStorage", sessionStorageDescriptor);
    } else {
      delete globalThis.sessionStorage;
    }
  }

  assert.equal(apps.filter((app) => app.tabId === candidateTabId).length, 1);
  assert.equal(new Set(apps.map((app) => app.tabId)).size, 2);
});

test("overlapping BFCache duplicate resolutions ignore an older probe result", async () => {
  const candidateTabId = "restored-tab";
  const app = Object.create(BrowserApp.prototype);
  Object.assign(app, {
    store: {},
    tabId: candidateTabId,
    reusedTabId: true,
    identityResolved: false,
    identityGeneration: 1,
    instanceId: "restored-instance",
    sample: { existing: true },
    inactivityDeadline: { sessionId: "session", atMonotonicMs: 1 },
  });

  let firstProbeCount = 0;
  let signalFirstProbesStarted;
  const firstProbesStarted = new Promise((resolve) => {
    signalFirstProbesStarted = resolve;
  });
  const releaseFirstProbes = [];
  let probeCount = 0;
  app.probeTab = () => {
    probeCount += 1;
    if (probeCount > 2) return Promise.resolve(true);
    return new Promise((resolve) => {
      releaseFirstProbes.push(resolve);
      firstProbeCount += 1;
      if (firstProbeCount === 2) signalFirstProbesStarted();
    });
  };

  const lockTails = new Map();
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const sessionStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      locks: {
        async request(name, _options, callback) {
          const previous = lockTails.get(name) || Promise.resolve();
          let release;
          const gate = new Promise((resolve) => {
            release = resolve;
          });
          lockTails.set(name, previous.then(() => gate));
          await previous;
          try {
            return await callback({ name });
          } finally {
            release();
          }
        },
      },
    },
  });
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: { setItem() {} },
  });

  try {
    const olderResolution = app.resolveDuplicatedTabId(1);
    await firstProbesStarted;

    app.identityGeneration = 2;
    app.reusedTabId = true;
    const newerResolution = app.resolveDuplicatedTabId(2);
    for (const resolve of releaseFirstProbes) resolve(false);

    assert.equal(await olderResolution, null);
    const resolvedIdentity = await newerResolution;
    assert.notEqual(resolvedIdentity, null);
    assert.equal(app.markIdentityResolved(resolvedIdentity), true);
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    else delete globalThis.navigator;
    if (sessionStorageDescriptor) {
      Object.defineProperty(globalThis, "sessionStorage", sessionStorageDescriptor);
    } else {
      delete globalThis.sessionStorage;
    }
  }

  assert.notEqual(app.tabId, candidateTabId);
  assert.equal(app.identityGeneration, 3);
  assert.equal(app.identityResolved, true);
  assert.equal(probeCount, 4);
});

test("tab recovery probes before locking and defers records changed during the probe", async () => {
  const current = createTabRecord("current", Date.now());
  const staleRecord = (tabId, sessionId, channelName) => {
    const record = createTabRecord(tabId, 0);
    record.instanceId = `${tabId}-instance`;
    record.active = {
      id: sessionId,
      channel: channel(channelName),
      firstPlayMs: 0,
      lastEligibleAtMs: 0,
      durationMs: MINUTE,
    };
    return record;
  };
  const unchanged = staleRecord("unchanged", "unchanged-session", "Unchanged");
  const changedBeforeProbe = staleRecord("changed", "old-session", "Changed");
  const changedAfterProbe = staleRecord("changed", "replacement-session", "Changed");
  const newlyEligible = staleRecord("new", "new-session", "New");
  let insideLock = false;
  let releaseProbe;
  let recordsReadCount = 0;
  const probedTabIds = [];
  const queued = [];
  const deleted = [];
  const written = [];
  const app = Object.create(BrowserApp.prototype);
  Object.assign(app, {
    config: config({ minimumDurationMinutes: 0 }),
    tabId: "current",
    instanceId: "current-instance",
    inactivityDeadline: null,
    queue: {
      get: () => [],
      async add(entries) {
        queued.push(...entries);
      },
      async remove() {},
    },
    store: {
      set(key, value) {
        written.push([key, value]);
      },
      delete(key) {
        deleted.push(key);
      },
    },
    getAllTabRecords() {
      recordsReadCount += 1;
      return recordsReadCount === 1
        ? [current, unchanged, changedBeforeProbe]
        : [current, unchanged, changedAfterProbe, newlyEligible];
    },
    getOwnRecord() {
      return createTabRecord("current", Date.now());
    },
    probeTabs(tabIds) {
      probedTabIds.push(...tabIds);
      return new Promise((resolve) => {
        releaseProbe = resolve;
      });
    },
    withTabsLock(callback) {
      insideLock = true;
      return callback();
    },
  });

  const recovery = app.recoverTabs();
  assert.deepEqual(probedTabIds.sort(), ["changed", "unchanged"]);
  assert.equal(insideLock, false, "probe timers must not run under the tabs lock");
  releaseProbe({ live: new Set(), indeterminate: new Set() });
  await recovery;

  assert.equal(insideLock, true);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].description, "Unchanged");
  assert.deepEqual(deleted, ["yt-toggl:tab:v1:unchanged"]);
  assert.equal(
    deleted.includes("yt-toggl:tab:v1:changed") || deleted.includes("yt-toggl:tab:v1:new"),
    false,
  );
  assert.equal(
    written.some(([key]) =>
      ["yt-toggl:tab:v1:changed", "yt-toggl:tab:v1:new"].includes(key),
    ),
    false,
  );
});

test("BFCache identity invalidation cancels recovery after its out-of-lock probe", async () => {
  const current = createTabRecord("old-tab", Date.now());
  const foreign = createTabRecord("foreign", 0);
  foreign.instanceId = "foreign-instance";
  foreign.active = {
    id: "foreign-session",
    channel: channel("Foreign"),
    firstPlayMs: 0,
    lastEligibleAtMs: 0,
    durationMs: MINUTE,
  };
  let releaseProbe;
  let enteredTabsLock = false;
  const app = Object.create(BrowserApp.prototype);
  Object.assign(app, {
    config: config({ minimumDurationMinutes: 0 }),
    tabId: "old-tab",
    instanceId: "old-instance",
    identityResolved: true,
    identityGeneration: 0,
    inactivityDeadline: null,
    getAllTabRecords: () => [current, foreign],
    probeTabs: () =>
      new Promise((resolve) => {
        releaseProbe = resolve;
      }),
    withTabsLock() {
      enteredTabsLock = true;
    },
  });

  const recovery = app.recoverTabs();
  app.identityResolved = false;
  app.identityGeneration += 1;
  releaseProbe({ live: new Set(), indeterminate: new Set() });
  await recovery;
  assert.equal(enteredTabsLock, false);
});

test("identity invalidation during queue persistence prevents an old-tab commit", async () => {
  let releaseQueue;
  let queueStarted = false;
  const removedEntries = [];
  const writes = [];
  let workerKicks = 0;
  const app = Object.create(BrowserApp.prototype);
  Object.assign(app, {
    tabId: "old-tab",
    instanceId: "old-instance",
    identityResolved: true,
    identityGeneration: 0,
    sample: "old-sample",
    inactivityDeadline: "old-deadline",
    queue: {
      get: () => [],
      add() {
        queueStarted = true;
        return new Promise((resolve) => {
          releaseQueue = resolve;
        });
      },
      async remove(entryId) {
        removedEntries.push(entryId);
      },
    },
    store: { set: (key, value) => writes.push([key, value]) },
    worker: { kick: () => (workerKicks += 1) },
  });
  const machineState = {
    record: createTabRecord("old-tab", 0),
    sample: "new-sample",
    inactivityDeadline: "new-deadline",
  };
  const identity = app.captureIdentity();
  const commit = app.commitMachine(machineState, [{ id: "queued" }], 100, "", identity);
  assert.equal(queueStarted, true);
  app.identityResolved = false;
  app.identityGeneration += 1;
  releaseQueue();
  assert.equal(await commit, false);
  assert.deepEqual(removedEntries, ["queued"]);
  assert.deepEqual(writes, []);
  assert.equal(app.sample, "old-sample");
  assert.equal(app.inactivityDeadline, "old-deadline");
  assert.equal(workerKicks, 0);
});

test("queued carry actions are cancelled when their captured tab identity is invalidated", async () => {
  let releaseEarlierOperation;
  let enteredTabsLock = false;
  const app = Object.create(BrowserApp.prototype);
  Object.assign(app, {
    tabId: "old-tab",
    identityResolved: true,
    identityGeneration: 0,
    operation: new Promise((resolve) => {
      releaseEarlierOperation = resolve;
    }),
    status: { render() {} },
    withTabsLock() {
      enteredTabsLock = true;
    },
  });
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { confirm: () => true },
  });
  try {
    const discard = app.discardCurrentCarry();
    app.identityResolved = false;
    app.identityGeneration += 1;
    releaseEarlierOperation();
    await discard;
  } finally {
    if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
    else delete globalThis.window;
  }
  assert.equal(enteredTabsLock, false);
});

test("browser startup mounts status before duplicate-tab resolution completes", async () => {
  const calls = [];
  const commands = [];
  let releaseIdentity;
  const app = Object.create(BrowserApp.prototype);
  Object.assign(app, {
    tabId: "startup-tab",
    reusedTabId: false,
    identityResolved: false,
    identityGeneration: 0,
    status: {
      mount() {
        calls.push("mount");
        app.broadcastSync();
      },
      render: () => calls.push("render"),
    },
    intervals: [],
    worker: { kick: () => calls.push("worker") },
    store: { set: (_key, value) => commands.push(value) },
    handleSync: () => calls.push("sync"),
    resolveDuplicatedTabId() {
      calls.push("resolve-start");
      return new Promise((resolve) => {
        releaseIdentity = () =>
          resolve({ tabId: app.tabId, generation: app.identityGeneration });
      });
    },
    recoverTabs: async () => calls.push("recover"),
    bindEvents: () => calls.push("bind"),
    tick: async () => calls.push("tick"),
  });
  const originalSetInterval = globalThis.setInterval;
  globalThis.setInterval = () => 1;
  try {
    const starting = app.start();
    assert.deepEqual(calls, ["mount", "resolve-start"]);
    assert.equal(commands.length, 0, "the mounted controls cannot mutate a reused tab ID");
    releaseIdentity();
    await starting;
  } finally {
    globalThis.setInterval = originalSetInterval;
  }
  assert.deepEqual(calls, [
    "mount",
    "resolve-start",
    "render",
    "recover",
    "bind",
    "tick",
    "worker",
  ]);
  app.broadcastSync();
  assert.equal(commands.length, 1);
  assert.equal(calls.at(-1), "sync");
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

test("media discovery stays neutral until player identity matches the watch route", () => {
  let nowMs = 0;
  let monotonicMs = 0;
  let mediaTime = 0;
  let adShowing = false;
  let playerData = { video_id: "video-a", channel_id: "UC-A", author: "A" };
  const pageWindow = {
    ytInitialPlayerResponse: {
      videoDetails: { videoId: "video-b", channelId: "UC-B", author: "B" },
    },
  };
  class FakeDate extends Date {
    static now() {
      return nowMs;
    }
  }
  const player = {
    classList: {
      contains(name) {
        return adShowing && (name === "ad-showing" || name === "ad-interrupting");
      },
    },
    getVideoData() {
      return playerData;
    },
  };
  const video = {
    paused: false,
    ended: false,
    readyState: 4,
    seeking: false,
    playbackRate: 1,
    currentSrc: "blob:video-b",
    get currentTime() {
      return mediaTime;
    },
    played: {
      length: 1,
      start: () => 0,
      end: () => mediaTime,
    },
    closest(selector) {
      return selector === "#movie_player" || selector === ".html5-video-player" ? player : null;
    },
  };
  let globalPlayer = player;
  const document = {
    querySelectorAll: () => [video],
    querySelector: () => null,
    getElementById: (id) => (id === "movie_player" ? globalPlayer : null),
  };
  const context = {
    URL,
    TextEncoder,
    Date: FakeDate,
    Math,
    JSON,
    Promise,
    Symbol,
    document,
    location: {
      href: "https://www.youtube.com/watch?v=video-b",
      pathname: "/watch",
      search: "?v=video-b",
    },
    performance: { now: () => monotonicMs },
    unsafeWindow: pageWindow,
    module: { exports: {} },
  };
  const source = fs.readFileSync(require.resolve("../yt-toggl.user.js"), "utf8");
  vm.runInNewContext(source, context, { filename: "yt-toggl.user.js" });
  const core = context.module.exports;
  const tracker = new core.SessionMachine(config(), core.createTabRecord("tab", 0), {
    idFactory: idFactory("identity"),
  });

  const firstStale = core.discoverMedia(0);
  nowMs = 2 * SECOND;
  monotonicMs = 2 * SECOND;
  mediaTime = 2;
  const secondStale = core.discoverMedia(0);
  for (const stale of [firstStale, secondStale]) {
    assert.equal(stale.eligible, false);
    assert.equal(stale.channel, null);
    assert.equal(stale.mediaKey, "");
    tracker.tick(stale);
  }
  assert.equal(tracker.record.active, null);
  assert.equal(carryDurationMs(tracker.record.carry), 0);

  playerData = { video_id: "video-b", channel_id: "UC-B", author: "B" };
  nowMs = 3 * SECOND;
  monotonicMs = 3 * SECOND;
  mediaTime = 3;
  const coherent = core.discoverMedia(0);
  assert.equal(coherent.eligible, true);
  assert.equal(coherent.channel.id, "UC-B");
  assert.equal(coherent.mediaKey, "video-b");
  tracker.tick(coherent);
  assert.equal(tracker.record.active.channel.id, "UC-B");
  assert.equal(carryDurationMs(tracker.record.carry), 0);

  playerData = { channel_id: "UC-A", author: "A" };
  const initialFallback = core.discoverMedia(0);
  assert.equal(initialFallback.channel.id, "UC-B");
  pageWindow.ytInitialPlayerResponse = {
    videoDetails: { channelId: "UC-B", author: "B" },
  };
  const unidentified = core.discoverMedia(0);
  assert.equal(unidentified.eligible, false);
  assert.equal(unidentified.channel, null);

  context.location.href = "https://www.youtube.com/shorts/video-b";
  context.location.pathname = "/shorts/video-b";
  context.location.search = "";
  pageWindow.ytInitialPlayerResponse = {
    videoDetails: { videoId: "video-b", channelId: "UC-B", author: "B" },
  };
  playerData = { video_id: "video-a", channel_id: "UC-A", author: "A" };
  const staleShort = core.discoverMedia(0);
  assert.equal(staleShort.eligible, false);
  assert.equal(staleShort.channel, null);

  globalPlayer = {
    classList: { contains: () => false },
    getVideoData: () => ({ video_id: "video-a", channel_id: "UC-A", author: "A" }),
  };
  playerData = { video_id: "video-b", channel_id: "UC-B", author: "B" };
  const coherentShort = core.discoverMedia(0);
  assert.equal(coherentShort.eligible, true);
  assert.equal(coherentShort.channel.id, "UC-B");
  assert.equal(coherentShort.mediaKey, "video-b");

  context.location.href = "https://www.youtube.com/results?search_query=test";
  context.location.pathname = "/results";
  context.location.search = "?search_query=test";
  pageWindow.ytInitialPlayerResponse = {
    videoDetails: { videoId: "miniplayer", channelId: "UC-mini", author: "Mini" },
  };
  playerData = { channel_id: "UC-stale", author: "Stale" };
  const miniplayer = core.discoverMedia(0);
  assert.equal(miniplayer.eligible, true);
  assert.equal(miniplayer.channel.id, "UC-mini");
  assert.equal(miniplayer.mediaKey, "miniplayer");
  pageWindow.ytInitialPlayerResponse = {
    videoDetails: { videoId: "miniplayer", channelId: "UC-mini" },
  };
  playerData = { channelId: "UC-stale", ownerChannelName: "Stale" };
  const camelCaseStale = core.discoverMedia(0);
  assert.equal(camelCaseStale.channel.id, "UC-mini");
  assert.equal(camelCaseStale.channel.name, "");

  context.location.href = "https://www.youtube.com/watch?v=video-b";
  context.location.pathname = "/watch";
  context.location.search = "?v=video-b";
  playerData = { video_id: "advertiser", channel_id: "UC-ad", author: "Advertiser" };
  adShowing = true;
  const ad = core.discoverMedia(0);
  assert.equal(ad.eligible, false);
  assert.equal(ad.channel, null);
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
  const shortPlayer = { id: "shorts-player" };
  const activeReel = {};
  const regularPaused = { paused: true, ended: false, readyState: 4, closest: () => null };
  const activeShort = {
    paused: false,
    ended: false,
    readyState: 4,
    closest: (selector) => {
      if (selector === "ytd-reel-video-renderer[is-active]") return activeReel;
      if (selector === ".html5-video-player") return shortPlayer;
      return null;
    },
  };
  const preloadedShort = {
    paused: true,
    ended: false,
    readyState: 4,
    closest: () => null,
  };
  assert.equal(selectActiveVideo([regularPaused, activeShort, preloadedShort]), activeShort);
});

test("thumbnail hover previews are never selected as watchable playback", () => {
  const mainPlayer = { id: "movie_player" };
  const inlinePreviewPlayer = { id: "inline-player" };
  const hoverPreview = {
    paused: false,
    ended: false,
    readyState: 4,
    closest: (selector) =>
      selector === ".html5-video-player" ? inlinePreviewPlayer : null,
  };
  const pausedMainVideo = {
    paused: true,
    ended: false,
    readyState: 4,
    closest: (selector) => (selector === "#movie_player" ? mainPlayer : null),
  };

  assert.equal(selectActiveVideo([hoverPreview]), null);
  assert.equal(selectActiveVideo([hoverPreview, pausedMainVideo]), pausedMainVideo);
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

test("the worker stops after three queue claim misses", async () => {
  const candidate = normalizeQueue([
    {
      id: "entry:claim-race",
      description: "A",
      start: new Date(0).toISOString(),
      duration: 60,
      status: "pending",
    },
  ])[0];
  const values = new Map();
  const store = {
    get: (key, fallback) => (values.has(key) ? values.get(key) : fallback),
    set: (key, value) => values.set(key, value),
    delete: (key) => values.delete(key),
  };
  let getCalls = 0;
  let mutateCalls = 0;
  const queue = {
    get() {
      getCalls += 1;
      return [candidate];
    },
    async mutate(callback) {
      mutateCalls += 1;
      callback([]);
      return [];
    },
  };
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      locks: {
        request: async (_name, _options, callback) => callback({}),
      },
    },
  });
  try {
    const worker = new TogglWorker(store, queue, config());
    assert.equal(await worker.drain(), true);
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    else delete globalThis.navigator;
  }

  assert.equal(getCalls, 3);
  assert.equal(mutateCalls, 4, "one interrupted-request pass plus three bounded claim attempts");
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
  const packageMetadata = JSON.parse(
    fs.readFileSync(require.resolve("../package.json"), "utf8"),
  );
  assert.match(source, /\/\/ ==UserScript==/);
  assert.match(source, /\/\/ @match\s+https:\/\/www\.youtube\.com\/\*/);
  assert.match(source, /\/\/ @grant\s+GM_xmlhttpRequest/);
  assert.match(source, /\/\/ @grant\s+GM_getValue/);
  assert.match(source, /\/\/ @connect\s+api\.track\.toggl\.com/);
  assert.match(source, /\/\/ @noframes\b/);
  assert.doesNotMatch(source, /\/\/ @require\b/);
  assert.equal(source.match(/\/\/ @version\s+(\S+)/)[1], packageMetadata.version);
});

test("browser bootstrap stays inactive inside child frames", () => {
  let createElementCalls = 0;
  const frameWindow = {
    addEventListener() {},
  };
  frameWindow.self = frameWindow;
  frameWindow.top = {};
  const context = {
    window: frameWindow,
    document: {
      createElement() {
        createElementCalls += 1;
        throw new Error("child frames must not mount the status control");
      },
    },
    GM_getValue() {
      throw new Error("child frames must not initialize storage");
    },
    module: { exports: {} },
  };
  const source = fs.readFileSync(require.resolve("../yt-toggl.user.js"), "utf8");

  vm.runInNewContext(source, context, { filename: "yt-toggl.user.js" });

  assert.equal(createElementCalls, 0);
  assert.equal(typeof context.module.exports.BrowserApp, "function");
});

function createFakeDom() {
  function findById(node, id) {
    if (node.id === id) return node;
    for (const child of node.children) {
      const match = findById(child, id);
      if (match) return match;
    }
    return null;
  }

  function matchesPart(node, part) {
    if (part.startsWith("#")) return node.id === part.slice(1);
    if (part.startsWith(".")) return node.classList.contains(part.slice(1));
    return node.tagName === part.toUpperCase();
  }

  function descendants(node) {
    const found = [];
    for (const child of node.children) found.push(child, ...descendants(child));
    return found;
  }

  function querySelectorIn(root, selector) {
    const parts = selector.trim().split(/\s+/);
    let scopes = [root];
    for (const part of parts) {
      const next = [];
      for (const scope of scopes) {
        for (const candidate of descendants(scope)) {
          if (matchesPart(candidate, part)) next.push(candidate);
        }
      }
      if (!next.length) return null;
      scopes = next;
    }
    return scopes[0];
  }

  function makeNode(tagName = "div", namespaceURI = null) {
    const classes = new Set();
    const node = {
      tagName: tagName.toUpperCase(),
      namespaceURI,
      id: "",
      parentNode: null,
      children: [],
      dataset: {},
      style: {},
      attributes: new Map(),
      classList: {
        contains: (name) => classes.has(name),
        add: (...names) => names.forEach((name) => classes.add(name)),
        remove: (...names) => names.forEach((name) => classes.delete(name)),
        toggle: (name, force) => (force ? classes.add(name) : classes.delete(name)),
      },
      hidden: false,
      isConnected: false,
      textContent: "",
      eventListeners: new Map(),
      addEventListener(name, callback) {
        this.eventListeners.set(name, callback);
      },
      removeEventListener() {},
      focus() {},
      setAttribute(name, value) {
        this.attributes.set(name, String(value));
        this[name] = value;
      },
      getAttribute(name) {
        return this.attributes.has(name) ? this.attributes.get(name) : null;
      },
      hasAttribute(name) {
        return this.attributes.has(name);
      },
      removeAttribute(name) {
        this.attributes.delete(name);
      },
      getBoundingClientRect() {
        return { top: 0, right: 900, bottom: 48, left: 860, width: 40, height: 40 };
      },
      contains(other) {
        return other === this || descendants(this).includes(other);
      },
      querySelector(selector) {
        return querySelectorIn(this, selector);
      },
      closest() {
        return null;
      },
      remove() {
        if (!this.parentNode) return;
        const siblings = this.parentNode.children;
        const index = siblings.indexOf(this);
        if (index >= 0) siblings.splice(index, 1);
        this.parentNode = null;
        this.isConnected = false;
      },
      adopt(child) {
        if (child.parentNode) child.remove();
        child.parentNode = this;
        child.isConnected = true;
        return child;
      },
      appendChild(child) {
        this.adopt(child);
        this.children.push(child);
        return child;
      },
      prepend(...incoming) {
        for (const child of incoming) this.adopt(child);
        this.children.unshift(...incoming);
      },
      append(...incoming) {
        for (const child of incoming) this.adopt(child);
        this.children.push(...incoming);
      },
      replaceChildren(...incoming) {
        for (const child of this.children) child.parentNode = null;
        for (const child of incoming) this.adopt(child);
        this.children = incoming;
      },
      attachShadow() {
        const shadow = makeNode("shadow-root");
        shadow.host = this;
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
  documentElement.appendChild(body);
  documentElement.isConnected = true;
  const documentListeners = new Map();
  const videos = [];
  const document = {
    body,
    documentElement,
    createElement: (tagName) => makeNode(tagName),
    createElementNS: (namespaceURI, tagName) => makeNode(tagName, namespaceURI),
    querySelectorAll: (selector) => (selector === "video" ? videos : []),
    querySelector: (selector) => querySelectorIn(documentElement, selector),
    getElementById: () => null,
    addEventListener(name, callback) {
      if (!documentListeners.has(name)) documentListeners.set(name, []);
      documentListeners.get(name).push(callback);
    },
    removeEventListener() {},
  };

  // A controllable YouTube player, so eligibility can be driven the way the
  // real page drives it: pausing, buffering, seeking, ending, and ad breaks.
  function addPlayer({ videoId = "test", channelId = "UC-Veritasium", author = "Veritasium" } = {}) {
    const player = {
      adShowing: false,
      classList: {
        contains(name) {
          return player.adShowing && (name === "ad-showing" || name === "ad-interrupting");
        },
      },
      getVideoData: () => ({ video_id: videoId, channel_id: channelId, author }),
    };
    const video = {
      paused: false,
      ended: false,
      readyState: 4,
      seeking: false,
      playbackRate: 1,
      currentTime: 12,
      currentSrc: `blob:${videoId}`,
      played: { length: 1, start: () => 0, end: () => video.currentTime },
      closest: (selector) =>
        selector === "#movie_player" || selector === ".html5-video-player" ? player : null,
    };
    videos.push(video);
    return { video, player };
  }

  function addMasthead() {
    const masthead = makeNode("ytd-masthead");
    masthead.id = "masthead";
    const container = makeNode("div");
    container.id = "container";
    const end = makeNode("div");
    end.id = "end";
    const buttons = makeNode("div");
    buttons.id = "buttons";
    const create = makeNode("ytd-button-renderer");
    create.id = "create-icon";
    buttons.appendChild(create);
    end.appendChild(buttons);
    container.appendChild(end);
    masthead.appendChild(container);
    body.appendChild(masthead);
    return buttons;
  }

  return {
    document,
    body,
    documentElement,
    makeNode,
    findById,
    documentListeners,
    addMasthead,
    addPlayer,
  };
}

test("browser bootstrap mounts status under Trusted Types enforcement and stays offline", async () => {
  const { document, body } = createFakeDom();
  const values = new Map();
  values.set("yt-toggl:tab:v1:stale-empty", createTabRecord("stale-empty", 0));
  const pendingPart = {
    id: "pending-part",
    durationMs: 30 * SECOND,
    sourceTabId: "transfer-source",
    createdAtMs: 1,
  };
  const transferSource = createTabRecord("transfer-source", 0);
  transferSource.carry = { parts: [pendingPart] };
  const transferTarget = createTabRecord("transfer-target", 0);
  transferTarget.carry = { parts: [pendingPart] };
  values.set("yt-toggl:tab:v1:transfer-source", transferSource);
  values.set("yt-toggl:tab:v1:transfer-target", transferTarget);
  values.set("yt-toggl:carry-transfer:v1", {
    schemaVersion: 1,
    id: "pending-transfer",
    sourceTabId: "transfer-source",
    targetTabId: "transfer-target",
    parts: [pendingPart],
    createdAtMs: 1,
    targetInstanceId: "old-target-instance",
  });
  const foreignLive = createTabRecord("foreign-live", 0);
  foreignLive.instanceId = "foreign-instance";
  foreignLive.active = {
    id: "foreign-session",
    channel: channel("Foreign"),
    firstPlayMs: 0,
    lastEligibleAtMs: 0,
    durationMs: MINUTE,
  };
  values.set("yt-toggl:tab:v1:foreign-live", foreignLive);
  const foreignIdleLive = createTabRecord("foreign-idle-live", 0);
  foreignIdleLive.instanceId = "foreign-idle-instance";
  values.set("yt-toggl:tab:v1:foreign-idle-live", foreignIdleLive);
  const foreignFresh = createTabRecord("foreign-fresh", Date.now());
  foreignFresh.instanceId = "foreign-fresh-instance";
  foreignFresh.active = {
    id: "foreign-fresh-session",
    channel: channel("Fresh"),
    firstPlayMs: 0,
    lastEligibleAtMs: 0,
    durationMs: MINUTE,
  };
  values.set("yt-toggl:tab:v1:foreign-fresh", foreignFresh);
  const foreignIndeterminate = createTabRecord("foreign-indeterminate", 0);
  foreignIndeterminate.instanceId = "foreign-indeterminate-instance";
  foreignIndeterminate.active = {
    id: "foreign-indeterminate-session",
    channel: channel("Indeterminate"),
    firstPlayMs: 0,
    lastEligibleAtMs: 0,
    durationMs: MINUTE,
  };
  values.set("yt-toggl:tab:v1:foreign-indeterminate", foreignIndeterminate);
  const listeners = new Map();
  const sessionValues = new Map();
  sessionValues.set("yt-toggl:tab-id:v1", "copied-tab");
  const intervals = [];
  let listValuesCount = 0;
  let requestCount = 0;
  let sequence = 0;
  const windowListeners = new Map();
  const broadcastChannels = new Set();
  const respondingTabIds = new Set(["copied-tab", "foreign-live", "foreign-idle-live"]);
  const failingProbeTabIds = new Set(["foreign-indeterminate"]);
  const failingStorageProbeTabIds = new Set(["foreign-indeterminate"]);
  const storageRespondingTabIds = new Set();
  const delayedProbeTabIds = new Set();
  class FakeBroadcastChannel {
    constructor() {
      this.listeners = [];
      broadcastChannels.add(this);
    }
    addEventListener(_name, callback) {
      this.listeners.push(callback);
    }
    postMessage(message) {
      if (message.type === "probe" && failingProbeTabIds.has(message.tabId)) {
        throw new Error("simulated BroadcastChannel failure");
      }
      for (const channel of broadcastChannels) {
        if (channel === this) continue;
        queueMicrotask(() => {
          for (const callback of channel.listeners) callback({ data: message });
        });
      }
    }
    close() {
      broadcastChannels.delete(this);
    }
  }
  const foreignResponder = new FakeBroadcastChannel();
  foreignResponder.addEventListener("message", ({ data: message }) => {
    if (
      message.type !== "probe" ||
      !respondingTabIds.has(message.tabId)
    ) {
      return;
    }
    const respond = () =>
      foreignResponder.postMessage({
        type: "alive",
        probeId: message.probeId,
        targetId: message.requesterId,
        responderId: `responder:${message.tabId}`,
      });
    if (delayedProbeTabIds.has(message.tabId)) setTimeout(respond, 350);
    else respond();
  });

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
    BroadcastChannel: FakeBroadcastChannel,
    GM_getValue: (key, fallback) => (values.has(key) ? values.get(key) : fallback),
    GM_setValue: (key, value) => {
      if (
        key === "yt-toggl:instance-probe:v1" &&
        value &&
        value.type === "probe" &&
        failingStorageProbeTabIds.has(value.tabId)
      ) {
        throw new Error("simulated shared-value probe failure");
      }
      const oldValue = values.get(key);
      values.set(key, value);
      for (const callback of listeners.get(key) || []) callback(key, oldValue, value, false);
      if (
        key === "yt-toggl:instance-probe:v1" &&
        value &&
        value.type === "probe" &&
        storageRespondingTabIds.has(value.tabId)
      ) {
        queueMicrotask(() => {
          const response = {
            type: "alive",
            probeId: value.probeId,
            targetId: value.requesterId,
            responderId: `storage-responder:${value.tabId}`,
          };
          const current = values.get(key);
          values.set(key, response);
          for (const callback of listeners.get(key) || []) {
            callback(key, current, response, true);
          }
        });
      }
    },
    GM_deleteValue: (key) => values.delete(key),
    GM_listValues: () => {
      listValuesCount += 1;
      return [...values.keys()];
    },
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
    setInterval: (callback, delay) => {
      intervals.push({ callback, delay });
      return intervals.length;
    },
    clearInterval() {},
  };
  context.window = {
    addEventListener(name, callback) {
      if (!windowListeners.has(name)) windowListeners.set(name, []);
      windowListeners.get(name).push(callback);
    },
    confirm: () => true,
  };

  const source = fs.readFileSync(require.resolve("../yt-toggl.user.js"), "utf8");
  vm.runInNewContext(source, context, { filename: "yt-toggl.user.js" });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(requestCount, 0);
  assert.equal(body.children.some((child) => child.id === "yt-toggl-status-host"), true);
  const tabKeys = [...values.keys()].filter((key) => key.startsWith("yt-toggl:tab:v1:"));
  assert.equal(tabKeys.length, 6);
  assert.notEqual(sessionValues.get("yt-toggl:tab-id:v1"), "copied-tab");
  assert.equal(values.has("yt-toggl:tab:v1:copied-tab"), false);
  assert.equal(values.has("yt-toggl:carry-transfer:v1"), false);
  assert.equal(values.has("yt-toggl:tab:v1:transfer-source"), false);
  assert.deepEqual(
    values.get("yt-toggl:tab:v1:transfer-target").carry.parts.map((part) => part.id),
    ["pending-part"],
  );
  assert.notEqual(values.get("yt-toggl:tab:v1:foreign-live").active, null);
  assert.equal(values.has("yt-toggl:tab:v1:foreign-idle-live"), true);
  assert.notEqual(values.get("yt-toggl:tab:v1:foreign-fresh").active, null);
  assert.notEqual(values.get("yt-toggl:tab:v1:foreign-indeterminate").active, null);
  const ownTabId = sessionValues.get("yt-toggl:tab-id:v1");
  assert.equal(values.get(`yt-toggl:tab:v1:${ownTabId}`).active, null);

  assert.equal(intervals.filter((interval) => interval.delay === SECOND).length, 1);
  const tickInterval = intervals.find((interval) => interval.delay === SECOND);
  const collapsedScanCount = listValuesCount;
  await tickInterval.callback();
  assert.equal(listValuesCount, collapsedScanCount, "collapsed ticks do not enumerate tab records");

  const host = body.children.find((child) => child.id === "yt-toggl-status-host");
  const buttonHost = body.children.find((child) => child.id === "yt-toggl-button-host");
  const summary = buttonHost.shadowRoot.getElementById("summary");
  summary.eventListeners.get("click")();
  assert.equal(listValuesCount, collapsedScanCount + 1, "expanding scans stale carry once");
  summary.eventListeners.get("click")();
  await tickInterval.callback();
  assert.equal(listValuesCount, collapsedScanCount + 1, "collapsing stops stale-tab scans again");

  const unreadableTransfer = { schemaVersion: 2, id: "newer-transfer" };
  values.set("yt-toggl:carry-transfer:v1", unreadableTransfer);
  await tickInterval.callback();
  assert.deepEqual(values.get("yt-toggl:carry-transfer:v1"), unreadableTransfer);
  assert.equal(values.has("yt-toggl:errors:v1"), false, "ticks do not spam errors for the journal");
  summary.eventListeners.get("click")();
  const orphanBox = host.shadowRoot.getElementById("orphans");
  const unreadableAction = (() => {
    const pending = [orphanBox];
    while (pending.length) {
      const node = pending.shift();
      if (node.textContent === "Discard saved transfer") return node;
      pending.push(...node.children);
    }
    return null;
  })();
  assert.notEqual(unreadableAction, null);
  unreadableAction.eventListeners.get("click")();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(values.has("yt-toggl:carry-transfer:v1"), false);
  summary.eventListeners.get("click")();

  respondingTabIds.add(ownTabId);
  for (const callback of windowListeners.get("pagehide") || []) callback({ persisted: true });
  for (const callback of windowListeners.get("pageshow") || []) callback({ persisted: true });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const restoredTabId = sessionValues.get("yt-toggl:tab-id:v1");
  assert.notEqual(restoredTabId, ownTabId, "a BFCache collision mints a new logical tab ID");
  assert.equal(values.has(`yt-toggl:tab:v1:${restoredTabId}`), true);

  failingProbeTabIds.add(restoredTabId);
  storageRespondingTabIds.add(restoredTabId);
  for (const callback of windowListeners.get("pagehide") || []) callback({ persisted: true });
  for (const callback of windowListeners.get("pageshow") || []) callback({ persisted: true });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const transportFailureTabId = sessionValues.get("yt-toggl:tab-id:v1");
  assert.notEqual(
    transportFailureTabId,
    restoredTabId,
    "the shared-value fallback isolates tabs when BroadcastChannel fails",
  );
  assert.equal(values.has(`yt-toggl:tab:v1:${transportFailureTabId}`), true);

  respondingTabIds.add(transportFailureTabId);
  delayedProbeTabIds.add(transportFailureTabId);
  for (const callback of windowListeners.get("pagehide") || []) callback({ persisted: true });
  for (const callback of windowListeners.get("pageshow") || []) callback({ persisted: true });
  await new Promise((resolve) => setTimeout(resolve, 450));
  const delayedResponseTabId = sessionValues.get("yt-toggl:tab-id:v1");
  assert.notEqual(
    delayedResponseTabId,
    transportFailureTabId,
    "a delayed live response still isolates the duplicated logical tab",
  );
  assert.equal(values.has(`yt-toggl:tab:v1:${delayedResponseTabId}`), true);
  assert.equal(requestCount, 0);
});

function bootUserscript(dom) {
  const values = new Map();
  const listeners = new Map();
  const sessionValues = new Map();
  const intervals = [];
  const windowListeners = new Map();
  let sequence = 0;

  class SilentBroadcastChannel {
    addEventListener() {}
    postMessage() {}
    close() {}
  }

  const context = {
    URL,
    TextEncoder,
    Date,
    Math,
    JSON,
    Promise,
    Symbol,
    console,
    document: dom.document,
    location: {
      href: "https://www.youtube.com/watch?v=test",
      pathname: "/watch",
      search: "?v=test",
    },
    performance: { now: () => 1000 },
    crypto: { randomUUID: () => `uuid-${++sequence}` },
    navigator: {
      locks: {
        request: async (name, _options, callback) => callback({ name }),
      },
    },
    sessionStorage: {
      getItem: (key) => sessionValues.get(key) || null,
      setItem: (key, value) => sessionValues.set(key, value),
    },
    BroadcastChannel: SilentBroadcastChannel,
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
    GM_xmlhttpRequest: () => {},
    unsafeWindow: {},
    btoa: (input) => Buffer.from(input, "binary").toString("base64"),
    setTimeout,
    clearTimeout,
    setInterval: (callback, delay) => {
      intervals.push({ callback, delay });
      return intervals.length;
    },
    clearInterval() {},
    module: { exports: {} },
  };
  context.window = {
    innerWidth: 1280,
    innerHeight: 720,
    addEventListener(name, callback) {
      if (!windowListeners.has(name)) windowListeners.set(name, []);
      windowListeners.get(name).push(callback);
    },
    confirm: () => true,
  };

  const source = fs.readFileSync(require.resolve("../yt-toggl.user.js"), "utf8");
  vm.runInNewContext(source, context, { filename: "yt-toggl.user.js" });

  const boot = {
    context,
    values,
    sessionValues,
    api: context.module.exports,
    tick: () => intervals.find((interval) => interval.delay === SECOND).callback(),
    recover: () => intervals.find((interval) => interval.delay === 30 * SECOND).callback(),
    settle: () => new Promise((resolve) => setTimeout(resolve, 20)),
  };
  boot.rerender = () => context.GM_setValue("yt-toggl:queue:v1", values.get("yt-toggl:queue:v1") || []);
  boot.seedActiveSession = (durationMs, name = "Veritasium", carryMs = 0) => {
    const tabId = sessionValues.get("yt-toggl:tab-id:v1");
    const record = createTabRecord(tabId, Date.now());
    record.active = {
      id: "ui-session",
      channel: channel(name),
      firstPlayMs: Date.now(),
      lastEligibleAtMs: Date.now(),
      durationMs,
    };
    if (carryMs > 0) {
      record.carry = {
        parts: [
          { id: "ui-carry", durationMs: carryMs, sourceTabId: tabId, createdAtMs: Date.now() },
        ],
      };
    }
    values.set(`yt-toggl:tab:v1:${tabId}`, record);
    boot.rerender();
  };
  return boot;
}

function findDescendant(root, id) {
  const pending = [root];
  while (pending.length) {
    const node = pending.shift();
    if (node.id === id) return node;
    pending.push(...node.children);
  }
  return null;
}

function collectText(node) {
  let text = node.textContent || "";
  for (const child of node.children) text += collectText(child);
  return text;
}

test("the status button mounts inside the YouTube masthead", async () => {
  const dom = createFakeDom();
  const buttons = dom.addMasthead();
  const boot = bootUserscript(dom);
  await boot.settle();

  const host = buttons.children.find((child) => child.id === "yt-toggl-button-host");
  assert.notEqual(host, undefined, "the button is injected into the masthead");
  assert.equal(buttons.children[0], host, "it leads YouTube's own masthead buttons");
  assert.equal(host.dataset.placement, "masthead");
  assert.equal(
    dom.body.children.some((child) => child.id === "yt-toggl-button-host"),
    false,
    "no floating button is left behind on the body",
  );
  assert.equal(
    dom.body.children.some((child) => child.id === "yt-toggl-status-host"),
    true,
    "the panel host stays on the body, clear of the masthead's transforms",
  );
});

test("the status button falls back to a floating mount without a masthead", async () => {
  const dom = createFakeDom();
  const boot = bootUserscript(dom);
  await boot.settle();

  const host = dom.body.children.find((child) => child.id === "yt-toggl-button-host");
  assert.notEqual(host, undefined, "the button still mounts when the masthead is missing");
  assert.equal(host.dataset.placement, "floating");
});

test("the masthead button returns after YouTube rebuilds its button row", async () => {
  const dom = createFakeDom();
  const buttons = dom.addMasthead();
  const boot = bootUserscript(dom);
  await boot.settle();

  buttons.children.find((child) => child.id === "yt-toggl-button-host").remove();
  assert.equal(buttons.children.some((child) => child.id === "yt-toggl-button-host"), false);

  await boot.tick();
  assert.equal(
    buttons.children.some((child) => child.id === "yt-toggl-button-host"),
    true,
    "the next tick re-injects the button",
  );
});

test("the collapsed button signals tracking and attention without showing the time", async () => {
  const dom = createFakeDom();
  const buttons = dom.addMasthead();
  const boot = bootUserscript(dom);
  await boot.settle();
  boot.api.CONFIG.togglApiToken = "token";
  boot.api.CONFIG.togglWorkspaceId = 7;

  const host = buttons.children.find((child) => child.id === "yt-toggl-button-host");
  const summary = host.shadowRoot.getElementById("summary");

  boot.rerender();
  assert.equal(summary.dataset.state, "idle");

  const media = dom.addPlayer();
  await boot.tick();
  await boot.settle();
  assert.equal(summary.dataset.state, "tracking");
  assert.equal(summary.dataset.attention, "0");
  assert.equal(
    /\d/.test(collectText(host)),
    false,
    "the collapsed button never renders a duration",
  );

  media.video.paused = true;
  await boot.tick();
  await boot.settle();
  assert.notEqual(boot.values.get(`yt-toggl:tab:v1:${boot.sessionValues.get("yt-toggl:tab-id:v1")}`).active, null);
  assert.equal(
    summary.dataset.state,
    "paused",
    "a session held open across a pause must not claim time is accruing",
  );

  boot.values.set("yt-toggl:errors:v1", [{ message: "Toggl rejected the token", atMs: 1 }]);
  boot.rerender();
  assert.equal(summary.dataset.attention, "1");
});

test("playback states that earn no credit read as paused, not as tracking", async () => {
  const dom = createFakeDom();
  const buttons = dom.addMasthead();
  const media = dom.addPlayer();
  const boot = bootUserscript(dom);
  await boot.settle();
  boot.api.CONFIG.togglApiToken = "token";
  boot.api.CONFIG.togglWorkspaceId = 7;

  const buttonHost = buttons.children.find((child) => child.id === "yt-toggl-button-host");
  const summary = buttonHost.shadowRoot.getElementById("summary");
  const panelHost = dom.body.children.find((child) => child.id === "yt-toggl-status-host");
  summary.eventListeners.get("click")();
  const eyebrow = panelHost.shadowRoot.getElementById("eyebrow");

  await boot.tick();
  await boot.settle();
  assert.equal(summary.dataset.state, "tracking");
  assert.equal(eyebrow.textContent, "NOW TRACKING");

  const excluded = [
    ["a pause", () => (media.video.paused = true), () => (media.video.paused = false)],
    ["buffering", () => (media.video.readyState = 1), () => (media.video.readyState = 4)],
    ["a seek", () => (media.video.seeking = true), () => (media.video.seeking = false)],
    ["ended media", () => (media.video.ended = true), () => (media.video.ended = false)],
    ["an ad break", () => (media.player.adShowing = true), () => (media.player.adShowing = false)],
  ];
  for (const [label, enter, leave] of excluded) {
    enter();
    await boot.tick();
    await boot.settle();
    assert.equal(summary.dataset.state, "paused", `${label} earns no credit`);
    assert.equal(eyebrow.textContent, "TRACKING PAUSED");
    assert.equal(
      summary.getAttribute("aria-label"),
      "YouTube watch time, tracking paused",
    );
    leave();
    await boot.tick();
    await boot.settle();
    assert.equal(summary.dataset.state, "tracking", `resuming after ${label} tracks again`);
  }
});

test("stale carry from a closed tab raises the attention dot", async () => {
  const dom = createFakeDom();
  const buttons = dom.addMasthead();
  const boot = bootUserscript(dom);
  await boot.settle();
  boot.api.CONFIG.togglApiToken = "token";
  boot.api.CONFIG.togglWorkspaceId = 7;

  const buttonHost = buttons.children.find((child) => child.id === "yt-toggl-button-host");
  const summary = buttonHost.shadowRoot.getElementById("summary");
  const panelHost = dom.body.children.find((child) => child.id === "yt-toggl-status-host");

  boot.rerender();
  assert.equal(summary.dataset.attention, "0");

  const stale = createTabRecord("closed-tab", 0);
  stale.carry = {
    parts: [
      { id: "closed-part", durationMs: 40 * SECOND, sourceTabId: "closed-tab", createdAtMs: 0 },
    ],
  };
  boot.values.set("yt-toggl:tab:v1:closed-tab", stale);
  await boot.recover();
  await boot.settle();
  assert.equal(
    summary.dataset.attention,
    "1",
    "the attach-or-discard decision must be discoverable from the collapsed button",
  );

  summary.eventListeners.get("click")();
  const orphanBox = panelHost.shadowRoot.getElementById("orphans");
  const discard = (() => {
    const pending = [orphanBox];
    while (pending.length) {
      const node = pending.shift();
      if (node.textContent === "Discard") return node;
      pending.push(...node.children);
    }
    return null;
  })();
  assert.notEqual(discard, null, "the panel offers the explicit discard");
  discard.eventListeners.get("click")();
  await boot.settle();
  assert.equal(boot.values.has("yt-toggl:tab:v1:closed-tab"), false);
  assert.equal(summary.dataset.attention, "0", "resolving the decision clears the dot");
});

test("the panel reveals the tracked time and when it starts counting", async () => {
  const dom = createFakeDom();
  const buttons = dom.addMasthead();
  const boot = bootUserscript(dom);
  await boot.settle();
  boot.api.CONFIG.togglApiToken = "token";
  boot.api.CONFIG.togglWorkspaceId = 7;

  const buttonHost = buttons.children.find((child) => child.id === "yt-toggl-button-host");
  const summary = buttonHost.shadowRoot.getElementById("summary");
  const panelHost = dom.body.children.find((child) => child.id === "yt-toggl-status-host");
  const panel = panelHost.shadowRoot.getElementById("panel");

  boot.seedActiveSession(12 * SECOND);
  assert.equal(panel.hidden, true, "the panel starts collapsed");

  summary.eventListeners.get("click")();
  assert.equal(panel.hidden, false);
  assert.equal(summary.getAttribute("aria-expanded"), "true");
  assert.equal(panelHost.shadowRoot.getElementById("readout").textContent, "0:12");
  assert.equal(findDescendant(panel, "channel").textContent, "Veritasium");
  assert.equal(
    findDescendant(panel, "threshold-caption").textContent,
    "0:48 UNTIL THIS COUNTS",
    "the panel names the minimum-duration boundary that decides whether time is kept",
  );

  boot.seedActiveSession(90 * SECOND);
  assert.equal(panelHost.shadowRoot.getElementById("readout").textContent, "1:30");
  assert.equal(findDescendant(panel, "threshold-caption").textContent, "COUNTING");
});

test("the panel measures the minimum against the time finalization would queue", async () => {
  const dom = createFakeDom();
  const buttons = dom.addMasthead();
  const boot = bootUserscript(dom);
  await boot.settle();
  boot.api.CONFIG.togglApiToken = "token";
  boot.api.CONFIG.togglWorkspaceId = 7;

  const buttonHost = buttons.children.find((child) => child.id === "yt-toggl-button-host");
  const summary = buttonHost.shadowRoot.getElementById("summary");
  const panelHost = dom.body.children.find((child) => child.id === "yt-toggl-status-host");
  const panel = panelHost.shadowRoot.getElementById("panel");
  summary.eventListeners.get("click")();

  boot.api.CONFIG.mergeBelowMinimum = true;
  boot.seedActiveSession(20 * SECOND, "Veritasium", 50 * SECOND);
  const record = boot.values.get(`yt-toggl:tab:v1:${boot.sessionValues.get("yt-toggl:tab-id:v1")}`);
  const finalized = boot.api.finalizeTabRecord(record, boot.api.CONFIG, undefined, "finalized", Date.now());
  assert.equal(finalized.disposition, "queued", "merge mode queues the combined 70 seconds");
  assert.equal(finalized.entry.duration, 70);
  assert.equal(
    findDescendant(panel, "threshold-caption").textContent,
    "COUNTING",
    "carried time counts toward the minimum in merge mode",
  );
  assert.equal(findDescendant(panel, "threshold-fill").style.width, "100%");

  boot.api.CONFIG.mergeBelowMinimum = false;
  boot.rerender();
  assert.equal(
    findDescendant(panel, "threshold-caption").textContent,
    "0:40 UNTIL THIS COUNTS",
    "discard mode drops the carry, so only this session counts",
  );
});

test("the panel closes on an outside click and on Escape", async () => {
  const dom = createFakeDom();
  const buttons = dom.addMasthead();
  const boot = bootUserscript(dom);
  await boot.settle();

  const buttonHost = buttons.children.find((child) => child.id === "yt-toggl-button-host");
  const summary = buttonHost.shadowRoot.getElementById("summary");
  const panelHost = dom.body.children.find((child) => child.id === "yt-toggl-status-host");
  const panel = panelHost.shadowRoot.getElementById("panel");
  const documentClick = (dom.documentListeners.get("click") || []).at(-1);
  const documentKeydown = (dom.documentListeners.get("keydown") || []).at(-1);

  summary.eventListeners.get("click")();
  documentClick({ target: dom.body, composedPath: () => [panelHost] });
  assert.equal(panel.hidden, false, "clicks inside the panel keep it open");

  documentClick({ target: dom.body, composedPath: () => [dom.body] });
  assert.equal(panel.hidden, true, "a click elsewhere on the page closes it");
  assert.equal(summary.getAttribute("aria-expanded"), "false");

  summary.eventListeners.get("click")();
  assert.equal(panel.hidden, false);
  documentKeydown({ key: "Escape" });
  assert.equal(panel.hidden, true, "Escape closes it");
});
