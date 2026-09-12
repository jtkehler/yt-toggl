// ==UserScript==
// @name         YouTube Watch Time → Toggl
// @namespace    https://github.com/local/yt-toggl
// @version      2.0.0
// @description  Track eligible YouTube playback locally and create completed Toggl entries.
// @author       You
// @match        https://www.youtube.com/*
// @noframes
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
  const ONE_HOUR_MS = 3600000;
  const REQUEST_SPACING_MS = 1000;
  const DEFAULT_RATE_BACKOFF_MS = 120000;
  const REQUEST_TIMEOUT_MS = 30000;
  const TICK_INTERVAL_MS = 1000;
  const WORKER_INTERVAL_MS = 30000;

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

  function normalizeSnapshot(snapshot) {
    const input = snapshot && typeof snapshot === "object" ? snapshot : {};
    const nowMs = nonNegativeNumber(input.nowMs, Date.now());
    return {
      nowMs,
      monotonicMs: nonNegativeNumber(input.monotonicMs, nowMs),
      eligible: Boolean(input.eligible),
      progressAllowed: Boolean(input.progressAllowed),
      channel: normalizeChannel(input.channel),
      mediaKey: normalizedText(input.mediaKey || input.videoId),
      videoId: normalizedText(input.videoId || input.mediaKey),
      title: normalizedText(input.title),
      mediaTime: finiteNumber(input.mediaTime),
      playbackRate: finiteNumber(input.playbackRate, 1),
      playedRanges: Array.isArray(input.playedRanges) ? clone(input.playedRanges) : [],
      discontinuityToken: finiteNumber(input.discontinuityToken),
    };
  }

  // A sampler owns only its baseline. Persisted credit belongs to the video ledger.
  class PlaybackRecorder {
    constructor(config = CONFIG, { idFactory = randomId } = {}) {
      this.config = config;
      this.idFactory = idFactory;
      this.reset();
    }

    reset() {
      this.sample = null;
      this.record = null;
      this.creditedMs = 0;
      this.isTracking = false;
      this.lastProgressMonotonicMs = null;
    }

    observe(rawSnapshot) {
      const snapshot = normalizeSnapshot(rawSnapshot);
      const previous = this.sample;
      const sameVideo = this.record && this.record.videoId === snapshot.mediaKey &&
        channelsEqual(this.record.channel, snapshot.channel);
      const credit = sameVideo ? validatedPlaybackMs(previous, snapshot) : 0;
      const intervalStartMs = Math.max(0, snapshot.nowMs - credit);
      const expiration = inactivityMs(this.config);
      const expired = sameVideo && credit > 0 && this.record.durationMs > 0 && (
        intervalStartMs - this.record.lastEligibleAtMs >= expiration ||
        snapshot.monotonicMs - credit - this.lastProgressMonotonicMs >= expiration
      );
      if (!sameVideo || expired) {
        this.record = snapshot.channel && snapshot.mediaKey && (snapshot.eligible || credit > 0) ? {
          id: this.idFactory("viewing"), videoId: snapshot.mediaKey, title: snapshot.title,
          channel: snapshot.channel, firstPlayMs: intervalStartMs,
          lastEligibleAtMs: snapshot.nowMs, durationMs: 0, intervalStartMs,
        } : null;
      }
      let checkpoint = null;
      if (credit > 0 && this.record) {
        if (this.record.durationMs === 0) this.record.firstPlayMs = intervalStartMs;
        this.record.durationMs += credit;
        this.record.intervalStartMs = intervalStartMs;
        this.record.lastEligibleAtMs = snapshot.nowMs;
        this.record.title = snapshot.title || this.record.title;
        this.record.channel = mergeChannel(this.record.channel, snapshot.channel);
        this.lastProgressMonotonicMs = snapshot.monotonicMs;
        checkpoint = clone(this.record);
      }
      // Events can repeat the exact sample; retain the indicator only until the
      // next actual observation interval proves a stall or ineligible state.
      const repeated = previous && previous.monotonicMs === snapshot.monotonicMs &&
        previous.mediaKey === snapshot.mediaKey;
      this.isTracking = Boolean(snapshot.eligible && (credit > 0 || (repeated && this.isTracking)));
      this.creditedMs = credit;
      this.sample = snapshot.channel && snapshot.mediaKey ? snapshot : null;
      return { checkpoint, creditedMs: credit };
    }
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
    if (typeof config.mergeBelowMinimum !== "boolean") errors.push("CONFIG.mergeBelowMinimum must be a boolean.");
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
      workspace_id: Number(entry.workspaceId),
      created_with: SCRIPT_ID,
      description: entry.description,
      start: entry.start,
      duration: Math.max(1, Math.round(finiteNumber(entry.duration))),
    };
    if (entry.projectId !== null) body.project_id = Number(entry.projectId);
    return {
      url: `https://api.track.toggl.com/api/v9/workspaces/${Number(entry.workspaceId)}/time_entries`,
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
      .filter((value) => value > nowMs - ONE_HOUR_MS)
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
        title: initialDetails.title || identifiedPlayerData.title || "",
        video_id: expectedVideoId,
      };
    }

    // Only identified content metadata can supply the authoritative channel ID.
    // Generic page links and stale owner DOM must not relabel another video.
    const contentChannel = channelFromVideoData(videoData);
    if (!expectedVideoId) return neutralSnapshot();
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
      videoId: expectedVideoId,
      title: normalizedText(videoData.title || initialDetails.title),
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


  // Every mutation reads and writes in one transaction, including prefix allocation.
  class VideoLedger {
    constructor({ indexedDB = globalThis.indexedDB, name = "yt-toggl-video-ledger-v2" } = {}) {
      this.indexedDB = indexedDB;
      this.name = name;
      this.db = null;
      this.openPromise = null;
    }

    open() {
      if (this.db) return Promise.resolve(this);
      if (this.openPromise) return this.openPromise;
      this.openPromise = new Promise((resolve, reject) => {
        if (!this.indexedDB || typeof this.indexedDB.open !== "function") {
          reject(new Error("IndexedDB is unavailable. Allow YouTube site storage to record playback."));
          return;
        }
        const request = this.indexedDB.open(this.name, 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          for (const name of ["records", "batches", "meta"]) {
            if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: "id" });
          }
        };
        request.onerror = () => reject(new Error(`Cannot open playback storage: ${request.error?.message || "IndexedDB failed"}`));
        request.onblocked = () => reject(new Error("Playback storage upgrade is blocked. Close other YouTube tabs and reload."));
        request.onsuccess = () => {
          this.db = request.result;
          this.db.onversionchange = () => { this.db.close(); this.db = null; this.openPromise = null; };
          resolve(this);
        };
      }).catch((error) => { this.openPromise = null; throw error; });
      return this.openPromise;
    }

    async transaction(mode, operation, readStores = ["records", "batches", "meta"]) {
      await this.open();
      return new Promise((resolve, reject) => {
        const tx = this.db.transaction(["records", "batches", "meta"], mode);
        const stores = Object.fromEntries(["records", "batches", "meta"].map((name) => [name, tx.objectStore(name)]));
        const state = { records: [], batches: [], meta: [] };
        let remaining = readStores.length; let result; let operationError;
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(operationError || tx.error || new Error("Playback storage transaction failed."));
        tx.onabort = () => reject(operationError || tx.error || new Error("Playback storage transaction aborted."));
        for (const name of readStores) {
          const request = stores[name].getAll();
          request.onsuccess = () => {
            state[name] = request.result;
            if (--remaining !== 0) return;
            try { result = operation(state, stores); }
            catch (error) { operationError = error; tx.abort(); }
          };
        }
      });
    }

    groups(records) {
      // Fully consumed history must not extend live inactivity or make current
      // name-only attribution ambiguous merely because a former channel shared it.
      records = records.filter((record) => record.durationMs > record.consumedMs);
      const groups = [];
      // Stable IDs define groups first; a name-only record joins only an unambiguous ID.
      for (const record of records.filter((item) => item.channel.id)) {
        let group = groups.find((item) => item.channel.id === record.channel.id);
        if (!group) { group = { channel: clone(record.channel), records: [] }; groups.push(group); }
        group.records.push(record);
      }
      for (const record of records.filter((item) => !item.channel.id)) {
        const matches = groups.filter((item) => channelsEqual(item.channel, record.channel));
        let group = matches.length === 1 ? matches[0] : groups.find((item) => !item.channel.id && channelsEqual(item.channel, record.channel));
        if (!group) { group = { channel: clone(record.channel), records: [] }; groups.push(group); }
        group.records.push(record);
      }
      return groups.map((group) => {
        const pending = group.records.filter((record) => record.durationMs > record.consumedMs);
        return { ...group, pending,
          durationMs: pending.reduce((total, record) => total + record.durationMs - record.consumedMs, 0),
          firstPlayMs: pending.length ? Math.min(...pending.map((record) => record.pendingStartMs)) : null,
          lastEligibleAtMs: Math.max(...group.records.map((record) => record.lastEligibleAtMs)),
        };
      });
    }

    allocate(group, config, nowMs, stores) {
      if (group.durationMs <= 0) return null;
      const belowMinimum = group.durationMs < minimumDurationMs(config) || Math.round(group.durationMs / 1000) < 1;
      if (belowMinimum && config.mergeBelowMinimum) return null;
      // Capture works before setup; freeze a destination only once it is usable.
      if (!belowMinimum && (!Number.isInteger(Number(config.togglWorkspaceId)) || Number(config.togglWorkspaceId) <= 0 ||
          (config.togglProjectId !== null && (!Number.isInteger(Number(config.togglProjectId)) || Number(config.togglProjectId) <= 0)))) return null;
      const sources = group.pending.map((record) => ({ recordId: record.id, fromMs: record.consumedMs,
        toMs: record.durationMs, durationMs: record.durationMs - record.consumedMs, startMs: record.pendingStartMs }));
      for (const record of group.pending) {
        record.consumedMs = record.durationMs;
        record.pendingStartMs = null;
        stores.records.put(record);
      }
      if (belowMinimum) return null;
      const batch = { id: randomId("batch"), channel: clone(group.channel),
        description: typeof makeDescription === "function" ? makeDescription(clone(group.channel)) : group.channel.name || group.channel.id || "YouTube",
        start: new Date(group.firstPlayMs).toISOString(), duration: Math.round(group.durationMs / 1000),
        durationMs: group.durationMs, workspaceId: Number(config.togglWorkspaceId),
        projectId: config.togglProjectId === null ? null : Number(config.togglProjectId),
        sources, createdAtMs: nowMs, status: "pending", nextAttemptAtMs: 0, message: "" };
      stores.batches.add(batch);
      return batch;
    }

    async record(checkpoint, config = CONFIG, timeContext = null) {
      if (!checkpoint || !normalizedText(checkpoint.id) || !normalizedText(checkpoint.videoId) || !normalizeChannel(checkpoint.channel)) {
        throw new Error("Playback checkpoint requires a record ID, video ID, and channel.");
      }
      for (const key of ["durationMs", "firstPlayMs", "lastEligibleAtMs", "intervalStartMs"]) {
        if (!Number.isFinite(checkpoint[key]) || checkpoint[key] < 0) throw new Error(`Invalid playback checkpoint ${key}.`);
      }
      return this.transaction("readwrite", (state, stores) => {
        let activityEndMs = checkpoint.lastEligibleAtMs;
        let activityStartMs = checkpoint.intervalStartMs;
        let observedNowMs = checkpoint.intervalStartMs;
        if (timeContext !== null) {
          const context = timeContext();
          if (!context || !Number.isFinite(context.nowMs) || context.nowMs < 0 ||
              !Number.isFinite(context.ageMs) || context.ageMs < 0) {
            throw new Error("Invalid trusted playback checkpoint clock context.");
          }
          this.shiftClock(state, stores, context.nowMs);
          activityEndMs = context.nowMs - context.ageMs;
          activityStartMs = activityEndMs - (checkpoint.lastEligibleAtMs - checkpoint.intervalStartMs);
          observedNowMs = context.nowMs;
        }
        let record = state.records.find((item) => item.id === checkpoint.id);
        if (record && (record.videoId !== checkpoint.videoId || !channelsEqual(record.channel, checkpoint.channel))) {
          throw new Error("A viewing record cannot change video or channel identity.");
        }
        if (record && checkpoint.durationMs <= record.durationMs) return [];
        const created = [];
        const matches = this.groups(state.records).filter((group) => channelsEqual(group.channel, checkpoint.channel));
        const previous = checkpoint.channel.id
          ? matches.find((group) => group.channel.id === checkpoint.channel.id) || (matches.length === 1 ? matches[0] : null)
          : matches.length === 1 ? matches[0] : null;
        if (previous && activityStartMs >= previous.lastEligibleAtMs + inactivityMs(config)) {
          const batch = this.allocate(previous, config, observedNowMs, stores);
          if (batch) created.push(batch);
        }
        if (!record) {
          record = { id: checkpoint.id, videoId: checkpoint.videoId, title: normalizedText(checkpoint.title),
            channel: normalizeChannel(checkpoint.channel), firstPlayMs: checkpoint.firstPlayMs,
            durationMs: 0, consumedMs: 0, pendingStartMs: checkpoint.firstPlayMs,
            lastEligibleAtMs: activityEndMs };
        } else if (record.durationMs === record.consumedMs) {
          record.pendingStartMs = checkpoint.intervalStartMs;
        }
        record.durationMs = checkpoint.durationMs;
        // A larger cumulative total is the newer checkpoint even after a wall
        // clock rollback; smaller/equal checkpoints were rejected above.
        record.lastEligibleAtMs = activityEndMs;
        // Identity and original first play stay fixed; display metadata may improve.
        const observedChannel = normalizeChannel(checkpoint.channel);
        record.channel = { id: record.channel.id || observedChannel.id,
          name: observedChannel.name || record.channel.name };
        record.title = normalizedText(checkpoint.title) || record.title;
        stores.records.put(record);
        return created;
      }, ["records", "meta"]);
    }

    finalize(config = CONFIG, { nowMs = Date.now(), force = false } = {}) {
      return this.transaction("readwrite", (state, stores) => {
        const trustedClock = typeof nowMs === "function";
        const observedNowMs = trustedClock ? nowMs() : nowMs;
        if (trustedClock) this.shiftClock(state, stores, observedNowMs);
        const created = [];
        for (const group of this.groups(state.records)) {
          if (!force && observedNowMs < group.lastEligibleAtMs + inactivityMs(config)) continue;
          const batch = this.allocate(group, config, observedNowMs, stores);
          if (batch) created.push(batch);
        }
        return created;
      }, ["records", "meta"]);
    }

    observeClock(nowValue = () => Date.now()) {
      return this.transaction("readwrite", (state, stores) => {
        // Read the trusted browser wall clock inside the serialized transaction,
        // never from a delayed playback checkpoint or a pre-lock observation.
        const wallMs = typeof nowValue === "function" ? nowValue() : nowValue;
        return this.shiftClock(state, stores, wallMs);
      }, ["records", "meta"]);
    }

    shiftClock(state, stores, wallMs) {
      if (!Number.isFinite(wallMs) || wallMs < 0) throw new Error("Invalid browser wall clock.");
      let clock = state.meta.find((item) => item.id === "clock");
      const deltaMs = clock && wallMs < clock.wallMs ? wallMs - clock.wallMs : 0;
      if (deltaMs < 0) {
        for (const record of state.records) {
          if (record.durationMs <= record.consumedMs) continue;
          record.lastEligibleAtMs += deltaMs;
          stores.records.put(record);
        }
      }
      if (!clock) { clock = { id: "clock" }; state.meta.push(clock); }
      clock.wallMs = wallMs;
      stores.meta.put(clock);
      return deltaMs;
    }

    snapshot() {
      return this.transaction("readonly", (state) => ({ ...state,
        pendingChannels: this.groups(state.records).filter((group) => group.durationMs > 0).map((group) => ({
          channel: group.channel, durationMs: group.durationMs, firstPlayMs: group.firstPlayMs,
          lastEligibleAtMs: group.lastEligibleAtMs,
        })),
      }));
    }

    retry(id) {
      return this.transaction("readwrite", (state, stores) => {
        const batch = state.batches.find((item) => item.id === id);
        if (!batch || !["uncertain", "blocked"].includes(batch.status)) return false;
        batch.status = "pending"; batch.message = ""; batch.nextAttemptAtMs = 0;
        stores.batches.put(batch);
        const worker = state.meta.find((item) => item.id === "worker");
        if (worker) { worker.authBlocked = false; stores.meta.put(worker); }
        return true;
      });
    }

    dismiss(id) {
      return this.transaction("readwrite", (state, stores) => {
        const batch = state.batches.find((item) => item.id === id);
        if (!batch || !["pending", "uncertain", "blocked"].includes(batch.status)) return false;
        const wasBlocked = batch.status === "blocked";
        batch.status = "dismissed"; batch.message = ""; stores.batches.put(batch);
        const worker = state.meta.find((item) => item.id === "worker");
        if (wasBlocked && worker) { worker.authBlocked = false; stores.meta.put(worker); }
        return true;
      });
    }

    // Only the holder of the network Web Lock calls recovery, claim, and complete.
    recoverSending() {
      return this.transaction("readwrite", (state, stores) => {
        let count = 0;
        for (const batch of state.batches) {
          if (batch.status !== "sending") continue;
          batch.status = "uncertain";
          batch.message = "Toggl create was interrupted. Check Toggl before explicitly retrying.";
          stores.batches.put(batch); count += 1;
        }
        return count;
      });
    }

    claim(config = CONFIG, nowValue = Date.now()) {
      return this.transaction("readwrite", (state, stores) => {
        const nowMs = typeof nowValue === "function" ? nowValue() : nowValue;
        const worker = state.meta.find((item) => item.id === "worker") || { id: "worker", attempts: [], quotaUntilMs: 0, lastCompletedAtMs: null };
        if (worker.authBlocked) return { blocked: true };
        // Future attempts stay counted when the wall clock moves backwards.
        worker.attempts = worker.attempts.filter((time) => Number.isFinite(time) && time > nowMs - ONE_HOUR_MS).sort((a, b) => a - b);
        const pending = state.batches.filter((batch) => batch.status === "pending").sort((a, b) => a.createdAtMs - b.createdAtMs || a.id.localeCompare(b.id));
        if (!pending.length) return {};
        const limit = Math.max(1, Math.floor(finiteNumber(config.maxRequestsPerHour, 30)));
        let waitUntilMs = Math.max(worker.quotaUntilMs || 0,
          worker.lastCompletedAtMs === null ? 0 : worker.lastCompletedAtMs + REQUEST_SPACING_MS);
        if (worker.attempts.length >= limit) waitUntilMs = Math.max(waitUntilMs, worker.attempts[worker.attempts.length - limit] + ONE_HOUR_MS);
        const batch = pending.find((item) => (item.nextAttemptAtMs || 0) <= nowMs);
        if (!batch) waitUntilMs = Math.max(waitUntilMs, Math.min(...pending.map((item) => item.nextAttemptAtMs)));
        if (waitUntilMs > nowMs || !batch) return { waitUntilMs };
        batch.status = "sending"; batch.claimedAtMs = nowMs; batch.message = "";
        worker.attempts.push(nowMs);
        stores.batches.put(batch); stores.meta.put(worker);
        return { batch };
      });
    }

    complete(id, outcome, nowMs = Date.now()) {
      return this.transaction("readwrite", (state, stores) => {
        const batch = state.batches.find((item) => item.id === id);
        if (!batch || batch.status !== "sending") return null;
        const result = classifyAttempt(outcome, nowMs);
        batch.status = result.status; batch.message = result.message; batch.nextAttemptAtMs = result.nextAttemptAtMs;
        batch.completedAtMs = nowMs;
        if (result.status === "sent") {
          try { batch.togglId = JSON.parse(outcome.responseText).id || null; } catch (_error) { batch.togglId = null; }
        }
        const worker = state.meta.find((item) => item.id === "worker") || { id: "worker", attempts: [], quotaUntilMs: 0 };
        worker.lastCompletedAtMs = Math.max(worker.lastCompletedAtMs || 0, nowMs);
        worker.quotaUntilMs = Math.max(worker.quotaUntilMs || 0, result.quotaUntilMs || 0);
        if (result.authFailure) worker.authBlocked = true;
        stores.batches.put(batch); stores.meta.put(worker);
        return result;
      });
    }

    markAttempt(id, nowValue = Date.now()) {
      return this.transaction("readwrite", (state, stores) => {
        const batch = state.batches.find((item) => item.id === id);
        if (!batch || batch.status !== "sending") return false;
        const nowMs = typeof nowValue === "function" ? nowValue() : nowValue;
        const worker = state.meta.find((item) => item.id === "worker");
        if (!worker) throw new Error("Sending batch has no durable request reservation.");
        const index = worker.attempts.lastIndexOf(batch.claimedAtMs);
        if (index < 0) throw new Error("Sending batch request reservation is missing.");
        // Refresh the reservation after the awaited claim and retain future values.
        worker.attempts[index] = Math.max(worker.attempts[index], nowMs);
        batch.attemptedAtMs = nowMs;
        stores.meta.put(worker); stores.batches.put(batch);
        return true;
      });
    }
  }

  class TogglWorker {
    constructor(ledger, config = CONFIG, options = {}) {
      this.ledger = ledger; this.config = config;
      this.locks = Object.prototype.hasOwnProperty.call(options, "locks") ? options.locks : globalThis.navigator?.locks;
      this.now = options.now || (() => Date.now());
      this.sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
      this.send = options.send || postTogglEntry;
      this.hasSend = Boolean(options.send) || typeof GM_xmlhttpRequest === "function";
      this.kickPromise = null; this.capabilityError = "";
    }

    kick() {
      if (this.kickPromise) return this.kickPromise;
      this.kickPromise = this.drain().finally(() => { this.kickPromise = null; });
      return this.kickPromise;
    }

    async drain() {
      if (!this.locks || typeof this.locks.request !== "function") {
        this.capabilityError = "Toggl delivery needs Web Locks. Use a supported browser on https://www.youtube.com; playback remains stored locally.";
        return;
      }
      if (!this.hasSend) {
        this.capabilityError = "Toggl delivery needs Violentmonkey GM_xmlhttpRequest permission. Reinstall or enable the userscript; playback remains stored locally.";
        return;
      }
      const configErrors = validateConfig(this.config);
      if (configErrors.length) { this.capabilityError = configErrors.join(" "); return; }
      this.capabilityError = "";
      return this.locks.request(`${SCRIPT_ID}:video-ledger-delivery:v2`, async () => {
        await this.ledger.recoverSending();
        while (true) {
          const claim = await this.ledger.claim(this.config, this.now);
          if (!claim.batch) {
            const wait = (claim.waitUntilMs || 0) - this.now();
            // Long quota waits are picked up by the normal periodic worker tick.
            if (wait > 0 && wait <= REQUEST_SPACING_MS) { await this.sleep(wait); continue; }
            return;
          }
          const batch = claim.batch;
          const destination = { ...this.config, togglWorkspaceId: batch.workspaceId, togglProjectId: batch.projectId };
          if (!await this.ledger.markAttempt(batch.id, this.now)) return;
          let outcome;
          try { outcome = await this.send(clone(batch), destination); }
          catch (_error) { outcome = { type: "interrupted request" }; }
          const result = await this.ledger.complete(batch.id, outcome, this.now());
          if (!result || result.stopWorker) return;
        }
      });
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

  const SVG_NS = "http://www.w3.org/2000/svg";

  // YouTube rebuilds its masthead across sign-in and layout changes, so the
  // button is placed by selector on every render rather than mounted once.
  const MASTHEAD_SLOTS = [
    "ytd-masthead #end #buttons",
    "ytd-masthead #buttons",
    "#masthead #end #buttons",
    "ytd-masthead #end",
    "#masthead-container #end",
  ];

  const PALETTE = `
    --ink: #0c0b0e;
    --surface: #17151b;
    --raised: #201c28;
    --line: #2a2632;
    --edge: #3a3446;
    --text: #edeaf2;
    --muted: #948ea3;
    --accent: #e57cd8;
    --warn: #f2a65a;
    --danger: #ff6b5e;
    --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Ubuntu, Cantarell, Helvetica, sans-serif;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", "Cascadia Mono", "Roboto Mono", Menlo, Consolas, monospace;
  `;

  const BUTTON_CSS = `
    :host { all: initial; ${PALETTE} --icon: #f1f1f1;
      display: inline-flex; align-items: center; flex: 0 0 auto; }
    :host([data-theme="light"]) { --icon: #0f0f0f; }
    * { box-sizing: border-box; }
    #summary { position: relative; display: inline-flex; align-items: center; justify-content: center;
      width: 40px; height: 40px; padding: 0; border: 0; border-radius: 50%;
      background: transparent; color: var(--icon); cursor: pointer;
      -webkit-tap-highlight-color: transparent; }
    #summary:hover { background: rgba(255,255,255,0.1); }
    :host([data-theme="light"]) #summary:hover { background: rgba(0,0,0,0.06); }
    #summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    :host([data-placement="floating"]) #summary { position: fixed; right: 16px; bottom: 16px;
      z-index: 2147483646; background: var(--ink); color: var(--text);
      border: 1px solid var(--line); box-shadow: 0 2px 14px #0009; }
    :host([data-placement="floating"]) #summary:hover { background: var(--raised); }
    #icon { display: block; width: 24px; height: 24px; }
    #ring, #stem { fill: none; stroke: currentColor; stroke-width: 1.7;
      stroke-linecap: round; stroke-linejoin: round; }
    #play { fill: currentColor; }
    #summary[data-state="tracking"] #ring,
    #summary[data-state="tracking"] #stem,
    #summary[data-state="paused"] #ring,
    #summary[data-state="paused"] #stem { stroke: var(--accent); }
    /* A held session keeps the accent so the open session stays visible, but
       only accruing playback breathes. */
    #summary[data-state="paused"] #play { fill: var(--muted); }
    #summary[data-state="tracking"] #icon { animation: breathe 2.4s ease-in-out infinite; }
    @keyframes breathe { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
    #attention { position: absolute; top: 6px; right: 6px; width: 7px; height: 7px;
      border-radius: 50%; background: var(--warn); box-shadow: 0 0 0 2px var(--ink); }
    :host([data-theme="light"]) #attention { box-shadow: 0 0 0 2px #fff; }
    #summary[data-attention="0"] #attention { display: none; }
    @media (prefers-reduced-motion: reduce) {
      #summary[data-state="tracking"] #icon { animation: none; }
    }
  `;

  const PANEL_CSS = `
    :host { all: initial; ${PALETTE} }
    * { box-sizing: border-box; }
    #panel { position: fixed; z-index: 2147483647; top: 64px; right: 16px;
      width: min(360px, calc(100vw - 24px)); max-height: min(72vh, 640px); overflow: auto;
      padding: 16px 16px 15px; border: 1px solid var(--line); border-radius: 12px;
      background: var(--ink); color: var(--text); font: 13px/1.45 var(--sans);
      box-shadow: 0 18px 48px #000b, 0 2px 8px #0007;
      scrollbar-width: thin; scrollbar-color: var(--edge) transparent;
      animation: rise 140ms cubic-bezier(0.2, 0.7, 0.3, 1); }
    #panel::-webkit-scrollbar { width: 8px; }
    #panel::-webkit-scrollbar-thumb { border-radius: 4px; background: var(--edge); }
    #panel::-webkit-scrollbar-track { background: transparent; }
    #panel[hidden] { display: none; }
    #panel:focus { outline: none; }
    @keyframes rise { from { opacity: 0; transform: translateY(-4px); } }
    .eyebrow { margin: 0; font: 10px/1 var(--mono); letter-spacing: 0.12em;
      text-transform: uppercase; color: var(--muted); }
    #readout { margin: 9px 0 3px; font: 30px/1 var(--mono); letter-spacing: -0.01em;
      font-variant-numeric: tabular-nums; }
    #channel { margin: 0; color: var(--muted); font-size: 12.5px; overflow-wrap: anywhere; }
    #threshold-group[hidden] { display: none; }
    #threshold { height: 2px; margin: 14px 0 8px; border-radius: 2px;
      background: var(--line); overflow: hidden; }
    #threshold-fill { display: block; width: 0%; height: 100%; background: var(--muted);
      transition: width 240ms linear; }
    #threshold[data-state="met"] #threshold-fill { background: var(--accent); }
    #threshold-caption { margin: 0; font: 10px/1 var(--mono); letter-spacing: 0.12em;
      text-transform: uppercase; color: var(--muted); }
    #threshold[data-state="met"] + #threshold-caption { color: var(--accent); }
    .rows { display: grid; grid-template-columns: auto 1fr; gap: 7px 14px;
      margin: 18px 0 0; }
    .rows dt { font: 10px/1.6 var(--mono); letter-spacing: 0.12em;
      text-transform: uppercase; color: var(--muted); }
    .rows dd { margin: 0; text-align: right; font: 12.5px/1.6 var(--mono);
      font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
    h3 { margin: 17px 0 0; font: 10px/1 var(--mono); letter-spacing: 0.12em;
      text-transform: uppercase; color: var(--muted); }
    button { font: 11px/1 var(--mono); letter-spacing: 0.06em; text-transform: uppercase;
      padding: 9px 11px; border: 1px solid var(--line); border-radius: 7px;
      background: var(--surface); color: var(--text); cursor: pointer; }
    button:hover:not(:disabled) { background: var(--raised); border-color: var(--edge); }
    button:disabled { opacity: 0.45; cursor: default; }
    button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    button.danger { color: var(--danger); }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 15px; }
    .item .actions { margin-top: 10px; }
    .notice, .item { margin-top: 9px; padding: 10px 11px; border: 1px solid var(--line);
      border-left: 2px solid var(--warn); border-radius: 8px; background: var(--surface); }
    .item p, .notice p { margin: 0 0 7px; overflow-wrap: anywhere; }
    .item p:last-child, .notice p:last-child { margin-bottom: 0; }
    .meta { color: var(--muted); font-size: 12px; }
    @media (prefers-reduced-motion: reduce) {
      #panel { animation: none; }
      #threshold-fill { transition: none; }
    }
  `;

  // render() runs every tick, and the button host lives inside YouTube's own
  // masthead, so only write attributes that actually changed.
  function setDataValue(element, name, value) {
    if (element.dataset[name] !== value) element.dataset[name] = value;
  }

  function setAttributeValue(element, name, value) {
    if (element.getAttribute(name) !== value) element.setAttribute(name, value);
  }

  // A stopwatch ring with playback inside it: the two things this script joins.
  function createStatusIcon() {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("id", "icon");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    const ring = document.createElementNS(SVG_NS, "circle");
    ring.setAttribute("id", "ring");
    ring.setAttribute("cx", "12");
    ring.setAttribute("cy", "13.2");
    ring.setAttribute("r", "8.1");
    const stem = document.createElementNS(SVG_NS, "path");
    stem.setAttribute("id", "stem");
    stem.setAttribute("d", "M9.9 2.6h4.2M12 2.6v2.5");
    const play = document.createElementNS(SVG_NS, "path");
    play.setAttribute("id", "play");
    play.setAttribute("d", "M9.9 9.6 15.1 13.2 9.9 16.8Z");
    svg.append(ring, stem, play);
    return svg;
  }

  class StatusControl {
    constructor(app) {
      this.app = app;
      this.expanded = false;
      this.channelRows = new Map();
      this.batchRows = new Map();
      this.buttonHost = document.createElement("div");
      this.buttonHost.id = "yt-toggl-button-host";
      this.buttonHost.dataset.placement = "floating";
      this.buttonShadow = this.buttonHost.attachShadow({ mode: "open" });
      const style = document.createElement("style"); style.textContent = BUTTON_CSS;
      this.summary = document.createElement("button");
      this.summary.id = "summary"; this.summary.type = "button";
      this.summary.setAttribute("aria-expanded", "false");
      this.summary.setAttribute("aria-haspopup", "dialog");
      const dot = document.createElement("span"); dot.id = "attention";
      this.summary.append(createStatusIcon(), dot);
      this.buttonShadow.append(style, this.summary);
      this.host = document.createElement("div"); this.host.id = "yt-toggl-status-host";
      this.shadow = this.host.attachShadow({ mode: "open" });
      const panelStyle = document.createElement("style"); panelStyle.textContent = PANEL_CSS;
      this.panel = document.createElement("section"); this.panel.id = "panel";
      this.panel.hidden = true; this.panel.tabIndex = -1;
      this.panel.setAttribute("role", "dialog"); this.panel.setAttribute("aria-label", "YouTube watch time");
      const add = (tag, id, text = "") => {
        const node = document.createElement(tag); node.id = id; node.textContent = text;
        this.panel.append(node); return node;
      };
      add("p", "eyebrow").className = "eyebrow";
      add("p", "readout"); add("p", "video"); add("p", "channel");
      add("p", "threshold-caption");
      const actions = add("div", "actions"); actions.className = "actions";
      const sync = this.makeAction("Sync", () => this.app.sync()); sync.id = "sync";
      actions.append(sync);
      add("p", "error").className = "notice";
      const clear = this.makeAction("Clear error", () => { this.app.clearError(); this.render(); });
      clear.id = "clear-error"; this.panel.append(clear);
      add("h3", "channels-heading", "Unsent by channel"); add("div", "channels");
      add("h3", "queue-heading", "Delivery"); add("div", "decisions");
      add("p", "receipt").className = "meta";
      this.shadow.append(panelStyle, this.panel);
      this.summary.addEventListener("click", () => this.toggle());
      document.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && this.expanded) this.toggle(false);
      }, true);
      document.addEventListener("click", (event) => {
        if (!this.expanded) return;
        const path = event.composedPath();
        if (!path.includes(this.host) && !path.includes(this.buttonHost)) this.toggle(false);
      }, true);
    }
    mount() {
      (document.body || document.documentElement).append(this.host);
      this.placeButton(); this.render();
    }
    placeButton() {
      if (this.buttonHost.isConnected && this.buttonHost.dataset.placement === "masthead") return;
      const slot = MASTHEAD_SLOTS.map((selector) => document.querySelector(selector)).find(Boolean);
      if (slot) { this.buttonHost.dataset.placement = "masthead"; slot.prepend(this.buttonHost); }
      else if (!this.buttonHost.isConnected) {
        this.buttonHost.dataset.placement = "floating";
        (document.body || document.documentElement).append(this.buttonHost);
      }
    }
    positionPanel() {
      const floating = this.buttonHost.dataset.placement !== "masthead";
      const bar = this.buttonHost.closest("ytd-masthead, #masthead, #masthead-container");
      const rect = this.summary.getBoundingClientRect();
      this.panel.style.top = floating ? "auto" : `${Math.round(Math.max(rect.bottom, bar?.getBoundingClientRect().bottom || 0) + 8)}px`;
      this.panel.style.bottom = floating ? "68px" : "auto";
      this.panel.style.right = floating ? "16px" : `${Math.max(12, Math.round(window.innerWidth - rect.right))}px`;
    }
    toggle(next = !this.expanded) {
      if (next === this.expanded) return;
      this.expanded = next; this.panel.hidden = !next;
      this.summary.setAttribute("aria-expanded", String(next)); this.render();
      if (next) { this.positionPanel(); this.panel.focus(); } else this.summary.focus();
    }
    makeAction(label, callback, danger = false) {
      const button = document.createElement("button"); button.type = "button";
      button.textContent = label; if (danger) button.className = "danger";
      button.addEventListener("click", callback); return button;
    }
    text(id, value) {
      const node = this.shadow.getElementById(id);
      if (node.textContent !== value) node.textContent = value;
    }
    rows(containerId, map, values, keyOf, create, update) {
      const container = this.shadow.getElementById(containerId);
      const keys = new Set();
      for (const value of values) {
        const key = keyOf(value); keys.add(key);
        let row = map.get(key);
        if (!row) { row = create(value); map.set(key, row); container.append(row.element); }
        update(row, value);
      }
      for (const [key, row] of map) if (!keys.has(key)) { row.element.remove(); map.delete(key); }
    }
    render() {
      this.placeButton();
      setDataValue(this.buttonHost, "theme", document.documentElement.hasAttribute("dark") ? "dark" : "light");
      const { app } = this;
      const view = app.view || { records: [], batches: [], pendingChannels: [] };
      const record = app.recorder.record;
      const current = app.currentSnapshot;
      const tracking = app.playbackIsEligible();
      const state = tracking ? "tracking" : record ? "paused" : "idle";
      const errors = [...validateConfig(app.config), app.error, app.worker.capabilityError].filter(Boolean);
      const decisions = view.batches.filter((batch) => ["uncertain", "blocked"].includes(batch.status));
      const attention = Boolean(errors.length || decisions.length);
      setDataValue(this.summary, "state", state); setDataValue(this.summary, "attention", attention ? "1" : "0");
      const label = attention ? "YouTube watch time, needs attention" : `YouTube watch time, ${state}`;
      setAttributeValue(this.summary, "aria-label", label); setAttributeValue(this.summary, "title", label);
      if (!this.expanded) return;
      this.positionPanel();
      const videoId = current?.videoId || current?.mediaKey || record?.videoId;
      const currentRecords = view.records.filter((item) => item.videoId === videoId);
      const total = currentRecords.reduce((sum, item) => sum + item.durationMs, 0);
      this.text("eyebrow", tracking ? "NOW TRACKING" : record ? "TRACKING PAUSED" : "NOT TRACKING");
      this.text("readout", formatDuration(total));
      this.text("video", current?.title || record?.title || "Nothing playing");
      const observedChannel = current?.channel || record?.channel;
      this.text("channel", observedChannel?.name || observedChannel?.id || "");
      const pending = view.pendingChannels.find((group) => channelsEqual(group.channel, observedChannel));
      const left = Math.max(0, minimumDurationMs(app.config) - (pending?.durationMs || 0));
      this.text("threshold-caption", pending ? (left ? `${formatDuration(left)} UNTIL CHANNEL MINIMUM` : "CHANNEL MINIMUM REACHED") : "");
      this.text("error", errors.join(" "));
      this.shadow.getElementById("error").hidden = !errors.length;
      this.shadow.getElementById("clear-error").hidden = !app.error;
      this.shadow.getElementById("sync").disabled = !app.ready;
      this.rows("channels", this.channelRows, view.pendingChannels,
        (group) => group.channel.id || `name:${group.channel.name.toLowerCase()}`,
        () => {
          const element = document.createElement("div"); element.className = "item";
          const title = document.createElement("p"), detail = document.createElement("p"); detail.className = "meta";
          element.append(title, detail); return { element, title, detail };
        }, (row, group) => {
          const title = `${group.channel.name || group.channel.id} · ${formatDuration(group.durationMs)}`;
          if (row.title.textContent !== title) row.title.textContent = title;
          const remaining = Math.max(0, group.lastEligibleAtMs + inactivityMs(app.config) - Date.now());
          const detail = remaining > 0 ? `Closes after ${formatDuration(remaining)} without playback` : "Waiting for channel minimum or sync";
          if (row.detail.textContent !== detail) row.detail.textContent = detail;
        });
      this.rows("decisions", this.batchRows, view.batches.filter((batch) => ["pending", "sending", "uncertain", "blocked"].includes(batch.status)),
        (batch) => batch.id, (batch) => {
          const element = document.createElement("div"); element.className = "item";
          const title = document.createElement("p"), detail = document.createElement("p"); detail.className = "meta";
          const actions = document.createElement("div"); actions.className = "actions";
          const retry = this.makeAction("Retry", () => this.app.retryEntry(batch.id));
          const dismiss = this.makeAction("Dismiss", () => this.app.dismissEntry(batch.id), true);
          actions.append(retry, dismiss); element.append(title, detail, actions);
          return { element, title, detail, actions, retry, dismiss };
        }, (row, batch) => {
          const title = `${batch.status}: ${batch.description} · ${formatDuration(batch.duration * 1000)}`;
          if (row.title.textContent !== title) row.title.textContent = title;
          const detail = `${batch.start} · Workspace ${batch.workspaceId || ""}${batch.projectId ? ` / Project ${batch.projectId}` : ""}${batch.message ? ` · ${batch.message}` : ""}`;
          if (row.detail.textContent !== detail) row.detail.textContent = detail;
          row.retry.hidden = !["uncertain", "blocked"].includes(batch.status);
          row.dismiss.hidden = batch.status === "sending";
          row.retry.disabled = row.dismiss.disabled = !app.ready;
        });
      const sent = view.batches.filter((batch) => batch.status === "sent");
      this.text("receipt", sent.length ? `${sent.length} completed ${sent.length === 1 ? "entry" : "entries"} sent` : "");
    }
  }

  class BrowserApp {
    constructor(config = CONFIG, { ledger = new VideoLedger(), worker = null } = {}) {
      this.config = config; this.ledger = ledger; this.worker = worker || new TogglWorker(ledger, config);
      this.recorder = new PlaybackRecorder(config);
      this.view = { records: [], batches: [], pendingChannels: [], meta: [] };
      this.currentSnapshot = null; this.ready = false; this.error = "";
      this.discontinuityToken = 0; this.pending = []; this.operation = Promise.resolve();
      this.instanceId = randomId("observer");
      this.channel = null; this.intervals = []; this.stopped = false;
      this.status = new StatusControl(this);
    }
    playbackIsEligible() { return this.recorder.isTracking; }
    clearError() { this.error = ""; }
    enqueue(callback) {
      this.operation = this.operation.then(callback).catch((error) => {
        this.error = error?.message || String(error);
      }).finally(() => this.status.render());
      return this.operation;
    }
    publish(message) {
      try { this.channel?.postMessage({ ...message, from: this.instanceId }); } catch (_error) { /* Polling still refreshes persisted state. */ }
    }
    async refresh() {
      this.view = await this.ledger.snapshot(); this.status.render();
    }
    async flush() {
      // Retain ordered, unacknowledged checkpoints in memory. Replacing them
      // with only the latest total loses interval starts when Sync consumes a
      // prefix while storage is delayed. IndexedDB still stores one cumulative row.
      const count = this.pending.length;
      for (let index = 0; index < count; index += 1) {
        const { checkpoint, capturedAtMs, monotonicMs } = this.pending[0];
        await this.ledger.record(checkpoint, this.config, () => {
          const nowMs = Date.now();
          const monotonicNow = typeof performance?.now === "function" ? performance.now() : nowMs;
          return { nowMs, ageMs: Math.max(0, nowMs - capturedAtMs, monotonicNow - monotonicMs) };
        });
        this.pending.shift();
      }
    }
    tick({ finalize = true } = {}) {
      if (!this.ready || this.stopped) return this.operation;
      // Capture at event time, before awaiting storage, to preserve pause/rate tails.
      const snapshot = discoverMedia(this.discontinuityToken);
      const result = this.recorder.observe(snapshot);
      this.currentSnapshot = snapshot;
      if (result.checkpoint) this.pending.push({ checkpoint: result.checkpoint,
        capturedAtMs: snapshot.nowMs, monotonicMs: snapshot.monotonicMs });
      this.status.render();
      return this.enqueue(async () => {
        await this.flush();
        if (finalize) await this.ledger.finalize(this.config, { nowMs: () => Date.now() });
        await this.refresh();
        if (result.checkpoint) this.publish({ type: "changed" });
        this.kickWorker();
      });
    }
    kickWorker() {
      // Networking never blocks playback checkpoints behind a 30-second request.
      if (this.worker.kickPromise) return;
      this.worker.kick().then(() => this.enqueue(() => this.refresh())).catch((error) => {
        this.error = error?.message || String(error); this.status.render();
      });
    }
    async sync() {
      if (!this.ready) return;
      this.publish({ type: "sync" });
      await this.tick({ finalize: false });
      // Give live pages a bounded opportunity to flush; a suspended page cannot
      // hold a global Sync open. Its later contributions start another batch.
      await new Promise((resolve) => setTimeout(resolve, 500));
      return this.enqueue(async () => {
        await this.flush();
        await this.ledger.finalize(this.config, { nowMs: () => Date.now(), force: true });
        await this.refresh(); this.publish({ type: "changed" }); this.kickWorker();
      });
    }
    retryEntry(id) {
      return this.enqueue(async () => {
        await this.ledger.retry(id); await this.refresh(); this.publish({ type: "changed" }); this.kickWorker();
      });
    }
    dismissEntry(id) {
      if (!window.confirm("Dismiss this entry without sending it?")) return;
      return this.enqueue(async () => {
        await this.ledger.dismiss(id); await this.refresh(); this.publish({ type: "changed" });
      });
    }
    openChannel() {
      if (this.channel || typeof BroadcastChannel === "undefined") return;
      try { this.channel = new BroadcastChannel("yt-toggl-video-ledger-v2"); }
      catch (_error) { return; }
      this.channel.addEventListener("message", (event) => {
        const message = event.data;
        if (!message || message.from === this.instanceId) return;
        if (message.type === "changed") this.enqueue(() => this.refresh());
        if (message.type === "sync") this.tick({ finalize: false }).then(() => this.publish({ type: "changed" }));
      });
    }
    bindEvents() {
      for (const eventName of ["play", "playing", "canplay", "pause", "waiting", "stalled", "seeking", "seeked", "ratechange", "ended", "loadedmetadata"]) {
        document.addEventListener(eventName, (event) => {
          const selected = selectActiveVideo(document.querySelectorAll("video"));
          if (!event.target || event.target !== selected) return;
          if (eventName === "seeking") this.discontinuityToken += 1;
          this.tick();
        }, true);
      }
      for (const eventName of ["yt-navigate-finish", "yt-page-data-updated"]) document.addEventListener(eventName, () => this.tick(), true);
      window.addEventListener("pagehide", () => {
        this.tick({ finalize: false }); this.stopped = true;
        this.recorder.reset(); this.channel?.close(); this.channel = null;
      });
      window.addEventListener("pageshow", (event) => {
        if (!event.persisted) return;
        this.stopped = false; this.recorder.reset(); this.openChannel(); this.tick();
      });
    }
    async start() {
      this.status.mount();
      try {
        await this.ledger.open(); this.ready = true;
        this.openChannel(); this.bindEvents(); await this.tick();
        this.intervals.push(setInterval(() => this.tick(), TICK_INTERVAL_MS));
        this.intervals.push(setInterval(() => this.kickWorker(), WORKER_INTERVAL_MS));
      } catch (error) { this.error = error?.message || String(error); this.status.render(); }
    }
  }

  const API = {CONFIG,BrowserApp,StatusControl,PlaybackRecorder,VideoLedger,TogglWorker,clone,normalizeChannel,channelsEqual,mergeChannel,normalizeSnapshot,validatedPlaybackMs,selectActiveVideo,closestTrackablePlayer,isTopLevelBrowsingContext,discoverMedia,validateConfig,buildTogglRequest,encodeBasicAuth,parseResponseHeaders,classifyAttempt,rollingAttemptWindow,requestSpacingDelay,randomId,minimumDurationMs,inactivityMs};
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  if (typeof module === "undefined" && typeof window !== "undefined" && typeof document !== "undefined" && isTopLevelBrowsingContext()) {
    new BrowserApp(CONFIG).start();
  }
})();
