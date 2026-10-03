import { crawlSite } from "@/crawler/crawl";
import { normalizeUrl, siteHostname } from "@/crawler/url";
import { resolvePublicAddress, UnsafeUrlError } from "@/crawler/security";
import { getRepository } from "@/database";
import { generateIssues } from "@/issues/generate";
import { analyzeHomepage, unavailableLighthouse } from "@/lighthouse";
import type { AuditRepository } from "@/database";
import type { AuditSummary } from "@/shared/types";

interface RuntimeState { initialized: boolean; activeId: string | null; reserving: boolean }
const globalState = globalThis as typeof globalThis & { __siteInspectorRuntime?: RuntimeState };

function runtimeState(): RuntimeState {
  if (!globalState.__siteInspectorRuntime) globalState.__siteInspectorRuntime = { initialized: false, activeId: null, reserving: false };
  const state = globalState.__siteInspectorRuntime;
  if (!state.initialized) {
    getRepository().interruptRunningAudits();
    state.initialized = true;
  }
  return state;
}
export function auditRepository() { runtimeState(); return getRepository(); }

export class AuditInputError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); this.name = "AuditInputError"; }
}

/** Reserve before DNS resolution to prevent overlapping requests from starting two crawls. */
export async function prepareAudit(input: unknown, requestedMax: unknown = 100): Promise<AuditSummary> {
  const state = runtimeState();
  if (state.activeId || state.reserving) throw new AuditInputError("An audit is already running. Wait for it to finish before starting another.", 409);
  if (typeof input !== "string" || input.length > 2048) throw new AuditInputError("Enter a valid URL or domain.");
  const startUrl = normalizeUrl(input);
  if (!startUrl) throw new AuditInputError("Enter a valid HTTP/HTTPS URL without credentials.");
  if (typeof requestedMax !== "number" || !Number.isInteger(requestedMax) || requestedMax < 1 || requestedMax > 100) {
    throw new AuditInputError("The page limit must be a whole number between 1 and 100.");
  }
  state.reserving = true;
  try {
    await resolvePublicAddress(startUrl);
    const audit = getRepository().createAudit(startUrl, siteHostname(startUrl), requestedMax);
    state.activeId = audit.id;
    return audit;
  } catch (error) {
    if (error instanceof UnsafeUrlError) throw new AuditInputError(error.message);
    if (error instanceof Error && /(?:ENOTFOUND|EAI_AGAIN|Domain resolution timed out)/.test(error.message)) {
      throw new AuditInputError("Unable to resolve the domain. Check the URL and your connection.");
    }
    throw error;
  } finally { state.reserving = false; }
}

interface AuditExecutionDependencies {
  repository: Pick<AuditRepository, "updateProgress" | "savePage" | "saveCrawlResult" | "finishAudit" | "failAudit">;
  crawl: typeof crawlSite;
  lighthouse: typeof analyzeHomepage;
  issues: typeof generateIssues;
}

/** Next's after() owns the lifetime. Browser analysis cannot fail the saved SEO audit. */
export async function executeAudit(audit: AuditSummary, dependencies: Partial<AuditExecutionDependencies> = {}): Promise<void> {
  const repository = dependencies.repository ?? getRepository();
  try {
    repository.updateProgress(audit.id, { status: "running", progress: 1, message: "Starting SEO audit…" });
    const result = await (dependencies.crawl ?? crawlSite)(audit.startUrl, {
      maxPages: audit.maxPages,
      onPage: page => repository.savePage(audit.id, page),
      onProgress: (progress, message) => repository.updateProgress(audit.id, { progress: Math.min(90, progress * 0.9), message }),
    });
    const issues = (dependencies.issues ?? generateIssues)({ ...result, startUrl: audit.startUrl, domain: audit.domain });
    repository.saveCrawlResult(audit.id, result, issues);
    repository.updateProgress(audit.id, { progress: 92, message: "Running homepage Lighthouse analysis…" });
    let lighthouse;
    try { lighthouse = await (dependencies.lighthouse ?? analyzeHomepage)(audit.startUrl); }
    catch (error) { lighthouse = unavailableLighthouse(audit.startUrl, error instanceof Error ? error.message : "The homepage performance check failed."); }
    repository.updateProgress(audit.id, { progress: 98, message: "Saving the audit report…" });
    repository.finishAudit(audit.id, result, issues, lighthouse);
  } catch (error) {
    repository.failAudit(audit.id, error instanceof Error ? error.message : "An unexpected error occurred during the audit.");
  } finally {
    const state = globalState.__siteInspectorRuntime;
    if (state?.activeId === audit.id) state.activeId = null;
  }
}
