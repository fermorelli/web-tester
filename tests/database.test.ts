import { mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuditRepository } from "@/database";
import { issueCatalog } from "@/issues/catalog";
import { parsePage } from "@/parsers/page";
import type { CrawlResult, Issue, LighthouseResult, PageAnalysis } from "@/shared/types";

function page(url = "https://example.com/", overrides: Partial<PageAnalysis> = {}): PageAnalysis {
  return {
    url,
    finalUrl: url,
    statusCode: 200,
    redirects: [],
    contentType: "text/html",
    responseTimeMs: 12,
    error: null,
    blockedByRobots: false,
    depth: 0,
    inSitemap: true,
    discoveredFrom: [],
    fetchedAt: "2026-10-03T12:00:00.000Z",
    indexable: true,
    parsed: null,
    ...overrides,
  };
}

const issue: Issue = {
  id: "missing-title",
  name: "Missing title",
  category: "Metadata",
  severity: "high",
  description: "No title was found.",
  whyItMatters: "The title identifies the page.",
  recommendation: "Add a descriptive title.",
  affectedUrls: ["https://example.com/"],
  evidence: [{ url: "https://example.com/", detail: "No <title> element." }],
};

function result(pages = [page()]): CrawlResult {
  return {
    pages,
    relationships: [{ source: "https://example.com/", target: "https://example.com/about", nofollow: false, text: "Nosotros" }],
    robots: { url: "https://example.com/robots.txt", found: true, statusCode: 200, body: "User-agent: *\nDisallow: /private", error: null, warnings: [] },
    sitemap: { found: true, urls: pages.map((item) => item.url), documents: ["https://example.com/sitemap.xml"], error: null, truncated: false },
    limits: { maxPages: 50, concurrency: 3, timeoutMs: 10000, maxResponseBytes: 2000000, maxRedirects: 5, maxImageChecks: 20 },
    warnings: ["The configured image check limit was reached."],
  };
}

function lighthouse(overrides: Partial<LighthouseResult> = {}): LighthouseResult {
  return {
    status: "completed", homepageUrl: "https://example.com/", finalUrl: "https://example.com/",
    analyzedAt: "2026-10-03T12:00:00.000Z", version: "13.5.0", device: "mobile",
    scores: { performance: 71, accessibility: 96, bestPractices: 100, seo: 92 },
    metrics: { lcpMs: 2500, cls: 0.03, tbtMs: 150 }, warnings: ["One mobile lab run; scores can vary."], error: null,
    ...overrides,
  };
}

describe("AuditRepository", () => {
  let directory: string;
  let databasePath: string;
  let repository: AuditRepository;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "site-inspector-db-test-"));
    databasePath = join(directory, "audits.sqlite");
    repository = new AuditRepository(databasePath);
  });

  afterEach(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("persists a complete crawl and its evidence across connection restarts", () => {
    const audit = repository.createAudit("https://example.com/", "example.com", 50);
    const crawl = result([page(), page("https://example.com/about", { depth: 1, discoveredFrom: ["https://example.com/"] })]);
    repository.updateProgress(audit.id, { status: "running", progress: 25, message: "Procesando" });
    repository.finishAudit(audit.id, crawl, [issue]);
    repository.close();
    repository = new AuditRepository(databasePath);

    const saved = repository.getAudit(audit.id)!;
    expect(saved).toMatchObject({
      id: audit.id, status: "completed", crawledPages: 2, errorPages: 0, issueCount: 1, progress: 100,
      pages: crawl.pages, relationships: crawl.relationships, issues: [issue],
      robots: crawl.robots, sitemap: crawl.sitemap, limits: crawl.limits, warnings: crawl.warnings,
    });
    expect(saved.completedAt).not.toBeNull();
    expect(repository.getAudit("nonexistent")).toBeNull();
  });

  it("keeps contextual observations out of issue counts and persists the selected scope", () => {
    const audit = repository.createAudit("https://example.com/portfolio/", "example.com", 50);
    const crawl = result([page("https://example.com/portfolio/")]);
    crawl.limits.scope = { kind: "path", rootUrl: audit.startUrl };
    crawl.limits.analysisVersion = 2;
    const observation: Issue = { ...issue, id: "canonical_missing", ...issueCatalog.canonical_missing, kind: "observation" };
    repository.finishAudit(audit.id, crawl, [issue, observation]);
    repository.close();
    repository = new AuditRepository(databasePath);
    expect(repository.listAudits()[0]).toMatchObject({ issueCount: 1, observationCount: 1, analysisVersion: 2 });
    expect(repository.getAudit(audit.id)).toMatchObject({
      issueCount: 1, observationCount: 1, limits: { scope: { kind: "path", rootUrl: audit.startUrl }, analysisVersion: 2 },
      issues: expect.arrayContaining([expect.objectContaining({ id: "canonical_missing", kind: "observation" })]),
    });
  });

  it("presents legacy observation counts consistently without rewriting their saved counts", () => {
    const audit = repository.createAudit("https://example.com/", "example.com", 50);
    const observation: Issue = { ...issue, id: "canonical_missing", ...issueCatalog.canonical_missing };
    repository.finishAudit(audit.id, result(), [observation]);
    const inspect = new DatabaseSync(databasePath);
    inspect.prepare("UPDATE audits SET issue_count = 1 WHERE id = ?").run(audit.id);
    expect(repository.listAudits()[0]).toMatchObject({ issueCount: 0, observationCount: 1, analysisVersion: 0 });
    expect(repository.getAudit(audit.id)).toMatchObject({ issueCount: 0, observationCount: 1 });
    expect(inspect.prepare("SELECT issue_count FROM audits WHERE id = ?").get(audit.id)).toEqual({ issue_count: 1 });
    inspect.close();
  });

  it("keeps separate histories for each site with bounded newest-first listing", () => {
    const first = repository.createAudit("https://example.com/", "example.com", 10);
    const second = repository.createAudit("https://example.com/about", "example.com", 20);
    const other = repository.createAudit("https://other.example/", "other.example", 5);
    expect(repository.listAudits(2).map((audit) => audit.id)).toEqual([other.id, second.id]);
    expect(repository.listSiteAudits("example.com").map((audit) => audit.id)).toEqual([second.id, first.id]);
    expect(repository.listSiteAudits("other.example")).toHaveLength(1);
    expect(repository.listSiteAudits("missing.example")).toEqual([]);

    const inspect = new DatabaseSync(databasePath);
    expect(inspect.prepare("SELECT COUNT(*) AS count FROM sites").get()).toEqual({ count: 2 });
    inspect.close();
  });

  it("exposes partial pages while running and updates repeated URLs without duplicating them", () => {
    const audit = repository.createAudit("https://example.com/", "example.com", 50);
    repository.updateProgress(audit.id, { status: "running", progress: 40 });
    repository.savePage(audit.id, page());
    repository.savePage(audit.id, page("https://example.com/broken", { statusCode: 503, indexable: false }));
    expect(repository.getAudit(audit.id)).toMatchObject({ status: "running", crawledPages: 2, errorPages: 1, progress: 40 });
    repository.savePage(audit.id, page("https://example.com/broken", { statusCode: 200 }));
    const saved = repository.getAudit(audit.id)!;
    expect(saved.pages.map((item) => item.url)).toEqual(["https://example.com/", "https://example.com/broken"]);
    expect(saved.crawledPages).toBe(2);
    expect(saved.errorPages).toBe(0);
    expect(saved.robots).toBeNull();
  });

  it("rolls back the entire final snapshot when one inserted issue fails", () => {
    const audit = repository.createAudit("https://example.com/", "example.com", 50);
    const partial = page("https://example.com/partial");
    repository.updateProgress(audit.id, { status: "running" });
    repository.savePage(audit.id, partial);
    expect(() => repository.finishAudit(audit.id, result(), [issue, issue])).toThrow();
    const saved = repository.getAudit(audit.id)!;
    expect(saved.status).toBe("running");
    expect(saved.pages).toEqual([partial]);
    expect(saved.issues).toEqual([]);
    expect(saved.relationships).toEqual([]);
    expect(saved.robots).toBeNull();
    expect(saved.completedAt).toBeNull();
  });

  it("retains partial data after failure and interrupts only unfinished audits on restart", () => {
    const failed = repository.createAudit("https://example.com/failed", "example.com", 50);
    const failedPage = page("https://example.com/failed", { error: "Incomplete response", statusCode: null });
    repository.savePage(failed.id, failedPage);
    repository.failAudit(failed.id, "The server closed the connection.");
    const running = repository.createAudit("https://example.com/running", "example.com", 50);
    repository.updateProgress(running.id, { status: "running", progress: 20 });
    repository.savePage(running.id, page("https://example.com/running"));
    const queued = repository.createAudit("https://example.com/queued", "example.com", 50);
    const completed = repository.createAudit("https://example.com/completed", "example.com", 50);
    repository.finishAudit(completed.id, result(), []);

    expect(repository.interruptRunningAudits()).toBe(2);
    expect(repository.interruptRunningAudits()).toBe(0);
    expect(repository.getAudit(failed.id)).toMatchObject({ status: "failed", error: "The server closed the connection.", pages: [failedPage], errorPages: 1 });
    expect(repository.getAudit(running.id)).toMatchObject({ status: "interrupted", crawledPages: 1, progress: 20 });
    expect(repository.getAudit(queued.id)?.status).toBe("interrupted");
    expect(repository.getAudit(completed.id)?.status).toBe("completed");
  });

  it("uses foreign keys and parameterized SQL to isolate audits", () => {
    const domain = "example.com'; DROP TABLE audits; --";
    const audit = repository.createAudit("https://example.com/", domain, 10);
    expect(repository.listSiteAudits(domain)[0].id).toBe(audit.id);
    expect(() => repository.savePage("missing-audit", page())).toThrow();
    expect(repository.getAudit(audit.id)?.pages).toEqual([]);
    expect(() => repository.listAudits(-1)).toThrow();
    expect(() => repository.createAudit("https://example.com/", "example.com", 0)).toThrow();
  });

  it("migrates an existing pre-Lighthouse database without losing its history", () => {
    const audit = repository.createAudit("https://example.com/", "example.com", 50);
    repository.finishAudit(audit.id, result(), [issue]);
    repository.close();
    const legacy = new DatabaseSync(databasePath);
    legacy.exec("ALTER TABLE audits DROP COLUMN lighthouse_json");
    legacy.close();

    repository = new AuditRepository(databasePath);
    expect(repository.getAudit(audit.id)).toMatchObject({ status: "completed", pages: [page()], issues: [issue], lighthouse: null });
    repository.saveLighthouse(audit.id, lighthouse());
    repository.close();
    repository = new AuditRepository(databasePath);
    expect(repository.getAudit(audit.id)?.lighthouse).toEqual(lighthouse());
    expect(repository.listAudits()).toHaveLength(1);
  });

  it("persists a complete SEO checkpoint while Lighthouse runs and preserves it after restart", () => {
    const audit = repository.createAudit("https://example.com/", "example.com", 50);
    repository.updateProgress(audit.id, { status: "running", progress: 92, message: "Running Lighthouse on the homepage…" });
    const crawl = result();
    repository.saveCrawlResult(audit.id, crawl, [issue]);
    expect(repository.getAudit(audit.id)).toMatchObject({
      status: "running", progress: 92, completedAt: null, issueCount: 1, pages: crawl.pages,
      issues: [issue], relationships: crawl.relationships, robots: crawl.robots, sitemap: crawl.sitemap,
      limits: crawl.limits, warnings: crawl.warnings, lighthouse: null,
    });
    repository.close();
    repository = new AuditRepository(databasePath);
    expect(repository.interruptRunningAudits()).toBe(1);
    expect(repository.getAudit(audit.id)).toMatchObject({ status: "interrupted", issueCount: 1, pages: crawl.pages, issues: [issue] });
  });

  it.each([lighthouse(), lighthouse({ status: "unavailable", scores: null, metrics: null, finalUrl: null, version: null, error: "Chrome is not available." })])("stores independent Lighthouse outcomes without losing crawl results ($status)", (labResult) => {
    const audit = repository.createAudit("https://example.com/", "example.com", 50);
    const crawl = result();
    repository.finishAudit(audit.id, crawl, [issue], labResult);
    repository.close();
    repository = new AuditRepository(databasePath);
    expect(repository.getAudit(audit.id)).toMatchObject({ status: "completed", lighthouse: labResult, pages: crawl.pages, issues: [issue] });
  });

  it("presents legacy diagnostics and catalog text in English while retaining the original snapshot and website text", () => {
    const audit = repository.createAudit("https://example.com/", "example.com", 50);
    const parsed = parsePage('<html><head><title>Guía para visitar Buenos Aires</title></head><body><h1>Qué hacer en la ciudad</h1><p>Información útil para tu viaje.</p><img src="/foto.jpg" alt="Vista de la ciudad"></body></html>', audit.startUrl);
    const legacyIssue: Issue = { ...issue, id: "title_missing", name: "Title faltante", description: "La página no tiene un title con contenido.", evidence: [{ url: audit.startUrl, detail: "Title ausente o vacío." }] };
    repository.finishAudit(audit.id, result([page(audit.startUrl, { parsed })]), [legacyIssue]);
    const legacy = new DatabaseSync(databasePath);
    try {
      legacy.prepare("UPDATE audits SET message = ? WHERE id = ?").run("Auditoría completada.", audit.id);
      const originalSnapshot = legacy.prepare("SELECT detail_json FROM pages WHERE audit_id = ?").get(audit.id);
      const originalIssue = legacy.prepare("SELECT detail_json FROM issues WHERE audit_id = ?").get(audit.id);

      const presented = repository.getAudit(audit.id)!;
      expect(presented.message).toBe("Audit completed.");
      expect(presented.issues[0]).toMatchObject(issueCatalog.title_missing);
      expect(presented.issues[0].evidence[0].detail).toBe("Title missing or empty.");
      expect(presented.pages[0].parsed?.title).toBe("Guía para visitar Buenos Aires");
      expect(presented.pages[0].parsed?.h1).toEqual(["Qué hacer en la ciudad"]);
      expect(presented.pages[0].parsed?.images[0].alt).toBe("Vista de la ciudad");
      expect(legacy.prepare("SELECT detail_json FROM pages WHERE audit_id = ?").get(audit.id)).toEqual(originalSnapshot);
      expect(legacy.prepare("SELECT detail_json FROM issues WHERE audit_id = ?").get(audit.id)).toEqual(originalIssue);
      expect(legacy.prepare("SELECT message FROM audits WHERE id = ?").get(audit.id)).toEqual({ message: "Auditoría completada." });
    } finally { legacy.close(); }
  });

  it("backs up committed WAL changes while the source connection stays open", () => {
    const audit = repository.createAudit("https://example.com/", "example.com", 50);
    repository.finishAudit(audit.id, result(), [issue], lighthouse());
    const destination = join(directory, "backups", "snapshot.sqlite");
    execFileSync(process.execPath, [join(process.cwd(), "scripts", "backup.mjs"), databasePath, destination], { windowsHide: true, stdio: "pipe" });
    const saved = new AuditRepository(destination);
    try {
      expect(saved.getAudit(audit.id)).toMatchObject({ status: "completed", pages: [page()], issues: [issue], lighthouse: lighthouse() });
      expect(saved.listAudits()).toHaveLength(1);
    } finally { saved.close(); }
    expect(repository.getAudit(audit.id)?.status).toBe("completed");
  });
});
