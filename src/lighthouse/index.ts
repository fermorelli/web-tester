import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { normalizeUrl } from "@/crawler/url";
import { resolvePublicAddress } from "@/crawler/security";
import type { LighthouseResult } from "@/shared/types";
import { startLighthouseProxy } from "./proxy";
import { explainLighthouseFailure, lighthouseMemory, type LighthouseMemory } from "./diagnostics";

export function homepageUrl(input: string): string {
  const normalized = normalizeUrl(input);
  if (!normalized) throw new Error("The homepage URL is invalid.");
  return new URL("/", normalized).href;
}

export function lighthouseTimeout(): number {
  const configured = Number(process.env.LIGHTHOUSE_TIMEOUT_MS || 120_000);
  return Number.isFinite(configured) ? Math.min(180_000, Math.max(10_000, Math.floor(configured))) : 120_000;
}

export function unavailableLighthouse(input: string, error: string): LighthouseResult {
  return {
    status: "unavailable", homepageUrl: homepageUrl(input), finalUrl: null,
    analyzedAt: new Date().toISOString(), version: null, device: "mobile", scores: null, metrics: null,
    warnings: [], error: error.slice(0, 1000),
  };
}

interface MinimalLhr {
  runtimeError?: { message?: string; code?: string };
  lighthouseVersion?: string;
  finalDisplayedUrl?: string;
  finalUrl?: string;
  categories?: Record<string, { score?: number | null }>;
  audits?: Record<string, { numericValue?: number | null }>;
  runWarnings?: string[];
}

/** Persist just scores and metrics, rather than large Lighthouse traces or report HTML. */
export function parseLighthouseReport(raw: MinimalLhr, input: string): LighthouseResult {
  if (raw.runtimeError) return unavailableLighthouse(input, raw.runtimeError.message || "Lighthouse could not load the homepage.");
  if (!raw.categories || !raw.audits) return unavailableLighthouse(input, "Lighthouse returned an incomplete report.");
  const numeric = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
  const score = (id: string): number | null => {
    const value = numeric(raw.categories?.[id]?.score);
    return value === null ? null : Math.round(Math.min(1, value) * 100);
  };
  const scores = { performance: score("performance"), accessibility: score("accessibility"), bestPractices: score("best-practices"), seo: score("seo") };
  if (Object.values(scores).every(value => value === null)) return unavailableLighthouse(input, "Lighthouse did not return any category scores.");
  return {
    status: "completed", homepageUrl: homepageUrl(input),
    finalUrl: raw.finalDisplayedUrl || raw.finalUrl || homepageUrl(input),
    analyzedAt: new Date().toISOString(), version: raw.lighthouseVersion || null, device: "mobile", scores,
    metrics: {
      lcpMs: numeric(raw.audits["largest-contentful-paint"]?.numericValue),
      cls: numeric(raw.audits["cumulative-layout-shift"]?.numericValue),
      tbtMs: numeric(raw.audits["total-blocking-time"]?.numericValue),
    },
    warnings: (raw.runWarnings || []).filter(value => typeof value === "string").map(value => value.slice(0, 1000)).slice(0, 20), error: null,
  };
}

function chromePath(): string | undefined {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  if (process.platform === "win32") {
    const paths = [
      join(process.env.PROGRAMFILES || "C:\\Program Files", "Google/Chrome/Application/chrome.exe"),
      join(process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Microsoft/Edge/Application/msedge.exe"),
    ];
    return paths.find(path => existsSync(path));
  }
  return undefined; // chrome-launcher detects local Chrome; the container supplies CHROME_PATH.
}

function stopTree(child: ChildProcess, signal: "SIGTERM" | "SIGKILL") {
  if (!child.pid) return;
  if (process.platform === "win32") {
    if (signal === "SIGKILL") {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      killer.on("error", () => { child.kill(); });
    } else child.kill(signal);
  } else {
    try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* Already exited. */ } }
  }
}

async function stopChrome(profile: string) {
  // chrome-launcher creates its own process group, including when launch never becomes ready.
  let pid: number;
  try { pid = Number(await readFile(join(profile, "chrome.pid"), "utf8")); } catch { return; }
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  if (process.platform === "win32") {
    await new Promise<void>(resolve => {
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      killer.once("error", () => resolve());
      killer.once("exit", () => resolve());
    });
  } else {
    try { process.kill(-pid, "SIGKILL"); } catch { /* chrome.kill() already cleaned it up. */ }
  }
}

/** One worker and fresh browser per homepage; never imported or invoked by the crawler. */
export async function analyzeHomepage(input: string): Promise<LighthouseResult> {
  const url = homepageUrl(input);
  let proxy: Awaited<ReturnType<typeof startLighthouseProxy>> | undefined;
  let profile: string | undefined;
  let child: ChildProcess | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let forceTimer: ReturnType<typeof setTimeout> | undefined;
  let memoryBefore: LighthouseMemory | null = null;
  let errorCode: string | null = null;
  const terminate = () => { if (child) stopTree(child, "SIGTERM"); };
  const explainFailure = async (message: string) => {
    const memoryAfter = await lighthouseMemory();
    console.warn("[Lighthouse] Analysis unavailable", JSON.stringify({
      homepage: url, code: errorCode,
      workerExitCode: child?.exitCode ?? null, workerExitSignal: child?.signalCode ?? null,
      memoryBefore, memoryAfter,
    }));
    return explainLighthouseFailure(message, errorCode, memoryBefore, memoryAfter);
  };
  try {
    await resolvePublicAddress(url);
    proxy = await startLighthouseProxy();
    profile = await mkdtemp(join(tmpdir(), "seo-lighthouse-"));
    memoryBefore = await lighthouseMemory();
    console.info("[Lighthouse] Starting homepage analysis", JSON.stringify({ homepage: url, memory: memoryBefore }));
    const timeout = lighthouseTimeout();
    child = spawn(process.execPath, ["--max-old-space-size=512", resolve(process.cwd(), "scripts/lighthouse-worker.mjs")], {
      stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true, detached: process.platform !== "win32",
    });
    const worker = child;
    process.once("SIGTERM", terminate);
    process.once("SIGINT", terminate);
    const raw = await new Promise<MinimalLhr>((resolve, reject) => {
      let report: MinimalLhr | undefined;
      let failure: string | undefined;
      timer = setTimeout(() => {
        failure = `Homepage Lighthouse analysis timed out after ${Math.round(timeout / 1000)} seconds.`;
        terminate();
        forceTimer = setTimeout(() => { stopTree(worker, "SIGKILL"); void stopChrome(profile!); }, 3000);
      }, timeout);
      worker.on("message", message => {
        if (!message || typeof message !== "object") return;
        const value = message as { type?: string; report?: MinimalLhr; error?: string; errorCode?: string };
        if (value.type === "result") report = value.report;
        if (value.type === "error") {
          failure = typeof value.error === "string" ? value.error : "The browser performance check failed.";
          errorCode = typeof value.errorCode === "string" ? value.errorCode.slice(0, 80) : null;
        }
      });
      worker.once("error", error => {
        errorCode = (error as NodeJS.ErrnoException).code?.slice(0, 80) ?? null;
        reject(new Error(`Unable to start the Lighthouse worker: ${error.message}`));
      });
      worker.once("exit", code => {
        if (failure) reject(new Error(failure));
        else if (code !== 0 || !report) reject(new Error("The Lighthouse browser process exited before producing a report."));
        else resolve(report);
      });
      worker.send({ url, proxyUrl: proxy!.url, profile, chromePath: chromePath() }, error => { if (error) reject(error); });
    }).finally(() => { if (timer) clearTimeout(timer); });
    const result = parseLighthouseReport(raw, url);
    errorCode = raw.runtimeError?.code?.slice(0, 80) ?? null;
    if (result.status === "unavailable") result.error = await explainFailure(result.error || "The homepage performance check failed.");
    if (proxy.stats.blockedRequests) result.warnings.push("Browser requests to non-public or unsupported destinations were blocked.");
    if (proxy.stats.limitedRequests) result.warnings.push("Some browser resources exceeded the analysis network limits.");
    return result;
  } catch (error) {
    return unavailableLighthouse(url, await explainFailure(error instanceof Error ? error.message : "The homepage performance check failed."));
  } finally {
    if (timer) clearTimeout(timer);
    if (forceTimer) clearTimeout(forceTimer);
    process.removeListener("SIGTERM", terminate);
    process.removeListener("SIGINT", terminate);
    if (child && child.exitCode === null && child.signalCode === null) stopTree(child, "SIGKILL");
    if (profile) await stopChrome(profile);
    if (proxy) await proxy.close();
    if (profile) await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => undefined);
  }
}
