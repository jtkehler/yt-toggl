/* Native IndexedDB cases, invoked by the Firefox harness. No network requests. */
globalThis.runLedgerCases = async function runLedgerCases(API) {
  const { VideoLedger, TogglWorker } = API;
  if (typeof VideoLedger !== "function" || typeof TogglWorker !== "function") {
    throw new Error("VideoLedger and TogglWorker exports are required");
  }
  const results = [];
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const config = { togglApiToken: "secret-never-persist", togglWorkspaceId: 123,
    togglProjectId: null, inactivityMinutes: 1, minimumDurationMinutes: 1,
    mergeBelowMinimum: true, maxRequestsPerHour: 30 };
  const cp = (id, durationMs, start = 100000, channel = "A") => ({ id, videoId: id,
    title: `Video ${id}`, channel: { id: channel, name: channel }, firstPlayMs: start,
    durationMs, lastEligibleAtMs: start + durationMs, intervalStartMs: start });
  const make = async () => {
    const name = `yt-toggl-test-${Date.now()}-${Math.random()}`;
    const a = new VideoLedger({ name }); const b = new VideoLedger({ name });
    await Promise.all([a.open(), b.open()]); return [a, b];
  };
  const [a, b] = await make();
  await Promise.all([a.record(cp("one", 30000), config), b.record(cp("two", 35000), config)]);
  await a.record(cp("one", 30000), config);
  await a.record(cp("one", 10000), config);
  let snap = await b.snapshot();
  assert(snap.records.length === 2 && snap.pendingChannels[0].durationMs === 65000,
    "concurrent connections and cumulative checkpoints must preserve exactly 65000ms");
  await a.finalize(config, { nowMs: 194999 });
  assert((await b.snapshot()).batches.length === 0, "must not finalize before exact channel boundary");
  await Promise.all([a.finalize(config, { nowMs: 195000 }), b.finalize(config, { nowMs: 195000 })]);
  snap = await a.snapshot();
  assert(snap.batches.length === 1 && snap.batches[0].duration === 65, "one atomic summed batch");
  assert(snap.records.every((r) => r.consumedMs === r.durationMs), "atomic consumed offsets");
  assert(snap.batches[0].sources.length === 2, "batch source membership is retained");
  results.push("concurrent cumulative records, aggregation, exact boundary, atomic prefixes");
  const frozen = JSON.stringify(snap.batches[0]);
  await b.record({ ...cp("one", 40000), intervalStartMs: 200000, lastEligibleAtMs: 210000 }, config);
  snap = await a.snapshot();
  assert(JSON.stringify(snap.batches[0]) === frozen, "late credit cannot mutate outgoing batch");
  assert(snap.pendingChannels[0].firstPlayMs === 200000, "post-consumption prefix starts at new interval");
  assert(!JSON.stringify(snap).includes(config.togglApiToken), "API token must never be persisted");
  results.push("immutable batches, late prefix anchor, token exclusion");
  const [short] = await make();
  await short.record(cp("s1", 20000), config);
  await short.finalize(config, { force: true, nowMs: 150000 });
  await short.record(cp("s2", 45000, 300000, "B"), config);
  await short.finalize(config, { force: true, nowMs: 350000 });
  assert((await short.snapshot()).batches.length === 0, "short time cannot cross channels");
  await short.record(cp("s3", 40000, 400000), config);
  await short.finalize(config, { force: true, nowMs: 450000 });
  assert((await short.snapshot()).batches[0].duration === 60, "short time merges for same channel");
  await short.finalize({ ...config, mergeBelowMinimum: false }, { force: true, nowMs: 450000 });
  assert((await short.snapshot()).pendingChannels.length === 0, "discard consumes short credit");
  results.push("short retention stays within channel and discard consumes it");
  const [gap] = await make();
  await gap.record(cp("gap", 60000), config);
  await gap.record({ ...cp("gap", 90000), intervalStartMs: 220000, lastEligibleAtMs: 250000 }, config);
  snap = await gap.snapshot();
  assert(snap.batches.length === 1 && snap.batches[0].duration === 60 && snap.pendingChannels[0].durationMs === 30000,
    "record closes expired prefix before crediting nonbridging resumed interval");
  results.push("nonbridging resume closes old channel episode before credit");
  const locks = { request: async (_name, callback) => callback() };
  let now = 1000000; const calls = [];
  const worker = new TogglWorker(a, { ...config, togglWorkspaceId: 999 }, { locks, now: () => now,
    sleep: async (ms) => { now += ms; }, send: async (entry, destination) => {
      calls.push({ now, entry, destination }); now += 200;
      return { type: "response", status: 200, responseText: '{"id":42}' };
    } });
  await worker.kick(); snap = await a.snapshot();
  assert(snap.batches[0].status === "sent" && snap.batches[0].togglId === 42, "sent receipt survives");
  assert(calls[0].destination.togglWorkspaceId === 123, "frozen destination is used");
  assert(!(await a.retry(snap.batches[0].id)) && !(await a.dismiss(snap.batches[0].id)), "sent status is immutable to stale UI actions");
  const claimed = await gap.claim(config, now);
  assert(claimed.batch && claimed.batch.status === "sending", "claim is durable before request");
  const recovery = new TogglWorker(gap, config, { locks, now: () => now, send: async () => { throw new Error("must not retry interrupted send"); } });
  await recovery.kick(); snap = await gap.snapshot();
  assert(snap.batches[0].status === "uncertain", "interrupted send recovers uncertain");
  assert(await gap.retry(snap.batches[0].id), "explicit uncertain retry allowed");
  const missing = new TogglWorker(gap, config, { locks: null });
  await missing.kick();
  assert((await gap.snapshot()).batches[0].status === "pending" && missing.capabilityError, "missing locks fail closed");
  results.push("durable claims, receipts, conditional actions, interrupted recovery, lock failure");
  const [rate] = await make();
  await rate.record(cp("r1", 60000), config); await rate.record(cp("r2", 60000, 100000, "B"), config);
  await rate.finalize(config, { force: true, nowMs: now });
  const requestTimes = [];
  const originalClaim = rate.claim.bind(rate);
  rate.claim = async (...args) => { const result = await originalClaim(...args); if (result.batch) now += 50; return result; };
  await new TogglWorker(rate, config, { locks, now: () => now,
    sleep: async (ms) => { now += ms; }, send: async () => {
      requestTimes.push(now); now += 400;
      return { type: "response", status: 200, responseText: '{}' };
    } }).kick();
  assert(requestTimes.length === 2 && requestTimes[1] - requestTimes[0] >= 1400, "requests use completion-based spacing");
  snap = await rate.snapshot();
  assert(snap.meta.find((item) => item.id === "worker").attempts.every((time, index) => time === requestTimes[index]),
    "attempt timestamps refresh after awaited claim delays");
  await rate.record(cp("r3", 60000, now, "C"), config);
  await rate.finalize(config, { force: true, nowMs: now });
  const rollback = await rate.claim({ ...config, maxRequestsPerHour: 2 }, now - 10000);
  assert(!rollback.batch, "clock rollback cannot permit extra claims");
  assert((await rate.snapshot()).meta.find((item) => item.id === "worker").attempts.length === 2, "clock rollback retains future attempts");
  results.push("completion-based spacing, refreshed claim timestamps, preserved rollback attempts");
  const [quota] = await make();
  await quota.record(cp("q1", 60000), config); await quota.record(cp("q2", 60000, 100000, "B"), config);
  await quota.finalize(config, { force: true, nowMs: now });
  let quotaCalls = 0;
  const quotaWorker = new TogglWorker(quota, config, { locks, now: () => now, send: async () => {
    quotaCalls += 1; return { type: "response", status: 402, responseHeaders: "X-Toggl-Quota-Resets-In: 3600" };
  } });
  await quotaWorker.kick(); await quotaWorker.kick();
  assert(quotaCalls === 1 && (await quota.snapshot()).batches.every((batch) => batch.status === "pending"),
    "quota rejection retains pending batches and blocks further sends until reset");
  results.push("quota reset blocks the entire queue");
  const [setup] = await make();
  await setup.record(cp("setup", 60000), { ...config, togglWorkspaceId: 0 });
  await setup.finalize({ ...config, togglWorkspaceId: 0 }, { force: true, nowMs: now });
  assert((await setup.snapshot()).pendingChannels[0].durationMs === 60000, "unset destination retains capture");
  await setup.finalize(config, { force: true, nowMs: now });
  assert((await setup.snapshot()).batches[0].workspaceId === 123, "setup freezes destination when available");
  results.push("capture before destination setup");
  const [identity] = await make();
  await identity.record({ ...cp("identity", 30000), channel: { id: "", name: "Learned channel" } }, config);
  await identity.record({ ...cp("identity", 60000), channel: { id: "learned-id", name: "Learned channel" } }, config);
  assert((await identity.snapshot()).records[0].channel.id === "learned-id", "viewing record learns stable channel ID");
  await identity.finalize(config, { force: true, nowMs: 999999 });
  await identity.record(cp("past", 60000, 10000, "learned-id"), config);
  await identity.finalize(config, { nowMs: 130000 });
  assert((await identity.snapshot()).batches.length === 2, "consumed history cannot delay a new pending channel deadline");
  results.push("stable channel identity improvement and consumed-history isolation");
  const [clockA, clockB] = await make();
  await clockA.record(cp("clock", 60000, 900000), config);
  await clockA.observeClock(() => 1000000);
  await Promise.all([clockA.observeClock(() => 500000), clockB.observeClock(() => 500000)]);
  snap = await clockA.snapshot();
  assert(snap.records[0].lastEligibleAtMs === 460000 && snap.records[0].firstPlayMs === 900000,
    "trusted shared clock rollback shifts activity once and preserves first play");
  await clockB.finalize(config, { nowMs: 519999 });
  assert((await clockA.snapshot()).batches.length === 0, "rollback preserves remaining inactivity before boundary");
  await clockA.finalize(config, { nowMs: 520000 });
  assert((await clockB.snapshot()).batches.length === 1, "rollback preserves exact inactivity boundary across connections");
  results.push("trusted cross-connection clock rollback preserves inactivity");
  for (const ageMs of [0, 1000]) {
    const [delayedA, delayedB] = await make();
    await delayedA.record(cp("delayed", 60000), config);
    await delayedA.observeClock(() => 160000);
    const delayed = { ...cp("delayed", 61000), intervalStartMs: 160000, lastEligibleAtMs: 161000 };
    await delayedB.observeClock(() => 60000);
    await delayedA.record(delayed, config, () => ({ nowMs: 60000, ageMs }));
    await delayedB.observeClock(() => 60000);
    snap = await delayedA.snapshot();
    assert(snap.batches.length === 0 && snap.records[0].lastEligibleAtMs === 60000 - ageMs,
      "delayed pre-rollback checkpoint must not close a live prefix or restore a future inactivity anchor");
    assert(snap.records[0].firstPlayMs === 100000, "checkpoint clock context preserves original first play");
    await delayedB.finalize(config, { nowMs: () => 119999 - ageMs });
    assert((await delayedA.snapshot()).batches.length === 0, "trusted finalize resolves wall time inside transaction");
    await delayedA.finalize(config, { nowMs: () => 120000 - ageMs });
    snap = await delayedB.snapshot();
    assert(snap.batches.length === 1 && snap.batches[0].duration === 61,
      "transactional delayed-checkpoint activity preserves exact inactivity boundary");
  }
  const [atomicClockA, atomicClockB] = await make();
  await atomicClockA.record(cp("atomic-clock", 60000), config);
  await atomicClockA.observeClock(() => 160000);
  await atomicClockB.record({ ...cp("atomic-clock", 61000), intervalStartMs: 160000, lastEligibleAtMs: 161000 },
    config, () => ({ nowMs: 60000, ageMs: 0 }));
  await atomicClockA.finalize(config, { nowMs: () => 60000 });
  snap = await atomicClockB.snapshot();
  assert(snap.batches.length === 0 && snap.records[0].lastEligibleAtMs === 60000,
    "record detects rollback atomically and another connection does not shift it again");
  results.push("delayed checkpoints use transactional trusted clock context");
  if (globalThis.navigator?.locks) {
    const [parallelA, parallelB] = await make();
    await parallelA.record(cp("p1", 60000), config); await parallelB.record(cp("p2", 60000, 100000, "B"), config);
    await parallelA.finalize(config, { force: true, nowMs: now });
    let active = 0; let peak = 0; let sent = 0;
    const options = { locks: navigator.locks, now: () => now, sleep: async (ms) => { now += ms; },
      send: async () => { active += 1; peak = Math.max(peak, active); sent += 1;
        await new Promise((resolve) => setTimeout(resolve, 10)); active -= 1;
        return { type: "response", status: 200, responseText: '{}' }; } };
    await Promise.all([new TogglWorker(parallelA, config, options).kick(), new TogglWorker(parallelB, config, options).kick()]);
    assert(peak === 1 && sent === 2 && (await parallelA.snapshot()).batches.every((batch) => batch.status === "sent"),
      "native Web Locks serialize workers across database connections without false recovery");
    results.push("native Web Locks cross-connection single-flight delivery");
  } else throw new Error("Native Web Locks are required for concurrency verification");
  return results;
};
