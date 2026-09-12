#!/usr/bin/env node
"use strict";

// Real IndexedDB and DOM verification, without a browser automation dependency.
const { createServer } = require("node:http");
const { mkdtemp, readFile, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { spawn } = require("node:child_process");
const { randomBytes } = require("node:crypto");

const root = resolve(__dirname, "..");
const token = randomBytes(24).toString("hex");
const timeoutMs = 45_000;
const resources = new Map([
  ["/yt-toggl.user.js", join(root, "yt-toggl.user.js")],
  ["/ledger-cases.js", join(__dirname, "ledger-cases.js")],
  ["/browser-ui-cases.js", join(__dirname, "browser-ui-cases.js")],
  ["/browser-runtime-cases.js", join(__dirname, "browser-runtime-cases.js")],
]);

const page = `<!doctype html><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline'; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:">
<title>yt-toggl browser smoke</title>
<body><div id="fixture"></div><script>
globalThis.module = { exports: {} };
let reported = false;
const errorText = error => String(error) + (error?.stack ? '\\n' + error.stack : '');
async function report(result) {
  if (reported) return;
  reported = true;
  await fetch('/result/${token}', { method: 'POST', body: JSON.stringify(result) });
}
addEventListener('error', event => report({ ok: false, error: errorText(event.error || event.message || 'Script failed to load') }), true);
addEventListener('unhandledrejection', event => report({ ok: false, error: errorText(event.reason) }));
async function loadScript(src) {
  await new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error('Unable to load ' + src));
    document.head.append(script);
  });
}
(async () => {
  const completed = {};
  try {
    await loadScript('/yt-toggl.user.js');
    const API = module.exports;
    if (typeof API.VideoLedger !== 'function') throw new Error('VideoLedger export is missing');
    if (!globalThis.indexedDB) throw new Error('Native IndexedDB is unavailable');
    await loadScript('/ledger-cases.js');
    if (typeof globalThis.runLedgerCases !== 'function') throw new Error('runLedgerCases is missing');
    const ledger = await globalThis.runLedgerCases(API);
    completed.ledger = ledger;
    await loadScript('/browser-ui-cases.js');
    if (typeof globalThis.runBrowserUiCases !== 'function') throw new Error('runBrowserUiCases is missing');
    const ui = await globalThis.runBrowserUiCases(API);
    completed.ui = ui;
    await loadScript('/browser-runtime-cases.js');
    const runtime = await globalThis.runBrowserRuntimeCases(API);
    await report({ ok: true, ledger, ui, runtime });
  } catch (error) { await report({ ok: false, error: errorText(error), completed }); }
})();
</script>`;

async function main() {
  let profile;
  let firefox;
  let timer;
  let browserOutput = "";
  let resolveResult;
  let rejectResult;
  const result = new Promise((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  // Startup errors can arrive before the main flow starts awaiting the result.
  result.catch(() => {});
  const server = createServer(async (request, response) => {
    try {
      if (request.method === "POST" && request.url === `/result/${token}`) {
        let body = "";
        for await (const part of request) {
          body += part;
          if (body.length > 64 * 1024) throw new Error("Oversized browser result");
        }
        const payload = JSON.parse(body);
        response.writeHead(200).end("ok");
        resolveResult(payload);
        return;
      }
      if (request.method === "GET" && request.url === "/") {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(page);
        return;
      }
      const file = resources.get(request.url);
      if (request.method === "GET" && file) {
        const source = await readFile(file);
        response.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" }).end(source);
        return;
      }
      response.writeHead(404).end("Not found");
    } catch (error) {
      response.writeHead(500).end(String(error.message));
      rejectResult(error);
    }
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    profile = await mkdtemp(join(tmpdir(), "yt-toggl-firefox-"));
    const url = `http://127.0.0.1:${server.address().port}/`;
    firefox = spawn(process.env.FIREFOX_BIN || "/usr/bin/firefox", [
      "--headless", "--no-remote", "--profile", profile, url,
    ], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    for (const stream of [firefox.stdout, firefox.stderr]) {
      stream.on("data", part => { browserOutput = (browserOutput + part).slice(-12_000); });
    }
    firefox.once("error", rejectResult);
    firefox.once("exit", (code, signal) => {
      rejectResult(new Error(`Firefox exited before reporting (code=${code}, signal=${signal})`));
    });
    timer = setTimeout(() => rejectResult(new Error(`Browser smoke timed out after ${timeoutMs}ms`)), timeoutMs);
    const payload = await result;
    if (payload.ok !== true) {
      if (payload.completed && Object.keys(payload.completed).length) {
        console.error("Completed before failure:", JSON.stringify(payload.completed));
      }
      throw new Error(payload.error || "Browser smoke failed without details");
    }
    console.log("Firefox native IndexedDB + DOM smoke passed:", JSON.stringify(payload));
  } catch (error) {
    if (browserOutput) console.error(browserOutput.trim());
    throw error;
  } finally {
    clearTimeout(timer);
    if (firefox?.pid) {
      const exited = new Promise(resolve => {
        if (firefox.exitCode !== null || firefox.signalCode !== null) resolve();
        else firefox.once("exit", resolve);
      });
      // The detached process group belongs exclusively to this spawned browser.
      try { process.kill(-firefox.pid, "SIGKILL"); }
      catch (error) { if (error.code !== "ESRCH") console.error(error.message); }
      await exited;
    }
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    // This fresh profile contains only this run's disposable fixture data.
    if (profile) await rm(profile, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
