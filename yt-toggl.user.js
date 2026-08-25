// ==UserScript==
// @name         YouTube Watch Time → Toggl
// @namespace    https://github.com/local/yt-toggl
// @version      1.0.1
// @description  Track eligible YouTube playback locally and create completed Toggl entries.
// @author       You
// @match        https://www.youtube.com/*
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_addValueChangeListener
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      api.track.toggl.com
// @run-at       document-idle
// ==/UserScript==

/*
 * This file intentionally has no runtime dependencies. Its pure core is also
 * exported through CommonJS so `node --test` can exercise the same state
 * machine that runs in the userscript.
 */

const CONFIG = {
  togglApiToken: "",
  togglWorkspaceId: 0,
  togglProjectId: null,
  inactivityMinutes: 10,
  minimumDurationMinutes: 1,
  mergeBelowMinimum: true,
  maxRequestsPerHour: 30,
};

// Customize Toggl descriptions here. The channel object has `id` and `name`.
function makeDescription(channel) {
  return channel.name || channel.id || "YouTube";
}

(function ytTogglModule() {
  "use strict";

  const SCRIPT_ID = "yt-toggl";
  const SCHEMA_VERSION = 1;
  const TAB_ID_SESSION_KEY = "yt-toggl:tab-id:v1";
  const TAB_KEY_PREFIX = "yt-toggl:tab:v1:";
  const QUEUE_KEY = "yt-toggl:queue:v1";
  const ATTEMPTS_KEY = "yt-toggl:attempts:v1";
  const LAST_REQUEST_KEY = "yt-toggl:last-request:v1";
  const QUOTA_KEY = "yt-toggl:quota:v1";
  const AUTH_BLOCK_KEY = "yt-toggl:auth-block:v1";
  const ERRORS_KEY = "yt-toggl:errors:v1";
  const COMMAND_KEY = "yt-toggl:command:v1";
  const INSTANCE_PROBE_KEY = "yt-toggl:instance-probe:v1";
  const CARRY_TRANSFER_KEY = "yt-toggl:carry-transfer:v1";
  const LOCK_KEY_PREFIX = "yt-toggl:lease:v1:";
  const ONE_HOUR_MS = 60 * 60 * 1000;
  const REQUEST_SPACING_MS = 1000;
  const DEFAULT_RATE_BACKOFF_MS = 2 * 60 * 1000;
  const REQUEST_TIMEOUT_MS = 30 * 1000;
  const TICK_INTERVAL_MS = 1000;
  const TAB_HEARTBEAT_GRACE_MS = 5 * TICK_INTERVAL_MS;
  const WORKER_INTERVAL_MS = 30 * 1000;
  const MAX_ERROR_HISTORY = 12;
  const LOCK_UNAVAILABLE = Symbol("lock-unavailable");

  function clone(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
  }

  function finiteNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function nonNegativeNumber(value, fallback = 0) {
    return Math.max(0, finiteNumber(value, fallback));
  }

  function inactivityMs(config = CONFIG) {
    return Math.max(0, finiteNumber(config.inactivityMinutes, 10)) * 60 * 1000;
  }

  function minimumDurationMs(config = CONFIG) {
    return Math.max(0, finiteNumber(config.minimumDurationMinutes, 1)) * 60 * 1000;
  }

  function normalizedText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function normalizeChannel(channel) {
    if (!channel || typeof channel !== "object") return null;
    const id = normalizedText(channel.id);
    const name = normalizedText(channel.name);
    if (!id && !name) return null;
    return { id, name };
  }

  function channelsEqual(left, right) {
    const a = normalizeChannel(left);
    const b = normalizeChannel(right);
    if (!a || !b) return false;
    if (a.id && b.id) return a.id === b.id;
    if (a.name && b.name) {
      return a.name.toLocaleLowerCase() === b.name.toLocaleLowerCase();
    }
    return false;
  }

  function mergeChannel(existing, observed) {
    const oldChannel = normalizeChannel(existing) || { id: "", name: "" };
    const newChannel = normalizeChannel(observed) || { id: "", name: "" };
    return {
      id: newChannel.id || oldChannel.id,
      name: newChannel.name || oldChannel.name,
    };
  }

  function randomId(prefix = "id", nowMs = Date.now()) {
    let randomPart = "";
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      randomPart = crypto.randomUUID();
    } else {
      randomPart = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    }
    return `${prefix}-${nowMs.toString(36)}-${randomPart}`;
  }

  function normalizeCarry(carry) {
    const parts = Array.isArray(carry && carry.parts) ? carry.parts : [];
    const seen = new Set();
    return {
      parts: parts
        .filter(
          (part) =>
            part &&
            typeof part.id === "string" &&
            normalizedText(part.id) &&
            finiteNumber(part.durationMs) > 0,
        )
        .filter((part) => {
          if (seen.has(part.id)) return false;
          seen.add(part.id);
          return true;
        })
        .map((part) => ({
          id: part.id,
          durationMs: nonNegativeNumber(part.durationMs),
          sourceTabId: normalizedText(part.sourceTabId),
          createdAtMs: nonNegativeNumber(part.createdAtMs),
        })),
    };
  }

  function carryDurationMs(carry) {
    return normalizeCarry(carry).parts.reduce((total, part) => total + part.durationMs, 0);
  }

  function mergeCarry(targetCarry, sourceCarry) {
    return normalizeCarry({
      parts: [...normalizeCarry(targetCarry).parts, ...normalizeCarry(sourceCarry).parts],
    });
  }

  function normalizeActive(active) {
    if (!active || typeof active !== "object") return null;
    const channel = normalizeChannel(active.channel);
    if (!channel || typeof active.id !== "string") return null;
    return {
      id: active.id,
      channel,
      firstPlayMs: nonNegativeNumber(active.firstPlayMs),
      lastEligibleAtMs: nonNegativeNumber(active.lastEligibleAtMs),
      durationMs: nonNegativeNumber(active.durationMs),
    };
  }

  function createTabRecord(tabId, nowMs = Date.now()) {
    return {
      schemaVersion: SCHEMA_VERSION,
      tabId,
      heartbeatMs: nowMs,
      instanceId: "",
      active: null,
      carry: { parts: [] },
      lastCommandId: "",
      recoveredAtMs: 0,
    };
  }

  function normalizeTabRecord(record, tabId = "", nowMs = Date.now()) {
    const base = record && typeof record === "object" ? record : {};
    return {
      schemaVersion: SCHEMA_VERSION,
      tabId: normalizedText(base.tabId) || tabId,
      heartbeatMs: nonNegativeNumber(base.heartbeatMs, nowMs),
      instanceId: normalizedText(base.instanceId),
      active: normalizeActive(base.active),
      carry: normalizeCarry(base.carry),
      lastCommandId: normalizedText(base.lastCommandId),
      recoveredAtMs: nonNegativeNumber(base.recoveredAtMs),
    };
  }

  function makeSession(channel, nowMs, idFactory = randomId) {
    return {
      id: idFactory("session", nowMs),
      channel: normalizeChannel(channel),
      firstPlayMs: nowMs,
      lastEligibleAtMs: nowMs,
      durationMs: 0,
    };
  }

  function playedRangeCovers(ranges, fromSeconds, toSeconds) {
    if (!Array.isArray(ranges) || ranges.length === 0) return true;
    const low = Math.min(fromSeconds, toSeconds);
    const high = Math.max(fromSeconds, toSeconds);
    return ranges.some((range) => {
      if (!Array.isArray(range) || range.length < 2) return false;
      return finiteNumber(range[0], Infinity) <= low + 0.5 && finiteNumber(range[1], -Infinity) >= high - 0.5;
    });
  }

  function validatedPlaybackMs(previous, current) {
    if (!previous || !current || !previous.eligible || !current.progressAllowed) return 0;
    if (!previous.channel || !current.channel || !channelsEqual(previous.channel, current.channel)) return 0;
    if (!previous.mediaKey || previous.mediaKey !== current.mediaKey) return 0;
    if (previous.discontinuityToken !== current.discontinuityToken) return 0;

    const dateWallMs = finiteNumber(current.nowMs) - finiteNumber(previous.nowMs);
    const monotonicWallMs =
      finiteNumber(current.monotonicMs, current.nowMs) -
      finiteNumber(previous.monotonicMs, previous.nowMs);
    // The monotonic clock often excludes machine sleep and also protects
    // against system-clock corrections. Background-tab timer throttling still
    // advances both clocks, so genuine background playback remains countable.
    const wallMs = Math.min(dateWallMs, monotonicWallMs);
    const mediaDelta = finiteNumber(current.mediaTime) - finiteNumber(previous.mediaTime);
    const playbackRate = finiteNumber(previous.playbackRate, 1);
    if (wallMs <= 0 || mediaDelta <= 0.001 || playbackRate <= 0) return 0;
    if (!playedRangeCovers(current.playedRanges, previous.mediaTime, current.mediaTime)) return 0;

    // A seek or live-edge jump advances media much faster than the elapsed wall
    // interval. Ordinary decoder/timer jitter is allowed a bounded tolerance.
    const expectedMediaSeconds = (wallMs / 1000) * playbackRate;
    const jumpToleranceSeconds = Math.max(1.5, expectedMediaSeconds * 0.2);
    if (mediaDelta > expectedMediaSeconds + jumpToleranceSeconds) return 0;

    // Media progress establishes how much of a delayed timer interval was real
    // playback. Capping at wall time makes 2× playback count as real time, not
    // content time, while partial stalls receive only their progressed portion.
    const progressEquivalentMs = (mediaDelta / playbackRate) * 1000;
    return Math.max(0, Math.min(wallMs, progressEquivalentMs));
  }

  function playbackBridgesInactivity(previous, current, creditedMs, expirationMs) {
    if (!previous || creditedMs <= 0) return false;
    const wallElapsedMs = Math.max(0, current.nowMs - previous.nowMs);
    const monotonicElapsedMs = Math.max(0, current.monotonicMs - previous.monotonicMs);
    return (
      wallElapsedMs - creditedMs < expirationMs &&
      monotonicElapsedMs - creditedMs < expirationMs
    );
  }

  function makeQueueEntry(session, totalDurationMs, reason, nowMs, descriptionFn = makeDescription) {
    return {
      schemaVersion: SCHEMA_VERSION,
      id: `entry:${session.id}`,
      sourceSessionId: session.id,
      sourceTabId: "",
      channel: clone(session.channel),
      description: normalizedText(descriptionFn(session.channel)) || "YouTube",
      start: new Date(session.firstPlayMs).toISOString(),
      duration: Math.max(1, Math.round(totalDurationMs / 1000)),
      reason,
      queuedAtMs: nowMs,
      status: "pending",
      nextAttemptAtMs: 0,
      attemptCount: 0,
      sendingSinceMs: 0,
      lastError: "",
    };
  }

  function finalizeTabRecord(
    inputRecord,
    config = CONFIG,
    descriptionFn = makeDescription,
    reason = "finalized",
    nowMs = Date.now(),
  ) {
    const record = normalizeTabRecord(inputRecord, inputRecord && inputRecord.tabId, nowMs);
    const session = record.active;
    record.active = null;
    if (!session || session.durationMs <= 0) return { record, entry: null, disposition: "empty" };

    const minimumMs = minimumDurationMs(config);
    if (!config.mergeBelowMinimum) {
      if (session.durationMs < minimumMs) {
        return { record, entry: null, disposition: "discarded" };
      }
      const entry = makeQueueEntry(session, session.durationMs, reason, nowMs, descriptionFn);
      entry.sourceTabId = record.tabId;
      return { record, entry, disposition: "queued" };
    }

    const existingCarry = normalizeCarry(record.carry);
    const combinedDurationMs = carryDurationMs(existingCarry) + session.durationMs;
    if (combinedDurationMs < minimumMs) {
      record.carry = mergeCarry(existingCarry, {
        parts: [
          {
            id: session.id,
            durationMs: session.durationMs,
            sourceTabId: record.tabId,
            createdAtMs: nowMs,
          },
        ],
      });
      return { record, entry: null, disposition: "carried" };
    }

    const entry = makeQueueEntry(session, combinedDurationMs, reason, nowMs, descriptionFn);
    entry.sourceTabId = record.tabId;
    record.carry = { parts: [] };
    return { record, entry, disposition: "queued" };
  }

  class SessionMachine {
    constructor(config = CONFIG, record = null, options = {}) {
      this.config = config;
      this.descriptionFn = options.descriptionFn || makeDescription;
      this.idFactory = options.idFactory || randomId;
      this.record = normalizeTabRecord(record, (record && record.tabId) || "test-tab");
      this.sample = null;
      this.inactivityDeadline = options.inactivityDeadline || null;
    }

    resetInactivityDeadline(snapshot) {
      if (!this.record.active) {
        this.inactivityDeadline = null;
        return;
      }
      const expirationMs = inactivityMs(this.config);
      this.inactivityDeadline = {
        sessionId: this.record.active.id,
        atMonotonicMs: snapshot.monotonicMs + expirationMs,
        atWallMs: snapshot.nowMs + expirationMs,
        lastObservedWallMs: snapshot.nowMs,
      };
    }

    ensureInactivityDeadline(snapshot) {
      if (!this.record.active) {
        this.inactivityDeadline = null;
        return null;
      }
      const hasMonotonicDeadline = Boolean(
        this.inactivityDeadline &&
          this.inactivityDeadline.sessionId === this.record.active.id &&
          Number.isFinite(this.inactivityDeadline.atMonotonicMs),
      );
      if (!hasMonotonicDeadline) {
        const expirationMs = inactivityMs(this.config);
        const wallElapsedMs = Math.max(0, snapshot.nowMs - this.record.active.lastEligibleAtMs);
        const remainingMs = Math.max(0, expirationMs - wallElapsedMs);
        this.inactivityDeadline = {
          sessionId: this.record.active.id,
          atMonotonicMs: snapshot.monotonicMs + remainingMs,
          atWallMs: snapshot.nowMs + remainingMs,
          lastObservedWallMs: snapshot.nowMs,
        };
        this.record.active.lastEligibleAtMs = Math.max(
          0,
          this.inactivityDeadline.atWallMs - expirationMs,
        );
      } else {
        if (!Number.isFinite(this.inactivityDeadline.atWallMs)) {
          const expirationMs = inactivityMs(this.config);
          const wallElapsedMs = Math.max(0, snapshot.nowMs - this.record.active.lastEligibleAtMs);
          const wallRemainingMs = Math.max(0, expirationMs - wallElapsedMs);
          const monotonicRemainingMs = Math.max(
            0,
            this.inactivityDeadline.atMonotonicMs - snapshot.monotonicMs,
          );
          this.inactivityDeadline.atWallMs =
            snapshot.nowMs + Math.min(wallRemainingMs, monotonicRemainingMs);
        }
        if (!Number.isFinite(this.inactivityDeadline.lastObservedWallMs)) {
          this.inactivityDeadline.lastObservedWallMs = snapshot.nowMs;
        }
        if (snapshot.nowMs < this.inactivityDeadline.lastObservedWallMs) {
          const monotonicRemainingMs = Math.max(
            0,
            this.inactivityDeadline.atMonotonicMs - snapshot.monotonicMs,
          );
          this.inactivityDeadline.atWallMs = snapshot.nowMs + monotonicRemainingMs;
          // Persist the equivalent wall anchor so reload/closed-tab recovery
          // retains elapsed inactivity after this in-memory deadline is lost.
          this.record.active.lastEligibleAtMs = Math.max(
            0,
            this.inactivityDeadline.atWallMs - inactivityMs(this.config),
          );
        }
        this.inactivityDeadline.lastObservedWallMs = snapshot.nowMs;
      }
      return this.inactivityDeadline;
    }

    startSession(channel, snapshot, initialDurationMs = 0) {
      const durationMs = nonNegativeNumber(initialDurationMs);
      this.record.active = makeSession(
        channel,
        Math.max(0, snapshot.nowMs - durationMs),
        this.idFactory,
      );
      this.record.active.durationMs = durationMs;
      this.record.active.lastEligibleAtMs = snapshot.nowMs;
      this.resetInactivityDeadline(snapshot);
    }

    finalize(reason, nowMs) {
      const result = finalizeTabRecord(this.record, this.config, this.descriptionFn, reason, nowMs);
      this.record = result.record;
      this.sample = null;
      this.inactivityDeadline = null;
      return result.entry;
    }

    tick(rawSnapshot) {
      const snapshot = normalizeSnapshot(rawSnapshot);
      const entries = [];

      if (
        this.record.active &&
        snapshot.channel &&
        !channelsEqual(this.record.active.channel, snapshot.channel)
      ) {
        const entry = this.finalize("channel-change", snapshot.nowMs);
        if (entry) entries.push(entry);
      }

      const inactivityDeadline = this.ensureInactivityDeadline(snapshot);
      const deadlineReached = Boolean(
        inactivityDeadline &&
          (snapshot.monotonicMs >= inactivityDeadline.atMonotonicMs ||
            snapshot.nowMs >= inactivityDeadline.atWallMs),
      );
      const creditedMs =
        this.record.active && this.sample && snapshot.channel
          ? validatedPlaybackMs(this.sample, snapshot)
          : 0;
      const playbackBridgesDeadline =
        deadlineReached &&
        playbackBridgesInactivity(
          this.sample,
          snapshot,
          creditedMs,
          inactivityMs(this.config),
        );

      let creditedReplacement = false;
      if (deadlineReached && !playbackBridgesDeadline) {
        const entry = this.finalize("inactivity", snapshot.nowMs);
        if (entry) entries.push(entry);
        if (creditedMs > 0 && snapshot.channel) {
          this.startSession(snapshot.channel, snapshot, creditedMs);
          creditedReplacement = true;
        }
      }

      if (this.record.active && creditedMs > 0 && !creditedReplacement) {
        this.record.active.durationMs += creditedMs;
        this.record.active.lastEligibleAtMs = snapshot.nowMs;
        this.record.active.channel = mergeChannel(this.record.active.channel, snapshot.channel);
        this.resetInactivityDeadline(snapshot);
      }

      if (snapshot.eligible && snapshot.channel) {
        if (!this.record.active) this.startSession(snapshot.channel, snapshot);
        else this.record.active.channel = mergeChannel(this.record.active.channel, snapshot.channel);
      }

      this.sample = snapshot.channel && snapshot.mediaKey ? snapshot : null;
      return entries;
    }

    sync(rawSnapshot) {
      const snapshot = normalizeSnapshot(rawSnapshot);
      const entries = this.tick(snapshot);
      if (this.record.active) {
        const entry = this.finalize("manual-sync", snapshot.nowMs);
        if (entry) entries.push(entry);
      }
      if (snapshot.eligible && snapshot.channel) {
        this.startSession(snapshot.channel, snapshot);
        this.sample = snapshot;
      }
      return entries;
    }
  }

  function normalizeSnapshot(snapshot) {
    const input = snapshot && typeof snapshot === "object" ? snapshot : {};
    const nowMs = nonNegativeNumber(input.nowMs, Date.now());
    return {
      nowMs,
      monotonicMs: nonNegativeNumber(input.monotonicMs, nowMs),
      eligible: Boolean(input.eligible),
      progressAllowed: Boolean(input.progressAllowed),
      channel: normalizeChannel(input.channel),
      mediaKey: normalizedText(input.mediaKey),
      mediaTime: finiteNumber(input.mediaTime),
      playbackRate: finiteNumber(input.playbackRate, 1),
      playedRanges: Array.isArray(input.playedRanges) ? clone(input.playedRanges) : [],
      discontinuityToken: finiteNumber(input.discontinuityToken),
    };
  }

  function recoverExpiredRecord(record, nowMs, config = CONFIG, descriptionFn = makeDescription) {
    const normalized = normalizeTabRecord(record, record && record.tabId, nowMs);
    if (!normalized.active) return { record: normalized, entry: null, disposition: "unchanged" };
    if (nowMs - normalized.active.lastEligibleAtMs < inactivityMs(config)) {
      return { record: normalized, entry: null, disposition: "unchanged" };
    }
    const result = finalizeTabRecord(normalized, config, descriptionFn, "recovered-inactivity", nowMs);
    result.record.recoveredAtMs = nowMs;
    return result;
  }

  function tabRecordIsPrunable(record, currentTabId, nowMs, config = CONFIG) {
    const normalized = normalizeTabRecord(record, record && record.tabId, nowMs);
    return Boolean(
      normalized.tabId &&
        normalized.tabId !== currentTabId &&
        !normalized.active &&
        carryDurationMs(normalized.carry) === 0 &&
        nowMs - normalized.heartbeatMs >= inactivityMs(config),
    );
  }

  function attachCarry(targetRecord, sourceRecord, nowMs = Date.now()) {
    const target = normalizeTabRecord(targetRecord, targetRecord && targetRecord.tabId, nowMs);
    const source = normalizeTabRecord(sourceRecord, sourceRecord && sourceRecord.tabId, nowMs);
    target.carry = mergeCarry(target.carry, source.carry);
    source.carry = { parts: [] };
    return { target, source };
  }

  function discardCarry(record, nowMs = Date.now()) {
    const next = normalizeTabRecord(record, record && record.tabId, nowMs);
    next.carry = { parts: [] };
    return next;
  }

  function normalizeCarryTransfer(transfer) {
    if (!transfer || typeof transfer !== "object" || transfer.schemaVersion !== 1) return null;
    const id = normalizedText(transfer.id);
    const sourceTabId = normalizedText(transfer.sourceTabId);
    const targetTabId = normalizedText(transfer.targetTabId);
    const rawParts = Array.isArray(transfer.parts) ? transfer.parts : [];
    const parts = normalizeCarry({ parts: rawParts }).parts;
    const partsHaveStableIds = rawParts.every(
      (part) =>
        part &&
        typeof part.id === "string" &&
        part.id === normalizedText(part.id),
    );
    if (
      !id ||
      !sourceTabId ||
      !targetTabId ||
      sourceTabId === targetTabId ||
      parts.length === 0 ||
      parts.length !== rawParts.length ||
      !partsHaveStableIds
    ) {
      return null;
    }
    return {
      schemaVersion: 1,
      id,
      sourceTabId,
      targetTabId,
      parts,
      createdAtMs: nonNegativeNumber(transfer.createdAtMs),
      targetInstanceId: normalizedText(transfer.targetInstanceId),
    };
  }

  function createCarryTransfer(
    sourceRecord,
    targetTabId,
    targetInstanceId,
    nowMs = Date.now(),
    idFactory = randomId,
  ) {
    const source = normalizeTabRecord(sourceRecord, sourceRecord && sourceRecord.tabId, nowMs);
    const normalizedTargetTabId = normalizedText(targetTabId);
    const parts = normalizeCarry(source.carry).parts;
    if (!source.tabId || !normalizedTargetTabId || source.tabId === normalizedTargetTabId || !parts.length) {
      return null;
    }
    return {
      schemaVersion: 1,
      id: idFactory("carry-transfer", nowMs),
      sourceTabId: source.tabId,
      targetTabId: normalizedTargetTabId,
      parts,
      createdAtMs: nowMs,
      targetInstanceId: normalizedText(targetInstanceId),
    };
  }

  function carryTransferIssue(rawTransfer) {
    if (rawTransfer === null || rawTransfer === undefined || normalizeCarryTransfer(rawTransfer)) {
      return null;
    }
    const unsupportedSchema = Boolean(
      rawTransfer &&
        typeof rawTransfer === "object" &&
        Object.prototype.hasOwnProperty.call(rawTransfer, "schemaVersion") &&
        rawTransfer.schemaVersion !== 1,
    );
    return {
      status: "unreadable",
      kind: unsupportedSchema ? "unsupported-schema" : "malformed",
      fingerprint: JSON.stringify(rawTransfer),
      rawTransfer,
    };
  }

  function completeCarryTransfer(store) {
    const rawTransfer = store.get(CARRY_TRANSFER_KEY, null);
    if (rawTransfer === null || rawTransfer === undefined) return null;
    const transfer = normalizeCarryTransfer(rawTransfer);
    if (!transfer) {
      return carryTransferIssue(rawTransfer);
    }

    const target = normalizeTabRecord(
      store.get(tabStorageKey(transfer.targetTabId), null),
      transfer.targetTabId,
      transfer.createdAtMs,
    );
    target.carry = mergeCarry(target.carry, { parts: transfer.parts });
    target.heartbeatMs = Math.max(target.heartbeatMs, transfer.createdAtMs);
    if (!target.instanceId) target.instanceId = transfer.targetInstanceId;
    store.set(tabStorageKey(transfer.targetTabId), target);

    const transferredIds = new Set(transfer.parts.map((part) => part.id));
    const source = normalizeTabRecord(
      store.get(tabStorageKey(transfer.sourceTabId), null),
      transfer.sourceTabId,
      transfer.createdAtMs,
    );
    source.carry = normalizeCarry({
      parts: source.carry.parts.filter((part) => !transferredIds.has(part.id)),
    });
    store.set(tabStorageKey(transfer.sourceTabId), source);

    // Initial versions could leave a part in both records if attachment was
    // interrupted between their writes. A new explicit transfer designates one
    // owner, so remove any still-carried legacy copies everywhere else.
    for (const key of store.keys()) {
      const tabId = tabIdFromStorageKey(key);
      if (!tabId || tabId === transfer.targetTabId || tabId === transfer.sourceTabId) continue;
      const record = normalizeTabRecord(store.get(key, null), tabId, transfer.createdAtMs);
      const parts = record.carry.parts.filter((part) => !transferredIds.has(part.id));
      if (parts.length === record.carry.parts.length) continue;
      record.carry = normalizeCarry({ parts });
      store.set(key, record);
    }

    store.delete(CARRY_TRANSFER_KEY);
    return { transfer, target, source };
  }

  function discardCarryTransferJournal(store, expectedFingerprint) {
    const rawTransfer = store.get(CARRY_TRANSFER_KEY, null);
    if (rawTransfer === null || rawTransfer === undefined) return false;
    const issue = carryTransferIssue(rawTransfer);
    if (!issue) {
      throw new Error("The saved carry transfer is now readable and was not discarded.");
    }
    if (issue.fingerprint !== expectedFingerprint) {
      throw new Error("The saved carry transfer changed and was not discarded.");
    }
    store.delete(CARRY_TRANSFER_KEY);
    return true;
  }

  function beginCarryTransfer(store, transfer) {
    const normalized = normalizeCarryTransfer(transfer);
    if (!normalized) throw new Error("Cannot start an invalid carry transfer.");
    const existing = store.get(CARRY_TRANSFER_KEY, null);
    if (existing !== null && existing !== undefined) {
      throw new Error("Another carry transfer must be recovered before starting a new one.");
    }
    store.set(CARRY_TRANSFER_KEY, normalized);
    return completeCarryTransfer(store);
  }

  function validateConfig(config = CONFIG) {
    const errors = [];
    if (!normalizedText(config.togglApiToken)) errors.push("Set CONFIG.togglApiToken.");
    if (!Number.isInteger(Number(config.togglWorkspaceId)) || Number(config.togglWorkspaceId) <= 0) {
      errors.push("Set CONFIG.togglWorkspaceId to a positive integer.");
    }
    if (
      config.togglProjectId !== null &&
      (!Number.isInteger(Number(config.togglProjectId)) || Number(config.togglProjectId) <= 0)
    ) {
      errors.push("CONFIG.togglProjectId must be null or a positive integer.");
    }
    if (!Number.isFinite(Number(config.inactivityMinutes)) || Number(config.inactivityMinutes) <= 0) {
      errors.push("CONFIG.inactivityMinutes must be greater than zero.");
    }
    if (!Number.isFinite(Number(config.minimumDurationMinutes)) || Number(config.minimumDurationMinutes) < 0) {
      errors.push("CONFIG.minimumDurationMinutes must be zero or greater.");
    }
    if (!Number.isInteger(Number(config.maxRequestsPerHour)) || Number(config.maxRequestsPerHour) <= 0) {
      errors.push("CONFIG.maxRequestsPerHour must be a positive integer.");
    }
    return errors;
  }

  function configFingerprint(config = CONFIG) {
    const input = [
      normalizedText(config.togglApiToken),
      String(config.togglWorkspaceId),
      String(config.togglProjectId),
    ].join("\u0000");
    let hash = 0x811c9dc5;
    for (let index = 0; index < input.length; index += 1) {
      hash ^= input.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  function buildTogglRequest(entry, config = CONFIG) {
    const body = {
      workspace_id: Number(config.togglWorkspaceId),
      created_with: SCRIPT_ID,
      description: entry.description,
      start: entry.start,
      duration: Math.max(1, Math.round(finiteNumber(entry.duration))),
    };
    if (config.togglProjectId !== null) body.project_id = Number(config.togglProjectId);
    return {
      url: `https://api.track.toggl.com/api/v9/workspaces/${Number(config.togglWorkspaceId)}/time_entries`,
      body,
    };
  }

  function parseResponseHeaders(rawHeaders) {
    const headers = {};
    String(rawHeaders || "")
      .split(/\r?\n/)
      .forEach((line) => {
        const separator = line.indexOf(":");
        if (separator <= 0) return;
        const name = line.slice(0, separator).trim().toLocaleLowerCase();
        const value = line.slice(separator + 1).trim();
        if (name) headers[name] = headers[name] ? `${headers[name]}, ${value}` : value;
      });
    return headers;
  }

  function retryAfterMs(value, nowMs) {
    if (!value) return 0;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return nowMs + seconds * 1000;
    const dateMs = Date.parse(value);
    return Number.isFinite(dateMs) ? Math.max(nowMs, dateMs) : 0;
  }

  function quotaResetAt(headers, nowMs) {
    const seconds = Number(headers["x-toggl-quota-resets-in"]);
    return Number.isFinite(seconds) && seconds >= 0 ? nowMs + seconds * 1000 : 0;
  }

  function compactBody(body) {
    const text = normalizedText(body);
    if (!text) return "";
    return text.length > 240 ? `${text.slice(0, 237)}...` : text;
  }

  function classifyAttempt(outcome, nowMs = Date.now()) {
    if (!outcome || outcome.type !== "response") {
      const label = outcome && outcome.type ? outcome.type : "interrupted request";
      return {
        status: "uncertain",
        message: `Toggl create outcome is uncertain (${label}). Check Toggl before retrying.`,
        nextAttemptAtMs: 0,
        quotaUntilMs: 0,
        stopWorker: true,
      };
    }

    const status = Number(outcome.status);
    const headers = parseResponseHeaders(outcome.responseHeaders);
    const resetAt = quotaResetAt(headers, nowMs);
    const remaining = Number(headers["x-toggl-quota-remaining"]);
    const successQuotaUntil = Number.isFinite(remaining) && remaining <= 0 ? resetAt : 0;
    const detail = compactBody(outcome.responseText);

    if (status >= 200 && status < 300) {
      return {
        status: "sent",
        message: "",
        nextAttemptAtMs: 0,
        quotaUntilMs: successQuotaUntil,
        stopWorker: false,
      };
    }

    if (status === 402) {
      const nextAttemptAtMs = resetAt || nowMs + ONE_HOUR_MS;
      return {
        status: "pending",
        message: `Toggl hourly quota rejected the request (HTTP 402).${detail ? ` ${detail}` : ""}`,
        nextAttemptAtMs,
        quotaUntilMs: nextAttemptAtMs,
        stopWorker: true,
      };
    }

    if (status === 429) {
      const retryAt = retryAfterMs(headers["retry-after"], nowMs);
      const nextAttemptAtMs = Math.max(resetAt, retryAt) || nowMs + DEFAULT_RATE_BACKOFF_MS;
      return {
        status: "pending",
        message: `Toggl rate-limited the request (HTTP 429).`,
        nextAttemptAtMs,
        quotaUntilMs: nextAttemptAtMs,
        stopWorker: true,
      };
    }

    if (status === 408 || status >= 500 || status === 0) {
      return {
        status: "uncertain",
        message: `Toggl create outcome is uncertain (HTTP ${status || "unknown"}). Check Toggl before retrying.${
          detail ? ` ${detail}` : ""
        }`,
        nextAttemptAtMs: 0,
        quotaUntilMs: 0,
        stopWorker: true,
      };
    }

    if (status === 401 || status === 403) {
      return {
        status: "blocked",
        message: `Toggl authentication failed (HTTP ${status}). Check the API token and workspace access.`,
        nextAttemptAtMs: 0,
        quotaUntilMs: 0,
        stopWorker: true,
        authFailure: true,
      };
    }

    return {
      status: "blocked",
      message: `Toggl rejected the entry (HTTP ${status}).${detail ? ` ${detail}` : ""}`,
      nextAttemptAtMs: 0,
      quotaUntilMs: 0,
      stopWorker: false,
    };
  }

  function rollingAttemptWindow(attempts, nowMs, maximum) {
    const recent = (Array.isArray(attempts) ? attempts : [])
      .map((value) => finiteNumber(value))
      .filter((value) => value > nowMs - ONE_HOUR_MS && value <= nowMs)
      .sort((a, b) => a - b);
    const limit = Math.max(1, Math.floor(finiteNumber(maximum, 30)));
    return {
      attempts: recent,
      allowed: recent.length < limit,
      retryAtMs: recent.length < limit ? nowMs : recent[0] + ONE_HOUR_MS,
    };
  }

  function requestSpacingDelay(lastRequestAtMs, nowMs) {
    const elapsedMs = Math.max(0, nowMs - nonNegativeNumber(lastRequestAtMs));
    return Math.max(0, REQUEST_SPACING_MS - elapsedMs);
  }

  function normalizeQueue(queue) {
    const entries = Array.isArray(queue) ? queue : [];
    const seen = new Set();
    return entries
      .filter((entry) => {
        if (!entry || typeof entry.id !== "string" || !entry.id || seen.has(entry.id)) return false;
        seen.add(entry.id);
        return true;
      })
      .map((entry) => {
        return {
          schemaVersion: SCHEMA_VERSION,
          id: entry.id,
          sourceSessionId: normalizedText(entry.sourceSessionId),
          sourceTabId: normalizedText(entry.sourceTabId),
          channel: normalizeChannel(entry.channel),
          description: normalizedText(entry.description) || "YouTube",
          start: entry.start,
          duration: Math.max(1, Math.round(finiteNumber(entry.duration, 1))),
          reason: normalizedText(entry.reason),
          queuedAtMs: nonNegativeNumber(entry.queuedAtMs),
          status: ["pending", "sending", "uncertain", "blocked"].includes(entry.status)
            ? entry.status
            : "pending",
          nextAttemptAtMs: nonNegativeNumber(entry.nextAttemptAtMs),
          attemptCount: nonNegativeNumber(entry.attemptCount),
          sendingSinceMs: nonNegativeNumber(entry.sendingSinceMs),
          lastError: normalizedText(entry.lastError),
        };
      });
  }

  function enqueueUnique(queue, entries) {
    const next = normalizeQueue(queue);
    const ids = new Set(next.map((entry) => entry.id));
    for (const rawEntry of entries || []) {
      const normalized = normalizeQueue([rawEntry])[0];
      if (normalized && !ids.has(normalized.id)) {
        ids.add(normalized.id);
        next.push(normalized);
      }
    }
    return next;
  }

  function markInterruptedRequestsUncertain(queue) {
    return normalizeQueue(queue).map((entry) =>
      entry.status === "sending"
        ? {
            ...entry,
            status: "uncertain",
            sendingSinceMs: 0,
            lastError:
              "The page closed while this Toggl create request was in flight. Check Toggl before retrying.",
          }
        : entry,
    );
  }

  function closestTrackablePlayer(video) {
    if (!video || typeof video.closest !== "function") return null;
    try {
      const moviePlayer = video.closest("#movie_player");
      if (moviePlayer) return moviePlayer;

      // Shorts can briefly expose the active reel before its player receives
      // the stable movie_player ID. Restrict that fallback to the active reel;
      // browse-page thumbnail previews must never become playback candidates.
      if (video.closest("ytd-reel-video-renderer[is-active]")) {
        return video.closest(".html5-video-player");
      }
    } catch (_error) {
      // YouTube may detach or replace the video's ancestors while navigating.
    }
    return null;
  }

  function isTopLevelBrowsingContext() {
    if (typeof window === "undefined") return false;
    try {
      return window.self === window.top;
    } catch (_error) {
      return false;
    }
  }

  function selectActiveVideo(videos) {
    const list = Array.from(videos || []).filter(
      (video) => video && closestTrackablePlayer(video),
    );
    return (
      list.find((video) => !video.paused && !video.ended && finiteNumber(video.readyState) >= 2) ||
      list.find((video) => video.closest && video.closest("ytd-reel-video-renderer[is-active]")) ||
      list.find((video) => video.closest && video.closest("#movie_player")) ||
      list[0] ||
      null
    );
  }

  function channelFromVideoData(videoData, fallback = {}) {
    const data = videoData && typeof videoData === "object" ? videoData : {};
    return normalizeChannel({
      id: data.channel_id || data.channelId || fallback.id,
      name: data.author || data.ownerChannelName || fallback.name,
    });
  }

  class GMStore {
    get(key, fallback) {
      return clone(GM_getValue(key, fallback));
    }

    set(key, value) {
      GM_setValue(key, clone(value));
    }

    delete(key) {
      GM_deleteValue(key);
    }

    keys() {
      return GM_listValues();
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
  }

  async function withCrossTabLock(store, name, callback, options = {}) {
    const lockName = `yt-toggl:${name}`;
    if (typeof navigator !== "undefined" && navigator.locks && navigator.locks.request) {
      const lockOptions = options.ifAvailable ? { ifAvailable: true } : {};
      return navigator.locks.request(lockName, lockOptions, (lock) => {
        if (!lock) return LOCK_UNAVAILABLE;
        return callback();
      });
    }

    const owner = randomId("lock");
    const key = `${LOCK_KEY_PREFIX}${name}`;
    const leaseMs = options.leaseMs || 90 * 1000;
    const deadlineMs = Date.now() + (options.ifAvailable ? 0 : 5000);
    do {
      const nowMs = Date.now();
      const existing = store.get(key, null);
      if (!existing || finiteNumber(existing.expiresAtMs) <= nowMs || existing.owner === owner) {
        store.set(key, { owner, expiresAtMs: nowMs + leaseMs });
        await sleep(40 + Math.floor(Math.random() * 40));
        const confirmed = store.get(key, null);
        if (confirmed && confirmed.owner === owner) {
          try {
            return await callback();
          } finally {
            const current = store.get(key, null);
            if (current && current.owner === owner) store.delete(key);
          }
        }
      }
      if (options.ifAvailable) return LOCK_UNAVAILABLE;
      await sleep(50 + Math.floor(Math.random() * 75));
    } while (Date.now() <= deadlineMs);
    throw new Error(`Could not acquire cross-tab lock: ${name}`);
  }

  class SharedQueue {
    constructor(store) {
      this.store = store;
    }

    get() {
      return normalizeQueue(this.store.get(QUEUE_KEY, []));
    }

    async mutate(callback) {
      return withCrossTabLock(this.store, "queue", () => {
        const current = this.get();
        const next = normalizeQueue(callback(current) || current);
        this.store.set(QUEUE_KEY, next);
        return next;
      });
    }

    async add(entries) {
      if (!entries || entries.length === 0) return this.get();
      return this.mutate((queue) => enqueueUnique(queue, entries));
    }

    async update(id, callback) {
      return this.mutate((queue) =>
        queue.map((entry) => (entry.id === id ? { ...entry, ...callback(clone(entry)) } : entry)),
      );
    }

    async remove(id) {
      return this.mutate((queue) => queue.filter((entry) => entry.id !== id));
    }
  }

  function tabStorageKey(tabId) {
    return `${TAB_KEY_PREFIX}${tabId}`;
  }

  function tabIdFromStorageKey(key) {
    return key.startsWith(TAB_KEY_PREFIX) ? key.slice(TAB_KEY_PREFIX.length) : "";
  }

  function getOrCreateTabIdentity() {
    try {
      let tabId = sessionStorage.getItem(TAB_ID_SESSION_KEY);
      if (tabId) return { tabId, reused: true };
      tabId = randomId("tab");
      sessionStorage.setItem(TAB_ID_SESSION_KEY, tabId);
      return { tabId, reused: false };
    } catch (_error) {
      return { tabId: randomId("tab"), reused: false };
    }
  }

  function appendError(store, message, kind = "runtime", nowMs = Date.now()) {
    const storedErrors = store.get(ERRORS_KEY, []);
    const errors = Array.isArray(storedErrors) ? storedErrors : [];
    errors.push({ id: randomId("error", nowMs), atMs: nowMs, kind, message: normalizedText(message) });
    store.set(ERRORS_KEY, errors.slice(-MAX_ERROR_HISTORY));
  }

  function getPlayedRanges(video) {
    const ranges = [];
    try {
      for (let index = 0; index < video.played.length; index += 1) {
        ranges.push([video.played.start(index), video.played.end(index)]);
      }
    } catch (_error) {
      return [];
    }
    return ranges;
  }

  function safeVideoData(player) {
    const candidates = [player, player && player.wrappedJSObject].filter(Boolean);
    for (const candidate of candidates) {
      try {
        if (typeof candidate.getVideoData === "function") return candidate.getVideoData() || {};
      } catch (_error) {
        // YouTube may replace the player object during SPA navigation.
      }
    }
    return {};
  }

  function textFrom(root, selectors) {
    for (const selector of selectors) {
      try {
        const element = root && root.querySelector ? root.querySelector(selector) : null;
        const text = normalizedText(element && (element.textContent || element.getAttribute("aria-label")));
        if (text) return text;
      } catch (_error) {
        // Continue through fallbacks when YouTube is replacing a subtree.
      }
    }
    return "";
  }

  function channelIdFromDom(root) {
    const selectors = [
      'meta[itemprop="channelId"]',
      'link[itemprop="url"][href*="/channel/UC"]',
      'ytd-video-owner-renderer a[href*="/channel/UC"]',
      'ytd-reel-player-header-renderer a[href*="/channel/UC"]',
      'a[href*="/channel/UC"]',
    ];
    for (const selector of selectors) {
      const element = (root && root.querySelector && root.querySelector(selector)) || document.querySelector(selector);
      if (!element) continue;
      const value = element.getAttribute("content") || element.getAttribute("href") || "";
      const match = value.match(/(?:\/channel\/)?(UC[\w-]+)/);
      if (match) return match[1];
    }
    return "";
  }

  function currentInitialPlayerResponse(videoId) {
    try {
      const pageWindow = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
      const candidates = [
        pageWindow.ytInitialPlayerResponse,
        pageWindow.ytplayer && pageWindow.ytplayer.config && pageWindow.ytplayer.config.args
          ? pageWindow.ytplayer.config.args.raw_player_response
          : null,
      ];
      for (let candidate of candidates) {
        if (typeof candidate === "string") candidate = JSON.parse(candidate);
        const details = candidate && candidate.videoDetails;
        if (details && (!videoId || normalizedText(details.videoId) === videoId)) return details;
      }
    } catch (_error) {
      // DOM/player fallbacks below are enough when page globals are unavailable.
    }
    return {};
  }

  function pageVideoId() {
    try {
      const url = new URL(location.href);
      if (url.pathname === "/watch") return normalizedText(url.searchParams.get("v"));
      const shortsMatch = url.pathname.match(/^\/shorts\/([^/?#]+)/);
      return shortsMatch ? normalizedText(shortsMatch[1]) : "";
    } catch (_error) {
      return "";
    }
  }

  function discoverMedia(discontinuityToken = 0) {
    const video = selectActiveVideo(document.querySelectorAll("video"));
    const nowMs = Date.now();
    const monotonicMs =
      typeof performance !== "undefined" && typeof performance.now === "function"
        ? performance.now()
        : nowMs;
    if (!video) {
      return normalizeSnapshot({ nowMs, monotonicMs, discontinuityToken });
    }
    const neutralSnapshot = () => normalizeSnapshot({ nowMs, monotonicMs, discontinuityToken });

    const player = closestTrackablePlayer(video);
    let videoData = safeVideoData(player);
    if (!Object.keys(videoData).length) {
      try {
        const pagePlayer =
          typeof unsafeWindow !== "undefined" && unsafeWindow.document
            ? unsafeWindow.document.getElementById("movie_player")
            : null;
        videoData = safeVideoData(pagePlayer);
      } catch (_error) {
        // Initial player response and DOM metadata remain as fallbacks.
      }
    }
    const playerHasAd = Boolean(
      player &&
        player.classList &&
        (player.classList.contains("ad-showing") || player.classList.contains("ad-interrupting")),
    );
    const dataHasAd = Boolean(videoData.isAd || videoData.is_ad);
    // Ad metadata can identify the advertiser, and player metadata can lag the
    // destination route during navigation. Neither state may create content
    // attribution until the content identity is coherent again.
    if (playerHasAd || dataHasAd) return neutralSnapshot();

    const routeVideoId = pageVideoId();
    const playerVideoId = normalizedText(videoData.video_id || videoData.videoId);
    if (routeVideoId && playerVideoId && routeVideoId !== playerVideoId) return neutralSnapshot();

    let expectedVideoId = routeVideoId || playerVideoId;
    const initialDetails = currentInitialPlayerResponse(expectedVideoId);
    const initialVideoId = normalizedText(initialDetails.videoId);
    if (routeVideoId && !playerVideoId && initialVideoId !== routeVideoId) return neutralSnapshot();
    if (initialVideoId && (!expectedVideoId || initialVideoId === expectedVideoId)) {
      expectedVideoId = expectedVideoId || initialVideoId;
      const identifiedPlayerData = playerVideoId ? videoData : {};
      videoData = {
        ...identifiedPlayerData,
        channel_id:
          initialDetails.channelId ||
          identifiedPlayerData.channel_id ||
          identifiedPlayerData.channelId ||
          "",
        author:
          initialDetails.author ||
          identifiedPlayerData.author ||
          identifiedPlayerData.ownerChannelName ||
          "",
        video_id: expectedVideoId,
      };
    }

    const scope = (video.closest && video.closest("ytd-reel-video-renderer[is-active]")) || document;
    const fallbackName = textFrom(scope, [
      "ytd-channel-name #text",
      "#channel-name #text",
      "ytd-video-owner-renderer #text",
      "ytd-reel-player-header-renderer #channel-name",
      'a[href^="/@"]',
    ]);
    const contentChannel = channelFromVideoData(videoData, {
      id: channelIdFromDom(scope),
      name: fallbackName,
    });

    const channel = contentChannel;
    const playbackRate = finiteNumber(video.playbackRate, 1);
    const hasCurrentData = finiteNumber(video.readyState) >= 2;
    const progressAllowed = Boolean(channel && !video.seeking);
    const eligible = Boolean(
      progressAllowed && !video.paused && !video.ended && hasCurrentData && playbackRate > 0,
    );
    const mediaKey = normalizedText(
      expectedVideoId ||
        videoData.video_id ||
        videoData.videoId ||
        video.currentSrc ||
        `${location.pathname}:${location.search}`,
    );

    return normalizeSnapshot({
      nowMs,
      monotonicMs,
      eligible,
      progressAllowed,
      channel,
      mediaKey,
      mediaTime: finiteNumber(video.currentTime),
      playbackRate,
      playedRanges: getPlayedRanges(video),
      discontinuityToken,
    });
  }

  function encodeBasicAuth(token) {
    const input = `${token}:api_token`;
    const bytes = new TextEncoder().encode(input);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return `Basic ${btoa(binary)}`;
  }

  function postTogglEntry(entry, config = CONFIG) {
    const request = buildTogglRequest(entry, config);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (outcome) => {
        if (settled) return;
        settled = true;
        resolve(outcome);
      };
      try {
        GM_xmlhttpRequest({
          method: "POST",
          url: request.url,
          headers: {
            Authorization: encodeBasicAuth(config.togglApiToken),
            "Content-Type": "application/json",
          },
          data: JSON.stringify(request.body),
          timeout: REQUEST_TIMEOUT_MS,
          anonymous: true,
          onload: (response) =>
            finish({
              type: "response",
              status: response.status,
              responseHeaders: response.responseHeaders,
              responseText: response.responseText,
            }),
          ontimeout: () => finish({ type: "timeout" }),
          onerror: () => finish({ type: "network-error" }),
          onabort: () => finish({ type: "aborted" }),
        });
      } catch (_error) {
        finish({ type: "request-error" });
      }
    });
  }

  class TogglWorker {
    constructor(store, queue, config = CONFIG) {
      this.store = store;
      this.queue = queue;
      this.config = config;
      this.workerId = randomId("worker");
      this.kickPromise = null;
    }

    kick() {
      if (this.kickPromise) return this.kickPromise;
      const run = Promise.resolve()
        .then(() => this.drain())
        .catch((error) => appendError(this.store, error && error.message ? error.message : String(error), "worker"))
        .finally(() => {
          if (this.kickPromise === run) this.kickPromise = null;
        });
      this.kickPromise = run;
      return run;
    }

    async drain() {
      const result = await withCrossTabLock(
        this.store,
        "worker",
        async () => {
          const drainDeadlineMs = Date.now() + 60 * 1000;
          await this.recoverInterruptedRequests();
          if (validateConfig(this.config).length > 0) return;
          const fingerprint = configFingerprint(this.config);
          const authBlock = this.store.get(AUTH_BLOCK_KEY, null);
          if (authBlock && authBlock.fingerprint === fingerprint) return;
          if (authBlock) this.store.delete(AUTH_BLOCK_KEY);

          let claimMisses = 0;
          while (true) {
            const nowMs = Date.now();
            if (nowMs >= drainDeadlineMs) return;
            const quota = this.store.get(QUOTA_KEY, { untilMs: 0, reason: "" });
            if (finiteNumber(quota.untilMs) > nowMs) return;

            const queue = this.queue.get();
            const candidate = queue.find(
              (entry) => entry.status === "pending" && finiteNumber(entry.nextAttemptAtMs) <= nowMs,
            );
            if (!candidate) return;

            const attemptWindow = rollingAttemptWindow(
              this.store.get(ATTEMPTS_KEY, []),
              nowMs,
              this.config.maxRequestsPerHour,
            );
            this.store.set(ATTEMPTS_KEY, attemptWindow.attempts);
            if (!attemptWindow.allowed) {
              this.store.set(QUOTA_KEY, {
                untilMs: attemptWindow.retryAtMs,
                reason: "Local rolling-hour attempt limit",
              });
              return;
            }

            const spacingMs = requestSpacingDelay(this.store.get(LAST_REQUEST_KEY, 0), Date.now());
            if (spacingMs > 0) await sleep(spacingMs);

            const sendingAtMs = Date.now();
            let claimed = false;
            let awaitingLocalCommit = false;
            await withCrossTabLock(this.store, "tabs", async () => {
              if (candidate.sourceTabId && candidate.sourceSessionId) {
                const sourceRecord = normalizeTabRecord(
                  this.store.get(tabStorageKey(candidate.sourceTabId), null),
                  candidate.sourceTabId,
                  sendingAtMs,
                );
                awaitingLocalCommit = Boolean(
                  sourceRecord.active && sourceRecord.active.id === candidate.sourceSessionId,
                );
              }
              if (awaitingLocalCommit) return;
              await this.queue.mutate((entries) =>
                entries.map((entry) => {
                  if (entry.id !== candidate.id || entry.status !== "pending") return entry;
                  claimed = true;
                  return {
                    ...entry,
                    status: "sending",
                    sendingSinceMs: sendingAtMs,
                    attemptCount: entry.attemptCount + 1,
                    lastError: "",
                  };
                }),
              );
            });
            // Queue persistence happens before the source tab is cleared. If a
            // page dies in that tiny interval, do not POST until recovery has
            // completed the same deterministic local commit.
            if (awaitingLocalCommit) return;
            if (!claimed) {
              claimMisses += 1;
              if (claimMisses >= 3) return;
              continue;
            }
            claimMisses = 0;

            const attempts = rollingAttemptWindow(
              this.store.get(ATTEMPTS_KEY, []),
              sendingAtMs,
              this.config.maxRequestsPerHour,
            ).attempts;
            attempts.push(sendingAtMs);
            this.store.set(ATTEMPTS_KEY, attempts);
            this.store.set(LAST_REQUEST_KEY, sendingAtMs);

            const outcome = await postTogglEntry(candidate, this.config);
            const classification = classifyAttempt(outcome, Date.now());
            if (classification.status === "sent") {
              await this.queue.remove(candidate.id);
            } else {
              await this.queue.update(candidate.id, () => ({
                status: classification.status,
                nextAttemptAtMs: classification.nextAttemptAtMs,
                sendingSinceMs: 0,
                lastError: classification.message,
              }));
              appendError(this.store, classification.message, classification.status);
            }

            if (classification.quotaUntilMs > Date.now()) {
              this.store.set(QUOTA_KEY, {
                untilMs: classification.quotaUntilMs,
                reason: classification.message || "Toggl quota reset",
              });
            }
            if (classification.authFailure) {
              this.store.set(AUTH_BLOCK_KEY, {
                fingerprint,
                atMs: Date.now(),
                message: classification.message,
              });
            }
            if (classification.stopWorker) return;
          }
        },
        { ifAvailable: true, leaseMs: 2 * 60 * 1000 },
      );
      return result === LOCK_UNAVAILABLE ? false : true;
    }

    async recoverInterruptedRequests() {
      await this.queue.mutate(markInterruptedRequestsUncertain);
    }
  }

  function formatDuration(durationMs) {
    const totalSeconds = Math.max(0, Math.round(nonNegativeNumber(durationMs) / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return hours > 0
      ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
      : `${minutes}:${String(seconds).padStart(2, "0")}`;
  }

  class StatusControl {
    constructor(app) {
      this.app = app;
      this.expanded = false;
      this.host = document.createElement("div");
      this.host.id = "yt-toggl-status-host";
      this.shadow = this.host.attachShadow({ mode: "open" });
      // YouTube enforces Trusted Types in the page realm, so build the static
      // shell without an HTML-parsing sink such as ShadowRoot.innerHTML.
      const style = document.createElement("style");
      style.textContent = `
        :host { all: initial; }
        * { box-sizing: border-box; }
        .wrap { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
          color: #f4f4f4; font: 13px/1.35 system-ui, sans-serif; }
        button { border: 1px solid #545454; border-radius: 7px; background: #252525; color: inherit;
          padding: 7px 10px; cursor: pointer; font: inherit; }
        button:hover { background: #343434; }
        button:disabled { cursor: default; opacity: 0.55; }
        button.danger { color: #ffaaaa; }
        #summary { display: block; margin-left: auto; border-radius: 999px; background: #171717;
          box-shadow: 0 2px 12px #0008; }
        #summary[data-state="issue"] { border-color: #d9822b; }
        #summary[data-state="active"] { border-color: #42b983; }
        #panel { width: min(390px, calc(100vw - 32px)); max-height: min(620px, calc(100vh - 80px));
          overflow: auto; margin-bottom: 8px; padding: 14px; border: 1px solid #4a4a4a; border-radius: 10px;
          background: #171717; box-shadow: 0 6px 24px #000a; }
        #panel[hidden] { display: none; }
        h2 { margin: 0 0 10px; font-size: 15px; }
        h3 { margin: 14px 0 6px; font-size: 13px; color: #cfcfcf; }
        dl { display: grid; grid-template-columns: auto 1fr; gap: 5px 12px; margin: 0; }
        dt { color: #aaa; } dd { margin: 0; text-align: right; overflow-wrap: anywhere; }
        .actions { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 12px; }
        .notice { margin-top: 10px; padding: 8px; border-radius: 6px; background: #372817; color: #ffd8a8; }
        .item { margin-top: 7px; padding-top: 7px; border-top: 1px solid #383838; }
        .item p { margin: 0 0 6px; overflow-wrap: anywhere; }
        .item .meta { color: #aaa; font-size: 12px; }
        .empty { color: #888; }
      `;

      const wrap = document.createElement("div");
      wrap.className = "wrap";

      const panel = document.createElement("section");
      panel.id = "panel";
      panel.hidden = true;

      const heading = document.createElement("h2");
      heading.textContent = "YouTube → Toggl";

      const details = document.createElement("dl");
      const appendDetail = (label, id, value) => {
        const term = document.createElement("dt");
        term.textContent = label;
        const description = document.createElement("dd");
        description.id = id;
        description.textContent = value;
        details.append(term, description);
      };
      appendDetail("Current tab", "current", "0:00");
      appendDetail("Carried short", "carry", "0:00");
      appendDetail("Finalized queue", "queue", "0");
      appendDetail("Errors / decisions", "issues", "0");

      const configBox = document.createElement("div");
      configBox.id = "config";

      const actions = document.createElement("div");
      actions.className = "actions";
      const sync = document.createElement("button");
      sync.id = "sync";
      sync.type = "button";
      sync.textContent = "Sync all tabs";
      const discardCurrent = document.createElement("button");
      discardCurrent.id = "discard-current";
      discardCurrent.className = "danger";
      discardCurrent.type = "button";
      discardCurrent.hidden = true;
      discardCurrent.textContent = "Discard current carry";
      actions.append(sync, discardCurrent);

      const orphanBox = document.createElement("div");
      orphanBox.id = "orphans";
      const decisionBox = document.createElement("div");
      decisionBox.id = "decisions";
      const errorBox = document.createElement("div");
      errorBox.id = "errors";
      panel.append(heading, details, configBox, actions, orphanBox, decisionBox, errorBox);

      const summary = document.createElement("button");
      summary.id = "summary";
      summary.type = "button";
      summary.setAttribute("aria-expanded", "false");
      summary.textContent = "YT → Toggl 0:00";
      wrap.append(panel, summary);
      this.shadow.append(style, wrap);

      this.panel = panel;
      this.summary = summary;
      this.summary.addEventListener("click", () => {
        this.expanded = !this.expanded;
        this.panel.hidden = !this.expanded;
        this.summary.setAttribute("aria-expanded", String(this.expanded));
        this.render();
      });
      sync.addEventListener("click", () => this.app.broadcastSync());
      discardCurrent.addEventListener("click", () => this.app.discardCurrentCarry());
    }

    mount() {
      (document.body || document.documentElement).appendChild(this.host);
      this.render();
    }

    makeAction(label, callback, danger = false, disabled = false) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      if (danger) button.className = "danger";
      button.disabled = disabled;
      button.addEventListener("click", callback);
      return button;
    }

    render() {
      if (!this.host.isConnected) return;
      const record = this.app.getOwnRecord();
      const currentMs = record.active ? record.active.durationMs : 0;
      const carryMs = carryDurationMs(record.carry);
      const queue = this.app.queue.get();
      const decisions = queue.filter((entry) => entry.status === "uncertain" || entry.status === "blocked");
      const pendingCount = queue.filter((entry) => entry.status === "pending" || entry.status === "sending").length;
      const storedErrors = this.app.store.get(ERRORS_KEY, []);
      const errors = Array.isArray(storedErrors) ? storedErrors : [];
      const configErrors = validateConfig(this.app.config);
      const carryTransferProblem = this.app.getCarryTransferIssue();
      const identityPending = !this.app.identityResolved;
      const issueCount =
        decisions.length + configErrors.length + errors.length + (carryTransferProblem ? 1 : 0);

      this.shadow.getElementById("current").textContent = record.active
        ? `${formatDuration(currentMs)} · ${record.active.channel.name || record.active.channel.id}`
        : "0:00 · idle";
      this.shadow.getElementById("carry").textContent = formatDuration(carryMs);
      this.shadow.getElementById("queue").textContent = `${queue.length} (${pendingCount} pending)`;
      this.shadow.getElementById("issues").textContent = String(issueCount);
      this.summary.textContent = `YT → Toggl ${formatDuration(currentMs)} · Q${queue.length}`;
      this.summary.dataset.state = issueCount ? "issue" : record.active ? "active" : "idle";
      if (!this.expanded) return;

      const configBox = this.shadow.getElementById("config");
      configBox.replaceChildren();
      if (configErrors.length) {
        const notice = document.createElement("div");
        notice.className = "notice";
        notice.textContent = configErrors.join(" ");
        configBox.appendChild(notice);
      }

      const discardCurrent = this.shadow.getElementById("discard-current");
      discardCurrent.hidden = carryMs <= 0;
      discardCurrent.disabled = identityPending;
      this.shadow.getElementById("sync").disabled = identityPending;

      const orphanBox = this.shadow.getElementById("orphans");
      orphanBox.replaceChildren();
      if (carryTransferProblem) {
        const heading = document.createElement("h3");
        heading.textContent = "Unreadable carry transfer";
        const item = document.createElement("div");
        item.className = "item";
        const text = document.createElement("p");
        text.textContent =
          carryTransferProblem.kind === "unsupported-schema"
            ? "This transfer was saved by an unsupported script version. Update and reload every YouTube tab before discarding it."
            : "This saved transfer is malformed and cannot be recovered automatically.";
        const meta = document.createElement("p");
        meta.className = "meta";
        meta.textContent =
          "Tracking continues. Discarding removes only the journal; carry already written to tab records remains, so ownership may be ambiguous.";
        const actions = document.createElement("div");
        actions.className = "actions";
        actions.append(
          this.makeAction(
            "Discard saved transfer",
            () => this.app.discardUnreadableCarryTransfer(carryTransferProblem.fingerprint),
            true,
            identityPending,
          ),
        );
        item.append(text, meta, actions);
        orphanBox.append(heading, item);
      }
      const orphans = this.app.getStaleCarryRecords();
      if (orphans.length) {
        const heading = document.createElement("h3");
        heading.textContent = "Stale tab carry";
        orphanBox.appendChild(heading);
        for (const orphan of orphans) {
          const item = document.createElement("div");
          item.className = "item";
          const text = document.createElement("p");
          text.textContent = `${formatDuration(carryDurationMs(orphan.carry))} from tab …${orphan.tabId.slice(-8)}`;
          const actions = document.createElement("div");
          actions.className = "actions";
          actions.append(
            this.makeAction(
              "Attach to this tab",
              () => this.app.attachStaleCarry(orphan.tabId),
              false,
              identityPending,
            ),
            this.makeAction(
              "Discard",
              () => this.app.discardStaleCarry(orphan.tabId),
              true,
              identityPending,
            ),
          );
          item.append(text, actions);
          orphanBox.appendChild(item);
        }
      }

      const decisionBox = this.shadow.getElementById("decisions");
      decisionBox.replaceChildren();
      if (decisions.length) {
        const heading = document.createElement("h3");
        heading.textContent = "Needs a decision";
        decisionBox.appendChild(heading);
        for (const entry of decisions) {
          const item = document.createElement("div");
          item.className = "item";
          const text = document.createElement("p");
          text.textContent = `${entry.status === "uncertain" ? "Uncertain" : "Blocked"}: ${entry.description} (${formatDuration(
            entry.duration * 1000,
          )})`;
          const meta = document.createElement("p");
          meta.className = "meta";
          meta.textContent = entry.lastError;
          const actions = document.createElement("div");
          actions.className = "actions";
          actions.append(
            this.makeAction("Retry", () => this.app.retryEntry(entry.id)),
            this.makeAction("Dismiss", () => this.app.dismissEntry(entry.id), true),
          );
          item.append(text, meta, actions);
          decisionBox.appendChild(item);
        }
      }

      const errorBox = this.shadow.getElementById("errors");
      errorBox.replaceChildren();
      if (errors.length) {
        const heading = document.createElement("h3");
        heading.textContent = "Latest error";
        const text = document.createElement("p");
        text.className = "meta";
        text.textContent = errors[errors.length - 1].message;
        errorBox.append(heading, text);
      }
    }
  }

  class BrowserApp {
    constructor(config = CONFIG) {
      this.config = config;
      this.store = new GMStore();
      this.queue = new SharedQueue(this.store);
      this.worker = new TogglWorker(this.store, this.queue, config);
      const tabIdentity = getOrCreateTabIdentity();
      this.tabId = tabIdentity.tabId;
      this.reusedTabId = tabIdentity.reused;
      this.identityResolved = false;
      this.identityGeneration = 0;
      this.instanceId = randomId("instance");
      this.sample = null;
      this.inactivityDeadline = null;
      this.discontinuityToken = 0;
      this.lastPageUrl = location.href;
      this.operation = Promise.resolve();
      this.status = new StatusControl(this);
      this.intervals = [];
      this.instanceChannel = null;
      this.probeWaiters = new Map();
      this.openInstanceChannel();
      this.openStorageProbeListener();
    }

    openInstanceChannel() {
      if (this.instanceChannel || typeof BroadcastChannel === "undefined") return;
      try {
        this.instanceChannel = new BroadcastChannel("yt-toggl:instances:v1");
      } catch (_error) {
        this.instanceChannel = null;
        return;
      }
      this.instanceChannel.addEventListener("message", (event) => {
        const message = event.data;
        if (!message || typeof message !== "object") return;
        if (
          message.type === "probe" &&
          message.tabId === this.tabId &&
          message.requesterId !== this.instanceId
        ) {
          this.respondToInstanceProbe(message);
        }
        if (message.type === "alive" && message.targetId === this.instanceId) {
          const resolve = this.probeWaiters.get(message.probeId);
          if (resolve) resolve(true);
        }
      });
    }

    closeInstanceChannel() {
      const channel = this.instanceChannel;
      this.instanceChannel = null;
      if (!channel) return;
      try {
        channel.close();
      } catch (_error) {
        // The channel is already unusable.
      }
    }

    resetInstanceChannel() {
      this.closeInstanceChannel();
      this.openInstanceChannel();
    }

    captureIdentity() {
      if (this.identityResolved === false) return null;
      return { tabId: this.tabId, generation: this.identityGeneration };
    }

    identityMatches(identity) {
      return Boolean(
        identity &&
          this.identityResolved !== false &&
          identity.tabId === this.tabId &&
          identity.generation === this.identityGeneration,
      );
    }

    markIdentityResolved(identity) {
      if (
        !identity ||
        identity.tabId !== this.tabId ||
        identity.generation !== this.identityGeneration ||
        this.reusedTabId
      ) {
        return false;
      }
      this.identityResolved = true;
      return true;
    }

    respondToInstanceProbe(message) {
      const response = {
        type: "alive",
        probeId: message.probeId,
        targetId: message.requesterId,
        responderId: this.instanceId,
      };
      if (this.instanceChannel) {
        try {
          this.instanceChannel.postMessage(response);
        } catch (_error) {
          this.resetInstanceChannel();
          try {
            if (this.instanceChannel) this.instanceChannel.postMessage(response);
          } catch (_retryError) {
            this.resetInstanceChannel();
          }
        }
      }
      try {
        this.store.set(INSTANCE_PROBE_KEY, response);
      } catch (_storageError) {
        // The BroadcastChannel response above is sufficient when available.
      }
    }

    openStorageProbeListener() {
      if (typeof GM_addValueChangeListener !== "function") return;
      GM_addValueChangeListener(INSTANCE_PROBE_KEY, (_name, _oldValue, message) => {
        if (!message || typeof message !== "object") return;
        if (
          message.type === "probe" &&
          message.tabId === this.tabId &&
          message.requesterId !== this.instanceId
        ) {
          this.respondToInstanceProbe(message);
        }
        if (message.type === "alive" && message.targetId === this.instanceId) {
          const resolve = this.probeWaiters.get(message.probeId);
          if (resolve) resolve(true);
        }
      });
    }

    async resolveDuplicatedTabId(expectedGeneration = this.identityGeneration) {
      const resolutionGeneration = nonNegativeNumber(expectedGeneration);
      if (nonNegativeNumber(this.identityGeneration) !== resolutionGeneration) return null;
      if (!this.reusedTabId) {
        return { tabId: this.tabId, generation: this.identityGeneration };
      }
      const candidateTabId = this.tabId;
      let resolvedIdentity = null;
      await withCrossTabLock(this.store, `identity:${candidateTabId}`, async () => {
        if (
          nonNegativeNumber(this.identityGeneration) !== resolutionGeneration ||
          !this.reusedTabId ||
          this.tabId !== candidateTabId
        ) {
          return;
        }
        const answers = await Promise.all([
          this.probeTab(candidateTabId),
          this.probeTab(candidateTabId, 750),
        ]);
        if (
          nonNegativeNumber(this.identityGeneration) !== resolutionGeneration ||
          !this.reusedTabId ||
          this.tabId !== candidateTabId
        ) {
          return;
        }
        let answered = false;
        if (answers.some(Boolean)) answered = true;
        else if (answers.every((answer) => answer === null)) answered = null;
        // A definite no-response means this is a reload. If transport itself is
        // unavailable, isolate the page rather than risk two live tabs sharing ID.
        if (answered === false) {
          this.reusedTabId = false;
          resolvedIdentity = {
            tabId: this.tabId,
            generation: this.identityGeneration,
          };
          return;
        }

        this.tabId = randomId("tab");
        this.identityGeneration = resolutionGeneration + 1;
        this.reusedTabId = false;
        this.sample = null;
        this.inactivityDeadline = null;
        try {
          sessionStorage.setItem(TAB_ID_SESSION_KEY, this.tabId);
        } catch (_error) {
          // The in-memory ID still keeps this live duplicate independent.
        }
        resolvedIdentity = {
          tabId: this.tabId,
          generation: this.identityGeneration,
        };
      });
      return resolvedIdentity;
    }

    probeTab(tabId, timeoutMs = 300) {
      const targetTabId = normalizedText(tabId);
      // true: live response; false: sent but unanswered; null: could not send.
      if (!targetTabId) return Promise.resolve(null);
      const probeId = randomId("probe");
      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          this.probeWaiters.delete(probeId);
          resolve(false);
        }, timeoutMs);
        this.probeWaiters.set(probeId, (value) => {
          clearTimeout(timeout);
          this.probeWaiters.delete(probeId);
          resolve(Boolean(value));
        });
        const message = {
          type: "probe",
          probeId,
          tabId: targetTabId,
          requesterId: this.instanceId,
        };
        const sendChannelProbe = () => {
          if (!this.instanceChannel) return false;
          try {
            this.instanceChannel.postMessage(message);
            return true;
          } catch (_error) {
            return false;
          }
        };
        let sent = sendChannelProbe();
        if (this.instanceChannel && !sent) {
          this.resetInstanceChannel();
          sent = sendChannelProbe();
        }
        if (this.instanceChannel && !sent) {
          this.resetInstanceChannel();
        }
        try {
          this.store.set(INSTANCE_PROBE_KEY, message);
          sent = true;
        } catch (_storageError) {
          // A working BroadcastChannel remains sufficient.
        }
        if (!sent) {
          if (this.instanceChannel) this.resetInstanceChannel();
          clearTimeout(timeout);
          this.probeWaiters.delete(probeId);
          resolve(null);
        }
      });
    }

    async probeTabs(tabIds) {
      const probeOnce = async (ids) =>
        Promise.all(ids.map(async (tabId) => [tabId, await this.probeTab(tabId)]));
      const candidates = [...new Set(tabIds)];
      const firstResults = await probeOnce(candidates);
      const live = new Set(
        firstResults.filter(([_tabId, alive]) => alive).map(([tabId]) => tabId),
      );
      const indeterminate = new Set(
        firstResults.filter(([_tabId, alive]) => alive === null).map(([tabId]) => tabId),
      );
      const missed = candidates.filter(
        (tabId) => !live.has(tabId) && !indeterminate.has(tabId),
      );
      if (missed.length) {
        const secondResults = await probeOnce(missed);
        for (const [tabId, alive] of secondResults) {
          if (alive) live.add(tabId);
          else if (alive === null) indeterminate.add(tabId);
        }
      }
      return { live, indeterminate };
    }

    recordNeedsProbe(record, nowMs) {
      if (
        record.tabId === this.tabId ||
        !record.instanceId ||
        nowMs - record.heartbeatMs < TAB_HEARTBEAT_GRACE_MS
      ) {
        return false;
      }
      return Boolean(
        (record.active &&
          nowMs - record.active.lastEligibleAtMs >= inactivityMs(this.config)) ||
          (!record.active &&
            carryDurationMs(record.carry) === 0 &&
            nowMs - record.heartbeatMs >= inactivityMs(this.config)),
      );
    }

    probeSubject(record) {
      return {
        instanceId: record.instanceId,
        heartbeatMs: record.heartbeatMs,
        activeId: record.active ? record.active.id : "",
      };
    }

    probeSubjectMatches(record, subject) {
      return Boolean(
        subject &&
          subject.instanceId === record.instanceId &&
          subject.heartbeatMs === record.heartbeatMs &&
          subject.activeId === (record.active ? record.active.id : ""),
      );
    }

    getOwnRecord() {
      return normalizeTabRecord(
        this.store.get(tabStorageKey(this.tabId), createTabRecord(this.tabId)),
        this.tabId,
      );
    }

    getAllTabRecords() {
      return this.store
        .keys()
        .filter((key) => key.startsWith(TAB_KEY_PREFIX))
        .map((key) => normalizeTabRecord(this.store.get(key, null), tabIdFromStorageKey(key)))
        .filter((record) => record.tabId);
    }

    getStaleCarryRecords(nowMs = Date.now()) {
      const expirationMs = inactivityMs(this.config);
      return this.getAllTabRecords().filter(
        (record) =>
          record.tabId !== this.tabId &&
          !record.active &&
          nowMs - record.heartbeatMs >= expirationMs &&
          carryDurationMs(record.carry) > 0,
      );
    }

    getCarryTransferIssue() {
      return carryTransferIssue(this.store.get(CARRY_TRANSFER_KEY, null));
    }

    withTabsLock(callback) {
      return withCrossTabLock(this.store, "tabs", () => {
        completeCarryTransfer(this.store);
        return callback();
      });
    }

    enqueueOperation(callback) {
      this.operation = this.operation
        .then(callback)
        .catch((error) => {
          this.sample = null;
          appendError(this.store, error && error.message ? error.message : String(error));
        })
        .finally(() => this.status.render());
      return this.operation;
    }

    async addEntriesForIdentity(entries, identity) {
      if (!this.identityMatches(identity)) return false;
      if (!entries.length) return true;
      const existingIds = new Set(this.queue.get().map((entry) => entry.id));
      await this.queue.add(entries);
      if (this.identityMatches(identity)) return true;
      for (const entry of entries) {
        if (!existingIds.has(entry.id)) await this.queue.remove(entry.id);
      }
      return false;
    }

    async commitMachine(machine, entries, nowMs, commandId = "", identity = this.captureIdentity()) {
      if (!(await this.addEntriesForIdentity(entries, identity))) return false;
      if (!this.identityMatches(identity)) return false;
      machine.record.heartbeatMs = nowMs;
      machine.record.instanceId = this.instanceId;
      if (commandId) machine.record.lastCommandId = commandId;
      this.store.set(tabStorageKey(this.tabId), machine.record);
      this.sample = machine.sample;
      this.inactivityDeadline = machine.inactivityDeadline;
      if (entries.length) this.worker.kick();
      return true;
    }

    tick() {
      return this.enqueueOperation(() => {
        const identity = this.captureIdentity();
        if (!identity) return undefined;
        return this.withTabsLock(async () => {
          if (!this.identityMatches(identity)) return;
          const snapshot = discoverMedia(this.discontinuityToken);
          const machine = new SessionMachine(this.config, this.getOwnRecord());
          machine.sample = this.sample;
          machine.inactivityDeadline = this.inactivityDeadline;
          const entries = machine.tick(snapshot);
          await this.commitMachine(machine, entries, snapshot.nowMs, "", identity);
        });
      });
    }

    handleSync(commandId) {
      return this.enqueueOperation(() => {
        const identity = this.captureIdentity();
        if (!identity) return undefined;
        return this.withTabsLock(async () => {
          if (!this.identityMatches(identity)) return;
          const record = this.getOwnRecord();
          if (record.lastCommandId === commandId) return;
          const snapshot = discoverMedia(this.discontinuityToken);
          const machine = new SessionMachine(this.config, record);
          machine.sample = this.sample;
          machine.inactivityDeadline = this.inactivityDeadline;
          const entries = machine.sync(snapshot);
          const committed = await this.commitMachine(
            machine,
            entries,
            snapshot.nowMs,
            commandId,
            identity,
          );
          if (committed) this.worker.kick();
        });
      });
    }

    broadcastSync() {
      const identity = this.captureIdentity();
      if (!identity) return;
      const command = {
        id: randomId("sync"),
        type: "sync",
        fromTabId: identity.tabId,
        atMs: Date.now(),
      };
      this.store.set(COMMAND_KEY, command);
      this.handleSync(command.id);
    }

    async recoverTabs() {
      const identity = this.captureIdentity();
      if (!identity) return;
      const probeAtMs = Date.now();
      const probeSubjects = new Map(
        this.getAllTabRecords()
          .filter((record) => this.recordNeedsProbe(record, probeAtMs))
          .map((record) => [record.tabId, this.probeSubject(record)]),
      );
      const foreignProbe = await this.probeTabs([...probeSubjects.keys()]);
      if (!this.identityMatches(identity)) return;

      await this.withTabsLock(async () => {
        if (!this.identityMatches(identity)) return;
        const nowMs = Date.now();
        const entries = [];
        const updates = [];
        const deletions = [];
        const records = this.getAllTabRecords();
        const freshForeignTabs = new Set(
          records
            .filter(
              (record) =>
                record.tabId !== this.tabId &&
                nowMs - record.heartbeatMs < TAB_HEARTBEAT_GRACE_MS,
            )
            .map((record) => record.tabId),
        );

        for (const record of records) {
          const liveOwnSession = Boolean(
            record.tabId === this.tabId &&
              record.active &&
              this.inactivityDeadline &&
              this.inactivityDeadline.sessionId === record.active.id,
          );
          const needsProbe = this.recordNeedsProbe(record, nowMs);
          const deferUnverifiedRecord =
            needsProbe && !this.probeSubjectMatches(record, probeSubjects.get(record.tabId));
          const recordIsLive =
            liveOwnSession ||
            freshForeignTabs.has(record.tabId) ||
            foreignProbe.live.has(record.tabId) ||
            // Failed transport cannot establish that destructive recovery is safe.
            foreignProbe.indeterminate.has(record.tabId) ||
            // The in-lock record is authoritative. Defer anything that became
            // probe-eligible or changed ownership while probes were in flight.
            deferUnverifiedRecord;
          const result = recordIsLive
            ? { record, entry: null, disposition: "unchanged" }
            : recoverExpiredRecord(record, nowMs, this.config, makeDescription);
          if (result.entry) entries.push(result.entry);
          if (result.disposition !== "unchanged") {
            // Keep the old heartbeat so recovered carry remains visibly stale.
            result.record.heartbeatMs = record.heartbeatMs;
          }
          const nextRecord = result.disposition === "unchanged" ? record : result.record;
          if (!recordIsLive && tabRecordIsPrunable(nextRecord, this.tabId, nowMs, this.config)) {
            deletions.push(nextRecord.tabId);
          } else if (result.disposition !== "unchanged") {
            updates.push(nextRecord);
          }
        }
        // Queue first. Deterministic entry IDs make a retry harmless if the
        // page closes before the corresponding tab-record updates complete.
        if (!(await this.addEntriesForIdentity(entries, identity))) return;
        if (!this.identityMatches(identity)) return;
        for (const record of updates) this.store.set(tabStorageKey(record.tabId), record);
        for (const tabId of deletions) this.store.delete(tabStorageKey(tabId));

        const own = this.getOwnRecord();
        own.heartbeatMs = nowMs;
        own.instanceId = this.instanceId;
        this.store.set(tabStorageKey(this.tabId), own);
      });
    }

    attachStaleCarry(sourceTabId) {
      const identity = this.captureIdentity();
      if (!identity) return;
      return this.enqueueOperation(() => {
        if (!this.identityMatches(identity)) return undefined;
        return this.withTabsLock(() => {
          if (!this.identityMatches(identity)) return;
          const nowMs = Date.now();
          const source = normalizeTabRecord(
            this.store.get(tabStorageKey(sourceTabId), createTabRecord(sourceTabId)),
            sourceTabId,
            nowMs,
          );
          if (nowMs - source.heartbeatMs < inactivityMs(this.config)) {
            throw new Error("That tab is active again; its carry was not attached.");
          }
          if (source.active) {
            throw new Error("That tab's expired session is still being recovered; try again shortly.");
          }
          const transfer = createCarryTransfer(source, identity.tabId, this.instanceId, nowMs);
          if (transfer) {
            const result = beginCarryTransfer(this.store, transfer);
            if (result && tabRecordIsPrunable(result.source, identity.tabId, nowMs, this.config)) {
              this.store.delete(tabStorageKey(result.source.tabId));
            }
          }
        });
      });
    }

    discardStaleCarry(sourceTabId) {
      const identity = this.captureIdentity();
      if (!identity) return;
      if (!window.confirm("Permanently discard this stale tab's carried watch time?")) return;
      return this.enqueueOperation(() => {
        if (!this.identityMatches(identity)) return undefined;
        return this.withTabsLock(() => {
          if (!this.identityMatches(identity)) return;
          const nowMs = Date.now();
          const source = normalizeTabRecord(
            this.store.get(tabStorageKey(sourceTabId), createTabRecord(sourceTabId)),
            sourceTabId,
            nowMs,
          );
          if (nowMs - source.heartbeatMs < inactivityMs(this.config)) {
            throw new Error("That tab is active again; its carry was not discarded.");
          }
          if (source.active) {
            throw new Error("That tab's expired session is still being recovered; try again shortly.");
          }
          this.store.delete(tabStorageKey(sourceTabId));
        });
      });
    }

    discardCurrentCarry() {
      const identity = this.captureIdentity();
      if (!identity) return;
      if (!window.confirm("Permanently discard this tab's carried watch time?")) return;
      return this.enqueueOperation(() => {
        if (!this.identityMatches(identity)) return undefined;
        return this.withTabsLock(() => {
          if (!this.identityMatches(identity)) return;
          const next = discardCarry(this.getOwnRecord());
          next.heartbeatMs = Date.now();
          next.instanceId = this.instanceId;
          this.store.set(tabStorageKey(identity.tabId), next);
        });
      });
    }

    discardUnreadableCarryTransfer(fingerprint) {
      const identity = this.captureIdentity();
      if (!identity) return;
      if (
        !window.confirm(
          "Discard only the unreadable carry-transfer journal? Existing tab carry will be preserved, but ownership may remain ambiguous.",
        )
      ) {
        return;
      }
      return this.enqueueOperation(() => {
        if (!this.identityMatches(identity)) return undefined;
        return this.withTabsLock(() => {
          if (!this.identityMatches(identity)) return;
          return discardCarryTransferJournal(this.store, fingerprint);
        });
      });
    }

    retryEntry(entryId) {
      return this.enqueueOperation(async () => {
        await this.queue.update(entryId, (entry) => ({
          status: "pending",
          nextAttemptAtMs: 0,
          sendingSinceMs: 0,
          lastError: "",
        }));
        this.store.delete(AUTH_BLOCK_KEY);
        this.worker.kick();
      });
    }

    dismissEntry(entryId) {
      if (!window.confirm("Dismiss this unsent entry? This cannot be undone by the userscript.")) return;
      return this.enqueueOperation(() => this.queue.remove(entryId));
    }

    bindEvents() {
      const mediaEvents = [
        "play",
        "playing",
        "canplay",
        "pause",
        "waiting",
        "stalled",
        "seeking",
        "seeked",
        "ratechange",
        "ended",
        "loadedmetadata",
      ];
      for (const eventName of mediaEvents) {
        document.addEventListener(
          eventName,
          (event) => {
            if (!event.target || event.target.tagName !== "VIDEO") return;
            if (eventName === "seeking") this.discontinuityToken += 1;
            this.tick();
          },
          true,
        );
      }

      const navigationHandler = () => {
        if (location.href !== this.lastPageUrl) {
          this.lastPageUrl = location.href;
          this.discontinuityToken += 1;
        }
        this.tick();
        setTimeout(() => this.tick(), 250);
        setTimeout(() => this.tick(), 1000);
      };
      document.addEventListener("yt-navigate-finish", navigationHandler, true);
      document.addEventListener("yt-page-data-updated", navigationHandler, true);

      GM_addValueChangeListener(COMMAND_KEY, (_name, _oldValue, command, remote) => {
        if (remote && command && command.type === "sync" && command.id) this.handleSync(command.id);
      });
      GM_addValueChangeListener(QUEUE_KEY, () => {
        this.status.render();
        this.worker.kick();
      });

      window.addEventListener("pagehide", () => {
        this.closeInstanceChannel();
      });
      window.addEventListener("pageshow", (event) => {
        if (!event.persisted) return;
        this.openInstanceChannel();
        this.reusedTabId = true;
        this.identityGeneration = nonNegativeNumber(this.identityGeneration) + 1;
        const restoreGeneration = this.identityGeneration;
        this.identityResolved = false;
        this.status.render();
        this.enqueueOperation(async () => {
          const identity = await this.resolveDuplicatedTabId(restoreGeneration);
          this.markIdentityResolved(identity);
        });
        this.tick();
      });
    }

    async start() {
      this.status.mount();
      const identity = await this.resolveDuplicatedTabId(this.identityGeneration);
      if (!this.markIdentityResolved(identity)) return;
      this.status.render();
      await this.recoverTabs();
      this.bindEvents();
      await this.tick();
      this.worker.kick();
      this.intervals.push(setInterval(() => this.tick(), TICK_INTERVAL_MS));
      this.intervals.push(
        setInterval(
          () =>
            this.enqueueOperation(async () => {
              await this.recoverTabs();
              this.worker.kick();
            }),
          WORKER_INTERVAL_MS,
        ),
      );
    }
  }

  const API = {
    CONFIG,
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
    discoverMedia,
    encodeBasicAuth,
    enqueueUnique,
    finalizeTabRecord,
    formatDuration,
    inactivityMs,
    makeDescription,
    markInterruptedRequestsUncertain,
    minimumDurationMs,
    normalizeCarry,
    normalizeCarryTransfer,
    normalizeQueue,
    normalizeSnapshot,
    normalizeTabRecord,
    parseResponseHeaders,
    playedRangeCovers,
    recoverExpiredRecord,
    requestSpacingDelay,
    rollingAttemptWindow,
    selectActiveVideo,
    tabRecordIsPrunable,
    validatedPlaybackMs,
    validateConfig,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = API;

  if (
    typeof window !== "undefined" &&
    typeof document !== "undefined" &&
    typeof GM_getValue === "function" &&
    isTopLevelBrowsingContext()
  ) {
    const app = new BrowserApp(CONFIG);
    app.start().catch((error) => {
      try {
        appendError(app.store, error && error.message ? error.message : String(error), "startup");
      } catch (_storageError) {
        console.error("yt-toggl failed to start", error);
      }
    });
  }
})();
