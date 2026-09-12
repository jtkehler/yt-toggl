/* Real shadow DOM focus and action checks; no browser runtime or remote API. */
globalThis.runBrowserUiCases = async function runBrowserUiCases(API) {
  if (typeof API.StatusControl !== "function") throw new Error("StatusControl export is missing");
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const results = [];
  const calls = [];
  const start = Date.UTC(2026, 8, 11, 12, 30);
  const channel = { id: "UC-native-test", name: "Native browser channel" };
  const record = { id: "native-video", videoId: "video-1", title: "Current browser video",
    channel, firstPlayMs: start, lastEligibleAtMs: start + 65000,
    durationMs: 65000, consumedMs: 0 };
  const batch = { id: "native-batch", status: "uncertain", description: channel.name,
    channel, duration: 65, start: new Date(start).toISOString(), firstPlayMs: start,
    createdAtMs: start + 65000, message: "Fixture timeout", lastError: "Fixture timeout" };
  const app = {
    config: { togglApiToken: "local-fixture", togglWorkspaceId: 123, togglProjectId: null,
      inactivityMinutes: 1, minimumDurationMinutes: 1, mergeBelowMinimum: true,
      maxRequestsPerHour: 30 },
    ready: true, error: "", worker: { capabilityError: "" },
    currentSnapshot: { videoId: record.videoId, title: record.title, channel,
      paused: false, ended: false, seeking: false, readyState: 4, ad: false },
    recorder: { record, creditedMs: 1000 },
    view: { records: [record], batches: [batch], pendingChannels: [
      { key: channel.id, channelKey: channel.id, channel, durationMs: 65000, firstPlayMs: start },
    ], meta: [] },
    playbackIsEligible() { return this.recorder.creditedMs > 0; },
    sync() { calls.push(["sync"]); },
    retryEntry(id) { calls.push(["retry", id]); },
    dismissEntry(id) { calls.push(["dismiss", id]); },
    discardChannel(value) { calls.push(["discard-channel", value.id]); },
    discardAll() { calls.push(["discard-all"]); },
    clearError() { this.error = ""; calls.push(["clear"]); },
  };
  const status = new API.StatusControl(app);
  try {
    status.mount();
    status.toggle(true);
    status.render();
    const shadow = status.shadow;
    const summary = status.summary || status.buttonShadow.getElementById("summary");
    assert(summary.dataset.state === "tracking", "positive validated accrual shows tracking");
    assert(!shadow.getElementById("panel").hidden, "panel opens in native shadow DOM");
    assert(shadow.getElementById("readout").textContent.includes("1:05"), "current duration is displayed");
    assert(shadow.textContent.includes(record.title), "current video title is displayed");
    assert(shadow.getElementById("channels").textContent.includes(channel.name), "global pending channel is displayed");
    const decisions = shadow.getElementById("decisions");
    assert(decisions.textContent.includes("2026"), "queued decision includes a viewing timestamp");
    const findAction = label => Array.from(decisions.querySelectorAll("button")).find(button => button.textContent === label);
    const retry = findAction("Retry");
    const dismiss = findAction("Discard");
    assert(retry && dismiss, "uncertain entry exposes explicit Retry and Discard actions");
    retry.focus();
    assert(shadow.activeElement === retry, "Retry receives actual native focus");
    app.view = { ...app.view, batches: app.view.batches.map(entry => ({ ...entry })) };
    status.render();
    assert(findAction("Retry") === retry && shadow.activeElement === retry,
      "snapshot refresh preserves keyed action node and actual native focus");
    retry.click();
    dismiss.click();
    assert(JSON.stringify(calls.slice(-2)) === JSON.stringify([["retry", batch.id], ["dismiss", batch.id]]),
      "decision buttons target the displayed immutable batch");
    shadow.getElementById("sync").click();
    assert(calls.at(-1)[0] === "sync", "Sync invokes global app sync");
    results.push("native shadow DOM, current video, channel total, keyed focus, scoped actions");

    const channels = shadow.getElementById("channels");
    const channelDiscard = Array.from(channels.querySelectorAll("button")).find(button => button.textContent === "Discard");
    const discardAll = Array.from(shadow.querySelectorAll("button")).find(button => button.textContent === "Discard all unsent");
    assert(channelDiscard && discardAll && !discardAll.disabled, "pending channel and global unsent totals expose discard actions");
    channelDiscard.focus();
    app.view = { ...app.view, pendingChannels: app.view.pendingChannels.map(group => ({ ...group,
      channel: { ...group.channel, name: "Updated native channel name" }, durationMs: 66000 })) };
    status.render();
    assert(channels.querySelector("button") === channelDiscard && shadow.activeElement === channelDiscard,
      "channel refresh preserves discard node and focus while metadata and credit change");
    channelDiscard.click();
    discardAll.click();
    assert(JSON.stringify(calls.slice(-2)) === JSON.stringify([["discard-channel", channel.id], ["discard-all"]]),
      "individual channel and global discard actions use their intended scopes");
    const pendingChannels = app.view.pendingChannels;
    app.view = { ...app.view, pendingChannels: [], batches: [{ ...batch, status: "sending" }] };
    status.render();
    assert(findAction("Discard").hidden && findAction("Retry").hidden,
      "a sending batch offers no discard or retry control");
    assert(discardAll.disabled, "sending-only state disables bulk discard");
    app.view = { ...app.view, pendingChannels, batches: [batch] };
    status.render();
    results.push("channel and bulk discard scopes, stable channel focus, sending protection");

    app.recorder.creditedMs = 0;
    status.render();
    assert(summary.dataset.state === "paused", "media with no validated accrual shows paused despite unpaused media flags");
    app.view.batches = [{ ...batch, status: "sent", message: "Historical fixture timeout", lastError: "Historical fixture timeout" }];
    status.render();
    assert(!findAction("Retry"), "resolved batch removes decision actions");
    assert(summary.dataset.attention === "0", "historical sent error does not require attention");
    app.error = "Current fixture storage error";
    status.render();
    assert(summary.dataset.attention === "1", "current operational error requires attention");
    assert(shadow.getElementById("error").textContent.includes(app.error), "current error is visible");
    shadow.getElementById("clear-error").click();
    status.render();
    assert(!app.error && summary.dataset.attention === "0", "clearing resolved operational error clears attention");
    app.worker.capabilityError = "Web Locks are unavailable";
    status.render();
    assert(summary.dataset.attention === "1" && shadow.textContent.includes("Web Locks"),
      "missing delivery capability surfaces an actionable notice");
    app.worker.capabilityError = "";
    app.ready = false;
    status.render();
    assert(shadow.getElementById("sync").disabled, "Sync waits for ledger readiness");
    assert(discardAll.disabled && channels.querySelector("button").disabled,
      "channel and bulk discard wait for ledger readiness");
    app.view.batches = [{ ...batch, status: "pending" }];
    status.render();
    assert(findAction("Discard").disabled, "queued entry discard waits for ledger readiness");
    results.push("validated stalled state, resolved attention, clearable errors, capability and readiness states");
    status.toggle(false);
    assert(shadow.getElementById("panel").hidden && summary.getAttribute("aria-expanded") === "false",
      "closing panel updates native visibility and accessibility state");
    return results;
  } finally {
    status.host.remove();
    status.buttonHost.remove();
  }
};
