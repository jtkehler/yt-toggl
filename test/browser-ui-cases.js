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
    ready: true, error: "", worker: { capabilityError: "" }, ledger: new API.VideoLedger(),
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
    mergeOther() { calls.push(["merge-other"]); },
    discardOther() { calls.push(["discard-other"]); },
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
    app.ready = true;
    const shortRecord = (id, durationMs) => ({ ...record, id, videoId: id, channel: { id, name: id },
      durationMs, consumedMs: 0, pendingStartMs: start, lastEligibleAtMs: Date.now() });
    const records = [shortRecord("Short A", 20000), shortRecord("Short B", 25000), shortRecord("Named C", 70000),
      { ...shortRecord("Carried D", 15000), consumedMs: 15000, pendingStartMs: null }];
    const setView = (carrySources = []) => {
      app.view = { ...app.view, records, pendingChannels: app.ledger.groups(records),
        carry: { id: "global", sources: carrySources }, batches: [{ ...batch, status: "pending", description: "" }] };
      status.render();
    };
    const findOther = () => Array.from(channels.children).find(row => row.querySelector("p")?.textContent.startsWith("Other ·"));
    setView();
    assert(channels.children.length === 2 && findOther()?.textContent.includes("0:45") && channels.textContent.includes("Named C"),
      "all short channels collapse into one Other row while qualifying channels remain named");
    const carrySources = [{ recordId: "Carried D", fromMs: 0, toMs: 15000, durationMs: 15000, startMs: start }];
    setView(carrySources);
    const otherRow = findOther();
    assert(channels.children.length === 2 && otherRow.textContent.includes("1:00") && otherRow.textContent.includes("3 channels"),
      "Other counts carried and short active credit once and remains collapsed above the minimum");
    assert(decisions.textContent.includes("(No description)"), "unnamed batches have a readable local label");
    const mergeOther = Array.from(otherRow.querySelectorAll("button")).find(button => button.textContent === "Merge & Sync");
    const discardOther = Array.from(otherRow.querySelectorAll("button")).find(button => button.textContent === "Discard");
    mergeOther.focus(); setView(carrySources);
    assert(findOther() === otherRow && shadow.activeElement === mergeOther, "Other actions retain their nodes and keyboard focus");
    mergeOther.click(); discardOther.click();
    assert(JSON.stringify(calls.slice(-2)) === JSON.stringify([["merge-other"], ["discard-other"]]), "Other actions target their own scope");
    records[0].durationMs = 60000; setView(carrySources);
    assert(channels.children.length === 3 && findOther().textContent.includes("0:40") && channels.textContent.includes("Short A"),
      "a channel reaching the minimum leaves Other without reclaiming existing carry");
    for (const item of records) item.consumedMs = item.durationMs;
    setView(carrySources);
    app.view.batches = []; status.render();
    assert(channels.children.length === 1 && findOther().textContent.includes("0:15") && !discardAll.disabled,
      "carry-only state remains visible and enables bulk discard");
    app.ready = false; status.render();
    assert(mergeOther.disabled && discardOther.disabled, "Other actions wait for ledger readiness");
    app.ready = true; setView();
    assert(channels.children.length === 0, "empty Other row disappears");
    results.push("Other aggregation, threshold transitions, carry-only controls, unnamed descriptions, stable focus");
    status.toggle(false);
    assert(shadow.getElementById("panel").hidden && summary.getAttribute("aria-expanded") === "false",
      "closing panel updates native visibility and accessibility state");
    return results;
  } finally {
    status.host.remove();
    status.buttonHost.remove();
  }
};
