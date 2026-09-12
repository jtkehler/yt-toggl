/* Actual BrowserApp integration with native IndexedDB and controlled media clocks. */
globalThis.runBrowserRuntimeCases = async function (API) {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const originalNow = Date.now;
  const originalConfirm = window.confirm;
  const originalPerformanceNow = Object.getOwnPropertyDescriptor(performance, "now");
  const originalPath = location.pathname + location.search;
  let now = 1000000;
  Date.now = () => now;
  Object.defineProperty(performance, "now", { configurable: true, value: () => now });
  history.replaceState(null, "", "/watch?v=runtime-video");
  const player = document.createElement("div"); player.id = "movie_player";
  player.getVideoData = () => ({ video_id: "runtime-video", channel_id: "UC-runtime", author: "Runtime", title: "Runtime video" });
  const video = document.createElement("video"); let mediaTime = 0;
  Object.defineProperties(video, {
    currentTime: { get: () => mediaTime }, paused: { get: () => false }, ended: { get: () => false },
    readyState: { get: () => 4 }, seeking: { get: () => false },
    played: { get: () => ({ length: 1, start: () => 0, end: () => mediaTime }) },
  });
  player.append(video); document.body.append(player);
  const config = { ...API.CONFIG, togglApiToken: "fixture", togglWorkspaceId: 123, minimumDurationMinutes: 0 };
  const ledger = new API.VideoLedger({ name: `runtime-${Math.random()}` });
  const app = new API.BrowserApp(config, { ledger });
  try {
    await app.start();
    for (const interval of app.intervals) clearInterval(interval);
    assert(app.ready, "actual app opens native ledger without privileged request API");
    now += 60000; mediaTime += 60;
    await app.tick(); await app.worker.kick(); await app.operation;
    let snap = await ledger.snapshot();
    assert(snap.records.length === 1 && snap.records[0].durationMs === 60000, "actual browser app persists measured playback");
    assert(app.worker.capabilityError, "missing upload capability is reported without preventing capture");
    await ledger.finalize(config, { nowMs: now, force: true });
    let release;
    app.operation = new Promise((resolve) => { release = resolve; });
    const expectedStart = now;
    for (let index = 0; index < 3; index += 1) { now += 1000; mediaTime += 1; app.tick(); }
    release(); await app.operation;
    snap = await ledger.snapshot();
    assert(snap.pendingChannels[0].durationMs === 3000, "delayed operation preserves all post-Sync credit");
    assert(snap.pendingChannels[0].firstPlayMs === expectedStart, "queued checkpoints retain first post-consumption timestamp");
    await app.sync(); await app.operation;
    snap = await ledger.snapshot();
    assert(snap.batches.length === 2 && snap.batches.some((batch) => batch.duration === 3), "actual Sync freezes the available channel prefix");

    assert(typeof app.discardChannel === "function" && typeof app.discardAll === "function",
      "actual browser app exposes individual channel and bulk discard operations");
    now += 2000; mediaTime += 2;
    await app.tick(); await app.operation;
    snap = await ledger.snapshot();
    const channel = snap.pendingChannels[0].channel;
    const canceledSnapshot = JSON.stringify(snap);
    window.confirm = () => false;
    await app.discardChannel(channel);
    await app.discardAll();
    await app.dismissEntry(snap.batches[0].id);
    assert(JSON.stringify(await ledger.snapshot()) === canceledSnapshot,
      "canceling channel, bulk, and queued entry discard leaves persistent state untouched");

    window.confirm = () => true;
    const firstDiscardAt = now;
    await app.discardChannel(channel);
    snap = await ledger.snapshot();
    assert(snap.pendingChannels.length === 0 && snap.records.length === 1 && snap.records[0].durationMs === 65000 &&
      snap.records[0].consumedMs === 65000 && snap.batches.every(batch => batch.status === "pending"),
      "confirmed channel discard consumes only unbatched credit and preserves its cumulative record and queued entries");
    now += 1000; mediaTime += 1;
    await app.tick(); await app.operation;
    snap = await ledger.snapshot();
    assert(snap.pendingChannels.length === 1 && snap.pendingChannels[0].durationMs === 1000 &&
      snap.pendingChannels[0].firstPlayMs === firstDiscardAt,
      "continued playback after channel discard starts a fresh pending prefix without restoring discarded credit");
    const selectedBatchId = snap.batches[0].id;
    await app.dismissEntry(selectedBatchId);
    snap = await ledger.snapshot();
    assert(snap.batches.find(batch => batch.id === selectedBatchId).status === "dismissed" &&
      snap.batches.filter(batch => batch.status === "pending").length === 1 && snap.pendingChannels[0].durationMs === 1000,
      "confirmed queued entry discard leaves other queued entries and live channel credit available");
    const allDiscardAt = now;
    await app.discardAll();
    snap = await ledger.snapshot();
    assert(snap.pendingChannels.length === 0 && snap.batches.length === 2 &&
      snap.batches.every(batch => batch.status === "dismissed") && snap.records[0].consumedMs === 66000,
      "confirmed bulk discard clears available channel credit and queued entries together");
    now += 1000; mediaTime += 1;
    await app.tick(); await app.operation;
    snap = await ledger.snapshot();
    assert(snap.pendingChannels.length === 1 && snap.pendingChannels[0].durationMs === 1000 &&
      snap.pendingChannels[0].firstPlayMs === allDiscardAt && snap.batches.every(batch => batch.status === "dismissed"),
      "continued playback after bulk discard accrues only its new interval");

    const saved = snap.records[0].durationMs;
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
    now += 30000; mediaTime += 30;
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    await app.operation;
    assert((await ledger.snapshot()).records.reduce((sum, record) => sum + record.durationMs, 0) === saved,
      "BFCache restoration cannot credit suspended playback gap");
    return ["actual startup without upload API, capture, queued checkpoints, global Sync, BFCache baseline",
      "discard cancellation, individual channel and queued entry scope, bulk discard, continued playback"];
  } finally {
    app.stopped = true;
    for (const interval of app.intervals) clearInterval(interval);
    app.channel?.close();
    await app.worker.kickPromise;
    await app.operation;
    app.status.host.remove(); app.status.buttonHost.remove(); player.remove();
    ledger.db?.close();
    Date.now = originalNow;
    window.confirm = originalConfirm;
    if (originalPerformanceNow) Object.defineProperty(performance, "now", originalPerformanceNow);
    else delete performance.now;
    history.replaceState(null, "", originalPath);
  }
};
