// This checks the built Linux image, not injected test fixtures: Debian Chromium
// must produce a real Lighthouse report and SQLite must survive a container restart.
// Run after `docker build -t site-inspector-smoke:ci .`:
//   node scripts/smoke-deployment.mjs site-inspector-smoke:ci
// Only a fresh, explicitly named CI container/volume is removed. No deployment,
// credentials, local history, fixed score targets, or exact timing targets are used.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const exec = promisify(execFile);
const image = process.argv[2] || "site-inspector-smoke:ci";
const run = `${process.env.GITHUB_RUN_ID || Date.now()}-${process.env.GITHUB_RUN_ATTEMPT || process.pid}`;
const container = process.env.SMOKE_CONTAINER || `site-inspector-smoke-${run}`;
const volume = process.env.SMOKE_VOLUME || `site-inspector-smoke-data-${run}`;
assert.match(container, /^site-inspector-smoke-[a-zA-Z0-9_-]+$/, "Use a fresh CI container name.");
assert.match(volume, /^site-inspector-smoke-data-[a-zA-Z0-9_-]+$/, "Use a fresh CI volume name.");

const origin = "http://127.0.0.1:3000";
const base = origin;
const stop = new AbortController();
let containerMayExist = false;
let volumeMayExist = false;
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => stop.abort(new Error(`Smoke check interrupted by ${signal}.`)));

async function docker(args, abortable = true) {
  return exec("docker", args, { timeout: 60_000, maxBuffer: 1024 * 1024, ...(abortable ? { signal: stop.signal } : {}) });
}
async function exists(kind, name) {
  try { await docker([kind, "inspect", name]); return true; }
  catch (error) { if (error.code === 1) return false; throw error; }
}
async function json(path, options = {}, timeout = 5000) {
  // Keep the request URL, native Host header, Origin, and APP_ORIGIN identical.
  // Node's fetch must not need a Host override to exercise the origin boundary.
  const response = await fetch(`${base}${path}`, {
    ...options,
    signal: AbortSignal.any([stop.signal, AbortSignal.timeout(Math.max(1, timeout))]),
  });
  if (!response.ok) {
    let detail = "";
    try {
      const body = await response.json();
      if (typeof body.error === "string") detail = ` ${body.error.slice(0, 500)}`;
    } catch { /* Non-JSON responses still report their HTTP status. */ }
    throw new Error(`${path} returned HTTP ${response.status}.${detail}`);
  }
  return response.json();
}
async function healthy() {
  const deadline = Date.now() + 60_000;
  let last = "No response.";
  while (Date.now() < deadline) {
    stop.signal.throwIfAborted();
    try { if ((await json("/api/health", {}, Math.min(5000, deadline - Date.now()))).status === "ok") return; }
    catch (error) { last = error.message; }
    await delay(Math.min(1000, Math.max(0, deadline - Date.now())), undefined, { signal: stop.signal });
  }
  throw new Error(`The container did not become healthy within 60 seconds. ${last}`);
}
async function completed(id) {
  const deadline = Date.now() + 180_000;
  let last = "Waiting for the audit.";
  let previous;
  while (Date.now() < deadline) {
    stop.signal.throwIfAborted();
    let audit;
    try { audit = (await json(`/api/audits/${encodeURIComponent(id)}`, {}, Math.min(5000, deadline - Date.now()))).audit; }
    catch (error) { last = error.message; }
    if (audit) {
      last = `${audit.status}; ${audit.message}`;
      if (audit.status !== previous) { console.info(`Audit status: ${audit.status}`); previous = audit.status; }
      if (audit.status === "completed") return audit;
      if (["failed", "interrupted"].includes(audit.status)) throw new Error(`The smoke audit ${audit.status}: ${audit.error || audit.message}`);
    }
    await delay(Math.min(1500, Math.max(0, deadline - Date.now())), undefined, { signal: stop.signal });
  }
  throw new Error(`The audit did not complete within 180 seconds. ${last}`);
}
function verifyLighthouse(audit) {
  assert.equal(audit.status, "completed");
  assert.equal(audit.maxPages, 1);
  assert.equal(audit.pages.length, 1, "The smoke audit must contain a real crawled page.");
  assert.equal(audit.pages[0].statusCode, 200);
  assert.ok(audit.pages[0].parsed, "The homepage HTML must have been parsed.");
  const report = audit.lighthouse;
  assert.equal(report?.status, "completed", `Lighthouse must run successfully in Debian: ${report?.error || "no result"}`);
  assert.equal(report.homepageUrl, "https://example.com/");
  for (const field of ["performance", "accessibility", "bestPractices", "seo"]) {
    const value = report.scores?.[field];
    assert.ok(typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100, `Missing numeric Lighthouse ${field} score.`);
  }
  for (const field of ["lcpMs", "cls", "tbtMs"]) {
    const value = report.metrics?.[field];
    assert.ok(typeof value === "number" && Number.isFinite(value) && value >= 0, `Missing numeric Lighthouse ${field} metric.`);
  }
}

try {
  const engine = await docker(["info", "--format", "{{.OSType}}"]);
  assert.equal(engine.stdout.trim(), "linux", "This smoke check requires a Linux Docker engine.");
  assert.equal(await exists("container", container), false, "Refusing to reuse an existing container.");
  assert.equal(await exists("volume", volume), false, "Refusing to reuse an existing volume or history.");
  volumeMayExist = true;
  await docker(["volume", "create", volume]);
  containerMayExist = true;
  await docker(["run", "--detach", "--name", container, "--publish", "127.0.0.1:3000:3000",
    "--mount", `type=volume,source=${volume},target=/data`,
    "--env", "DATABASE_PATH=/data/seo-analyzer.db", "--env", `APP_ORIGIN=${origin}`,
    "--env", "APP_HOST=0.0.0.0", "--env", "PORT=3000", image]);
  await healthy();
  const created = await json("/api/audits", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ url: "https://example.com/", maxPages: 1 }) });
  assert.match(created.audit?.id || "", /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i);
  const audit = await completed(created.audit.id);
  verifyLighthouse(audit);
  console.info("Real Debian Chromium/Lighthouse scores and metrics verified.");

  await docker(["restart", "--time", "15", container]);
  await healthy();
  const retained = (await json(`/api/audits/${audit.id}`)).audit;
  verifyLighthouse(retained);
  // Compare the stored snapshot, not a fixed performance score or timing budget.
  assert.equal(retained.id, audit.id);
  assert.deepEqual(retained.pages, audit.pages);
  assert.deepEqual(retained.issues, audit.issues);
  assert.deepEqual(retained.lighthouse, audit.lighthouse);
  assert.ok((await json("/api/audits")).audits.some(item => item.id === audit.id), "The completed audit must remain in history after restart.");
  await docker(["exec", container, "node", "--input-type=module", "-e",
    "import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync('/data/seo-analyzer.db', { readOnly: true }); try { if (db.prepare('SELECT status FROM audits WHERE id = ?').get(process.argv[1])?.status !== 'completed') throw new Error('Persisted SQLite audit row is missing.'); } finally { db.close(); }",
    audit.id]);
  console.info("SQLite audit, pages, issues, and Lighthouse snapshot survived the container restart.");
} catch (error) {
  console.error(error.message);
  if (containerMayExist) {
    const logs = await docker(["logs", "--tail", "150", container], false).catch(() => null);
    if (logs) { console.error(logs.stdout); console.error(logs.stderr); }
  }
  process.exitCode = 1;
} finally {
  if (containerMayExist) await docker(["rm", "--force", container], false).catch(() => undefined);
  if (volumeMayExist) await docker(["volume", "rm", volume], false).catch(() => undefined);
}
