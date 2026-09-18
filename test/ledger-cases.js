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
  const [carryFirst] = await make();
  await carryFirst.record(cp("carry-a", 20000, 100000, "A"), config);
  await carryFirst.finalize(config, { nowMs: 180000 });
  await carryFirst.record(cp("carry-b", 25000, 200000, "B"), config);
  await carryFirst.finalize(config, { nowMs: 285000 });
  await carryFirst.record(cp("carry-c", 30000, 300000, "C"), config);
  await carryFirst.finalize(config, { nowMs: 390000 });
  const firstCarrySnapshot = await carryFirst.snapshot();
  assert(firstCarrySnapshot.batches.length === 1 && firstCarrySnapshot.batches[0].duration === 75 &&
    firstCarrySnapshot.batches[0].channel.id === "C", "closed short channels must merge into the next closing channel");
  assert(firstCarrySnapshot.carry.durationMs === 0 && firstCarrySnapshot.batches[0].sources.length === 3,
    "merged batch claims the three original sources and clears carry");
  results.push("automatic global carry into next closing channel");
  const [manual] = await make();
  await manual.record(cp("manual-carry", 20000), config);
  await manual.finalize(config, { nowMs: 180000 });
  await manual.record(cp("manual-short", 15000, 200000, "B"), config);
  await manual.record(cp("manual-named", 60000, 200000, "C"), config);
  const merged = await manual.mergeOther({ ...config, mergedEntryDescription: "", dayBoundary: "04:00" }, { nowMs: 300000 });
  assert(merged.duration === 35 && merged.description === "" && merged.merged && merged.start === new Date(300000).toISOString(),
    "manual merge bypasses minimum, permits no description, and freezes creation time without day cutoff");
  let manualSnapshot = await manual.snapshot();
  assert(manualSnapshot.pendingChannels.length === 1 && manualSnapshot.pendingChannels[0].channel.id === "C" &&
    manualSnapshot.carry.durationMs === 0, "manual merge consumes only Other and preserves named channels");
  assert(manualSnapshot.records.find(record => record.id === "manual-short").durationMs === 15000,
    "merging never changes the original video's recorded history");
  assert(await manual.mergeOther(config, { nowMs: 300001 }) === null, "repeated empty manual merge cannot duplicate time");
  const [fraction] = await make();
  await fraction.record(cp("fraction", 400), config);
  assert(await fraction.mergeOther(config, { nowMs: 100400 }) === null, "rounded-zero manual total remains saved");
  assert((await fraction.snapshot()).records[0].consumedMs === 0, "rounded-zero merge does not consume sources");
  await fraction.record({ ...cp("fraction", 600), intervalStartMs: 100400 }, config);
  const fractionBatch = await fraction.mergeOther({ ...config, mergedEntryDescription: "Custom title" }, { nowMs: 100600 });
  assert(fractionBatch.duration === 1 && fractionBatch.description === "Custom title", "manual merge rounds only the combined total and uses configured text");
  results.push("manual Other scope, empty/custom descriptions, merge dates, rounding and idempotency");

  // The upgrade must keep the accumulated backlog and every delivery state.
  const upgradeName = `upgrade-${Math.random()}`;
  let oldClosed = false;
  const oldDatabase = await new Promise((resolve, reject) => {
    const request = indexedDB.open(upgradeName, 1);
    request.onupgradeneeded = () => {
      for (const name of ["records", "batches", "meta"]) request.result.createObjectStore(name, { keyPath: "id" });
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
  const oldRecord = { ...cp("upgrade-short", 20000), consumedMs: 0, pendingStartMs: 100000 };
  const oldBatches = ["pending", "uncertain", "blocked", "sending", "sent", "dismissed"].map(status => ({
    id: `old-${status}`, status, channel: { id: "Old", name: "Old" }, description: "Old",
    duration: 60, durationMs: 60000, sources: [], start: new Date(100000).toISOString(),
    workspaceId: 123, projectId: null, createdAtMs: 160000, nextAttemptAtMs: 0, message: "Saved state",
  }));
  await new Promise((resolve, reject) => {
    const tx = oldDatabase.transaction(["records", "batches", "meta"], "readwrite");
    tx.objectStore("records").put(oldRecord);
    for (const batch of oldBatches) tx.objectStore("batches").put(batch);
    tx.objectStore("meta").put({ id: "worker", attempts: [160000], quotaUntilMs: 200000, lastCompletedAtMs: 160000 });
    tx.oncomplete = resolve; tx.onabort = () => reject(tx.error);
  });
  oldDatabase.onversionchange = () => { oldClosed = true; oldDatabase.close(); };
  const upgraded = new VideoLedger({ name: upgradeName }); await upgraded.open();
  const upgradedSnapshot = await upgraded.snapshot();
  assert(oldClosed && upgraded.db.version === 2 && upgraded.db.objectStoreNames.contains("carry"),
    "upgrade closes the old connection and adds durable carry in the existing database");
  assert(JSON.stringify(upgradedSnapshot.records[0]) === JSON.stringify(oldRecord) &&
    oldBatches.every(old => JSON.stringify(upgradedSnapshot.batches.find(batch => batch.id === old.id)) === JSON.stringify(old)) &&
    upgradedSnapshot.meta[0].attempts[0] === 160000, "upgrade preserves saved credit, immutable payloads, all delivery states, and rate metadata");
  const oldVersionError = await new Promise(resolve => {
    const request = indexedDB.open(upgradeName, 1);
    request.onerror = () => resolve(request.error.name);
    request.onsuccess = () => { request.result.close(); resolve("unexpected open"); };
  });
  assert(oldVersionError === "VersionError", "old script cannot reopen the upgraded ledger and consume carry sources again");
  await upgraded.finalize(config, { nowMs: 180000 });
  assert((await upgraded.snapshot()).carry.durationMs === 20000, "pre-upgrade short credit enters carry without migration loss");
  results.push("in-place ledger upgrade preserves backlog, delivery states, rate data, and excludes old writers");

  for (const tied of [false, true]) for (const reverse of [false, true]) {
    const [orderedA, orderedB] = await make();
    const input = tied ? [["A", 20000], ["B", 20000], ["C", 20000]] : [["A", 20000], ["B", 25000], ["C", 30000]];
    for (const [id, duration] of reverse ? [...input].reverse() : input) await orderedA.record(cp(id, duration, 100000, id), config);
    await Promise.all([orderedB.finalize(config, { nowMs: 190000 }), orderedA.finalize(config, { nowMs: 190000 })]);
    const ordered = await orderedA.snapshot();
    assert(ordered.batches.length === 1 && ordered.batches[0].channel.id === "C" &&
      ordered.batches[0].duration === (tied ? 60 : 75), "deadline/key ordering is independent of insertion order and invoking connection");
    const after = JSON.stringify(ordered);
    await orderedB.finalize(config, { nowMs: 500000 });
    assert(JSON.stringify(await orderedA.snapshot()) === after, "repeated closures cannot reassign consumed carry");
  }
  for (const resumedChannel of ["A", "B"]) {
    const [resumed] = await make();
    await resumed.record(cp("resume-A", 20000, 100000, "A"), config);
    await resumed.record(cp("resume-B", 45000, 110000, "B"), config);
    await resumed.record({ ...cp(`resume-${resumedChannel}`, resumedChannel === "A" ? 25000 : 50000,
      resumedChannel === "A" ? 100000 : 110000, resumedChannel), intervalStartMs: 220000, lastEligibleAtMs: 225000 }, config);
    const after = await resumed.snapshot();
    assert(after.batches.length === 1 && after.batches[0].channel.id === "B" && after.batches[0].duration === 65 &&
      after.pendingChannels[0].durationMs === 5000 && after.pendingChannels[0].firstPlayMs === 220000,
      "resumed checkpoint closes every due channel in order before applying fresh credit");
  }
  const [active] = await make();
  await active.record(cp("old-carry", 20000), config);
  await active.finalize(config, { nowMs: 180000 });
  await active.record(cp("receiving", 45000, 200000, "B"), config);
  await active.record(cp("still-active", 30000, 250000, "C"), config);
  await active.finalize(config, { nowMs: 305000 });
  const activeSnapshot = await active.snapshot();
  assert(activeSnapshot.batches[0].duration === 65 && activeSnapshot.batches[0].channel.id === "B" &&
    activeSnapshot.pendingChannels[0].durationMs === 30000 && activeSnapshot.pendingChannels[0].channel.id === "C",
    "active short donor remains available even while another channel claims carry");
  results.push("deterministic closure ordering, concurrent finalization, resumed prefixes, and active-donor exclusion");

  const seedCarry = async (kind) => {
    const [ledger, peer] = await make();
    await ledger.record(cp("history", 60000, 100000, "History"), config);
    await ledger.finalize(config, { nowMs: 160000, force: true });
    await ledger.record(cp("donor", 20000, 200000, "A"), config);
    if (kind !== "park") {
      await ledger.finalize(config, { nowMs: 230000, force: true });
      await ledger.record(cp("receiver", kind === "auto" ? 45000 : 25000, 300000, "B"), config);
      if (kind !== "auto") {
        await ledger.record(cp("shorter", 10000, 300000, "C"), config);
        await ledger.record(cp("named", 70000, 300000, "Named"), config);
      }
    }
    const action = () => kind === "park" || kind === "auto" ? ledger.finalize(config, { nowMs: 400000, force: true })
      : kind === "manual" ? ledger.mergeOther(config, { nowMs: 400000 })
      : kind === "discard" ? ledger.discardOther(config) : ledger.discardAll();
    return { ledger, peer, action };
  };
  const instrumentWrites = (ledger, failAt) => {
    const original = ledger.transaction.bind(ledger);
    let writes = 0;
    ledger.transaction = (mode, operation, readStores) => original(mode, (state, stores) => {
      const wrapped = Object.fromEntries(Object.entries(stores).map(([name, store]) => [name, new Proxy(store, {
        get(target, key) {
          const value = Reflect.get(target, key, target);
          if (typeof value !== "function") return value;
          return (...args) => {
            const result = value.apply(target, args);
            if (["put", "add", "delete"].includes(key) && ++writes === failAt) throw new Error("Injected carry write failure");
            return result;
          };
        },
      })]));
      return operation(state, wrapped);
    }, readStores);
    return { count: () => writes, restore: () => { ledger.transaction = original; } };
  };
  for (const kind of ["park", "auto", "manual", "discard", "bulk"]) {
    const sample = await seedCarry(kind);
    const counter = instrumentWrites(sample.ledger, 0);
    await sample.action(); counter.restore();
    assert(counter.count() > 0, `${kind} exercises persistent mutations`);
    for (let failAt = 1; failAt <= counter.count(); failAt++) {
      const fixture = await seedCarry(kind);
      const before = JSON.stringify(await fixture.peer.snapshot());
      const injected = instrumentWrites(fixture.ledger, failAt);
      let rejected = false;
      try { await fixture.action(); } catch (error) { rejected = error.message === "Injected carry write failure"; }
      finally { injected.restore(); }
      assert(rejected && JSON.stringify(await fixture.peer.snapshot()) === before,
        `${kind} failure after write ${failAt} rolls back sources, carry, batches and metadata together`);
    }
  }
  results.push("native transaction rollback at every carry, allocation, manual merge and discard write boundary");

  for (const competing of ["merge", "sync", "discard", "bulk"]) for (const reversed of [false, true]) {
    const [raceA, raceB] = await make();
    await raceA.record(cp("race-a", 20000, 100000, "A"), config);
    await raceA.record(cp("race-b", 25000, 100000, "B"), config);
    const merge = () => raceA.mergeOther(config, { nowMs: 200000 });
    const rival = () => competing === "merge" ? raceB.mergeOther(config, { nowMs: 200000 })
      : competing === "sync" ? raceB.finalize(config, { nowMs: 200000, force: true })
      : competing === "discard" ? raceB.discardOther(config) : raceB.discardAll();
    await Promise.all((reversed ? [rival, merge] : [merge, rival]).map(action => action()));
    const raced = await raceB.snapshot();
    const discardedFirst = reversed && ["discard", "bulk"].includes(competing);
    assert(raced.batches.length === (discardedFirst ? 0 : 1) && raced.carry.durationMs === 0 && raced.pendingChannels.length === 0,
      `concurrent manual merge and ${competing} have one owner for every source range`);
    if (raced.batches.length) assert(raced.batches[0].duration === 45 &&
      raced.batches[0].status === (competing === "bulk" ? "dismissed" : "pending"), "race preserves exact duration and discard scope");
  }
  const { ledger: invalidCarry } = await seedCarry("manual");
  const unchanged = JSON.stringify(await invalidCarry.snapshot());
  for (const invalid of [{ togglWorkspaceId: 0 }, { mergedEntryDescription: null }, { dayBoundary: "bad" }]) {
    await invalidCarry.finalize({ ...config, ...invalid }, { nowMs: 500000, force: true });
    await invalidCarry.mergeOther({ ...config, ...invalid }, { nowMs: 500000 });
    assert(JSON.stringify(await invalidCarry.snapshot()) === unchanged, "invalid allocation settings cannot consume or rearrange carry");
  }
  const beforeRollbackCarry = JSON.stringify((await invalidCarry.snapshot()).carry);
  await invalidCarry.observeClock(() => 500000); await invalidCarry.observeClock(() => 400000);
  assert(JSON.stringify((await invalidCarry.snapshot()).carry) === beforeRollbackCarry, "clock rollback leaves parked source timestamps and duration unchanged");
  await invalidCarry.discardOther({ ...config, togglWorkspaceId: 0 });
  assert((await invalidCarry.snapshot()).carry.durationMs === 0 && (await invalidCarry.snapshot()).pendingChannels[0].channel.id === "Named",
    "Other discard works without setup and preserves independently qualifying channels");
  await manual.claim(config, 400000);
  await manual.complete(merged.id, { type: "timeout" }, 400001);
  await manual.retry(merged.id);
  const retried = await manual.claim({ ...config, togglWorkspaceId: 999, mergedEntryDescription: "Changed" }, 86400000);
  const retriedRequest = API.buildTogglRequest(retried.batch, config);
  assert(retriedRequest.body.description === "" && retriedRequest.body.start === new Date(300000).toISOString() &&
    retriedRequest.body.duration === 35 && retriedRequest.body.workspace_id === 123,
    "retry on a later day preserves empty description, merge date, exact duration and destination");
  results.push("cross-connection merge/sync/discard races, invalid settings, carry clock rollback, frozen unnamed retry");
  const [mergeDates] = await make();
  const previousNight = new Date(2026, 8, 17, 22).getTime();
  const receiverAt = new Date(2026, 8, 18, 1).getTime();
  const mergeAt = new Date(2026, 8, 18, 2).getTime();
  const mergeDateConfig = { ...config, dayBoundary: "04:00" };
  await mergeDates.record(cp("dated-donor", 20000, previousNight, "A"), mergeDateConfig);
  await mergeDates.finalize(mergeDateConfig, { nowMs: previousNight + 80000 });
  await mergeDates.record(cp("dated-receiver", 45000, receiverAt, "B"), mergeDateConfig);
  await mergeDates.finalize(mergeDateConfig, { nowMs: mergeAt });
  const datedBatch = (await mergeDates.snapshot()).batches[0];
  assert(datedBatch.start === new Date(mergeAt).toISOString() && datedBatch.merged && datedBatch.description === "B" &&
    datedBatch.sources[0].startMs === previousNight, "automatic carry uses today's merge time even before the configured day cutoff, while preserving source dates");
  results.push("automatic merged date bypasses day cutoff and retains original source timestamps");
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
  assert((await short.snapshot()).batches[0].duration === 65 && (await short.snapshot()).batches[0].channel.id === "B",
    "closed short time crosses channels into the next closing receiver");
  await short.record(cp("s3", 40000, 400000), config);
  await short.finalize(config, { force: true, nowMs: 450000 });
  assert((await short.snapshot()).carry.durationMs === 40000, "later short closure creates a fresh global carry");
  await short.record(cp("discard-short", 10000, 500000, "D"), { ...config, mergeBelowMinimum: false });
  await short.finalize({ ...config, mergeBelowMinimum: false }, { force: true, nowMs: 450000 });
  assert((await short.snapshot()).pendingChannels.length === 0 && (await short.snapshot()).carry.durationMs === 40000,
    "discard mode consumes new short credit while retaining previously saved carry");
  results.push("cross-channel retention and discard mode preserves existing carry");
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
  const [discardA, discardB] = await make();
  await discardA.record(cp("queued-A", 60000), config);
  await discardA.finalize(config, { force: true, nowMs: 160000 });
  const queuedBeforeDiscard = JSON.stringify((await discardA.snapshot()).batches);
  const shared = (id, duration, channelId) => ({ ...cp(id, duration), channel: { id: channelId, name: "Shared" } });
  await discardA.record(shared("discard-A", 20000, "A"), config);
  await discardB.record(shared("keep-B", 30000, "B"), config);
  await discardB.record(shared("keep-name", 40000, ""), config);
  await discardA.discardChannel({ id: "A", name: "Shared" });
  snap = await discardB.snapshot();
  assert(snap.pendingChannels.reduce((sum, group) => sum + group.durationMs, 0) === 70000,
    "individual channel discard preserves different IDs and ambiguous name-only credit");
  assert(JSON.stringify(snap.batches) === queuedBeforeDiscard, "channel discard leaves outgoing batches unchanged");
  assert(snap.records.find(record => record.id === "discard-A").consumedMs === 20000,
    "discard consumes the recorded prefix without deleting cumulative history");
  await discardB.record(shared("discard-A", 20000, "A"), config);
  await discardB.record({ ...shared("discard-A", 25000, "A"), intervalStartMs: 120000 }, config);
  snap = await discardA.snapshot();
  const resumed = snap.pendingChannels.find(group => group.channel.id === "A");
  assert(resumed.durationMs === 5000 && resumed.firstPlayMs === 120000,
    "repeated checkpoints cannot resurrect discarded time and continued playback has a fresh start");
  await discardA.discardChannel({ id: "", name: "shared" });
  snap = await discardB.snapshot();
  assert(snap.pendingChannels.length === 2 && snap.pendingChannels.every(group => group.channel.id),
    "name-only discard cannot consume a same-named identified channel");
  results.push("individual channel discard, identity isolation, idempotent history, continued playback");

  const [bulkA, bulkB] = await make();
  const statuses = ["pending", "uncertain", "blocked", "sending", "sent", "dismissed"];
  for (const status of statuses) await bulkA.record(cp(status, 60000, 100000, status), config);
  await bulkA.finalize(config, { force: true, nowMs: 160000 });
  await bulkA.transaction("readwrite", (state, stores) => {
    for (const batch of state.batches) {
      batch.status = batch.channel.id; batch.message = "Existing diagnostic";
      if (batch.status === "sent") batch.togglId = 42;
      stores.batches.put(batch);
    }
    stores.meta.put({ id: "worker", attempts: [160000], quotaUntilMs: 9999999,
      lastCompletedAtMs: 160000, authBlocked: true });
  });
  await bulkB.record(cp("short-unsent", 20000), { ...config, togglWorkspaceId: 0 });
  const bulkBefore = await bulkA.snapshot();
  const transaction = bulkA.transaction.bind(bulkA);
  bulkA.transaction = (mode, operation, readStores) => transaction(mode, (state, stores) => {
    operation(state, stores); throw new Error("Injected discard abort");
  }, readStores);
  let aborted = false;
  try { await bulkA.discardAll(); } catch (error) { aborted = error.message === "Injected discard abort"; }
  bulkA.transaction = transaction;
  assert(aborted && JSON.stringify(await bulkB.snapshot()) === JSON.stringify(bulkBefore),
    "aborted bulk discard cannot partly consume records or dismiss queue entries");
  await bulkA.discardAll();
  snap = await bulkB.snapshot();
  assert(snap.pendingChannels.length === 0 && snap.records.length === bulkBefore.records.length,
    "bulk discard consumes short unbatched time without needing destination setup or deleting history");
  for (const before of bulkBefore.batches) {
    const after = snap.batches.find(batch => batch.id === before.id);
    const expected = ["pending", "uncertain", "blocked"].includes(before.status)
      ? { ...before, status: "dismissed", message: "" } : before;
    assert(JSON.stringify(after) === JSON.stringify(expected), "bulk discard preserves frozen payloads, sending claims, and sent receipts");
    assert(!(await bulkB.retry(after.id)) && !(await bulkB.dismiss(after.id)),
      "stale individual actions cannot retry or discard sending, sent, or discarded entries");
  }
  assert(JSON.stringify(snap.meta) === JSON.stringify(bulkBefore.meta.map(item => ({ ...item, authBlocked: false }))),
    "discard clears the dismissed auth block while retaining request attempts, spacing, and quota state");
  await bulkA.discardAll();
  assert(JSON.stringify(await bulkB.snapshot()) === JSON.stringify(snap), "repeated bulk discard is idempotent without new playback");
  results.push("atomic bulk discard, aborted transaction, protected sending/receipts, retained quota, stale actions");

  for (const claimFirst of [false, true]) {
    const [raceA, raceB] = await make();
    await raceA.record(cp("race", 60000), config);
    await raceA.finalize(config, { force: true, nowMs: 160000 });
    const id = (await raceA.snapshot()).batches[0].id;
    const actions = claimFirst ? [() => raceA.claim(config, 200000), () => raceB.discardAll()]
      : [() => raceB.discardAll(), () => raceA.claim(config, 200000)];
    await Promise.all(actions.map(action => action()));
    const batch = (await raceB.snapshot()).batches[0];
    assert(batch.status === (claimFirst ? "sending" : "dismissed"), "claim and bulk discard serialize across connections");
    assert(!(await raceB.dismiss(id)), "individual discard cannot override a concurrent claim or resurrect a discarded entry");
  }
  for (const finalizeFirst of [false, true]) {
    const [raceA, raceB] = await make();
    await raceA.record(cp("race", 60000), config);
    const actions = finalizeFirst ? [() => raceA.finalize(config, { force: true }), () => raceB.discardAll()]
      : [() => raceB.discardAll(), () => raceA.finalize(config, { force: true })];
    await Promise.all(actions.map(action => action()));
    snap = await raceA.snapshot();
    assert(snap.pendingChannels.length === 0 && snap.batches.every(batch => batch.status === "dismissed"),
      "concurrent finalize cannot leave discarded time available for delivery");
  }
  results.push("cross-connection discard races with delivery claims and batch allocation");

  const dayConfig = { ...config, dayBoundary: "04:00", inactivityMinutes: 120 };
  const earlyStart = new Date(2026, 8, 11, 3, 50).getTime();
  const laterStart = new Date(2026, 8, 11, 4, 10).getTime();
  const previousEvening = new Date(2026, 8, 10, 23, 59).toISOString();
  const [dayA, dayB] = await make();
  await dayA.record(cp("early", 20000, earlyStart), dayConfig);
  await dayB.record(cp("later", 50000, laterStart), dayConfig);
  const closeAt = laterStart + 50000 + 120 * 60000;
  await dayA.finalize(dayConfig, { nowMs: closeAt - 1 });
  assert((await dayB.snapshot()).batches.length === 0, "day attribution does not change the inactivity boundary");
  await dayA.finalize(dayConfig, { nowMs: closeAt });
  snap = await dayB.snapshot();
  const dayBatch = snap.batches[0];
  assert(snap.batches.length === 1 && dayBatch.start === previousEvening && dayBatch.duration === 70 && dayBatch.durationMs === 70000,
    "same-channel batch shifts its earliest included start while retaining all summed playback");
  assert(snap.records.find(record => record.id === "early").firstPlayMs === earlyStart &&
    snap.records.find(record => record.id === "later").firstPlayMs === laterStart &&
    dayBatch.sources.find(source => source.recordId === "early").startMs === earlyStart &&
    dayBatch.sources.find(source => source.recordId === "later").startMs === laterStart,
    "day attribution preserves original viewing and source timestamps");
  const daySources = JSON.stringify(dayBatch.sources);
  const offConfig = { ...dayConfig, dayBoundary: null };
  await dayB.finalize(offConfig, { force: true, nowMs: closeAt });
  let dayNow = closeAt + 10000;
  const dayRequests = [];
  const dayWorker = new TogglWorker(dayB, offConfig, { locks, now: () => dayNow,
    sleep: async ms => { dayNow += ms; }, send: async (entry, destination) => {
      dayRequests.push(API.buildTogglRequest(entry, destination).body);
      return dayRequests.length === 1 ? { type: "timeout" }
        : { type: "response", status: 200, responseText: '{"id":77}' };
    } });
  await dayWorker.kick();
  assert((await dayA.snapshot()).batches[0].status === "uncertain", "shifted interrupted delivery still requires explicit retry");
  assert(await dayA.retry(dayBatch.id), "shifted uncertain batch can be explicitly retried");
  await dayWorker.kick();
  snap = await dayA.snapshot();
  assert(dayRequests.length === 2 && dayRequests.every(body => body.start === previousEvening && body.duration === 70) &&
    snap.batches[0].status === "sent" && snap.batches[0].start === previousEvening && JSON.stringify(snap.batches[0].sources) === daySources,
    "configuration changes and retry preserve the frozen shifted start, duration, and membership through delivery");
  const prefixStart = new Date(2026, 8, 11, 7, 0).getTime();
  await dayA.record({ ...cp("early", 80000, earlyStart), intervalStartMs: prefixStart,
    lastEligibleAtMs: prefixStart + 60000 }, dayConfig);
  await dayA.finalize(dayConfig, { force: true, nowMs: prefixStart + 60000 });
  const prefixBatch = (await dayB.snapshot()).batches.find(batch => batch.id !== dayBatch.id);
  assert(prefixBatch.start === new Date(prefixStart).toISOString() && prefixBatch.duration === 60 &&
    prefixBatch.sources[0].startMs === prefixStart,
    "post-consumption playback uses its new pending start after the cutoff instead of the video's original early start");
  results.push("local day attribution at allocation, original timestamps, frozen delivery/retry, fresh prefix starts");

  const [invalidDay] = await make();
  const invalidDayConfig = { ...dayConfig, dayBoundary: "24:00" };
  await invalidDay.record(cp("invalid-day", 60000, earlyStart), invalidDayConfig);
  await invalidDay.finalize(invalidDayConfig, { force: true, nowMs: closeAt });
  snap = await invalidDay.snapshot();
  assert(snap.batches.length === 0 && snap.pendingChannels[0].durationMs === 60000 && snap.records[0].consumedMs === 0,
    "invalid day boundary cannot freeze or consume uploadable credit");
  await invalidDay.record(cp("invalid-day", 90000, earlyStart), invalidDayConfig);
  await invalidDay.finalize(dayConfig, { force: true, nowMs: closeAt });
  snap = await invalidDay.snapshot();
  assert(snap.batches.length === 1 && snap.batches[0].start === previousEvening && snap.batches[0].duration === 90 &&
    snap.pendingChannels.length === 0,
    "recording continues during invalid day configuration and correction freezes all retained credit");
  results.push("invalid day configuration retains playback until corrected");

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
