import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { issueCatalog, type IssueId } from "@/issues/catalog";
import { translateLegacyMessage } from "@/shared/legacy-english";
import type { AuditDetail, AuditSummary, CrawlResult, Issue, LighthouseResult, PageAnalysis } from "@/shared/types";

type AuditRow = {
  id: string;
  domain: string;
  start_url: string;
  status: AuditSummary["status"];
  started_at: string;
  completed_at: string | null;
  updated_at: string;
  crawled_pages: number;
  error_pages: number;
  issue_count: number;
  max_pages: number;
  progress: number;
  message: string;
  error: string | null;
  robots_json: string | null;
  sitemap_json: string | null;
  limits_json: string | null;
  warnings_json: string;
  lighthouse_json: string | null;
};

const SELECT_AUDIT = `SELECT a.*, s.domain FROM audits a JOIN sites s ON s.id = a.site_id`;

function summary(row: AuditRow): AuditSummary {
  return {
    id: row.id,
    domain: row.domain,
    startUrl: row.start_url,
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
    crawledPages: row.crawled_pages,
    errorPages: row.error_pages,
    issueCount: row.issue_count,
    maxPages: row.max_pages,
    progress: row.progress,
    message: translateLegacyMessage(row.message),
    error: row.error === null ? null : translateLegacyMessage(row.error),
  };
}

function historyLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1) throw new Error("The history limit must be a positive integer.");
  return Math.min(value, 500);
}

function pageHasError(page: PageAnalysis): boolean {
  return Boolean(page.error) || (page.statusCode !== null && page.statusCode >= 400);
}

/** Translate application diagnostics on read; never rewrite website content or saved snapshots. */
function presentPage(page: PageAnalysis): PageAnalysis {
  return {
    ...page,
    error: page.error === null ? null : translateLegacyMessage(page.error),
    parsed: page.parsed === null ? null : {
      ...page.parsed,
      jsonLdErrors: page.parsed.jsonLdErrors.map(translateLegacyMessage),
      schemaWarnings: page.parsed.schemaWarnings.map(translateLegacyMessage),
      images: page.parsed.images.map(image => ({ ...image, ...(image.checkError ? { checkError: translateLegacyMessage(image.checkError) } : {}) })),
    },
  };
}

function presentIssue(issue: Issue): Issue {
  const definition = Object.hasOwn(issueCatalog, issue.id) ? issueCatalog[issue.id as IssueId] : null;
  return {
    ...issue,
    ...(definition ?? {}),
    evidence: issue.evidence.map(item => ({ ...item, detail: translateLegacyMessage(item.detail) })),
  };
}

/** Local SQLite persistence. Every audit retains its own immutable crawl snapshot. */
export class AuditRepository {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(resolve(path)), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS sites (
        id INTEGER PRIMARY KEY,
        domain TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audits (
        id TEXT PRIMARY KEY,
        site_id INTEGER NOT NULL REFERENCES sites(id),
        start_url TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'interrupted')),
        started_at TEXT NOT NULL,
        completed_at TEXT,
        updated_at TEXT NOT NULL,
        crawled_pages INTEGER NOT NULL DEFAULT 0,
        error_pages INTEGER NOT NULL DEFAULT 0,
        issue_count INTEGER NOT NULL DEFAULT 0,
        max_pages INTEGER NOT NULL,
        progress REAL NOT NULL DEFAULT 0,
        message TEXT NOT NULL DEFAULT '',
        error TEXT,
        robots_json TEXT,
        sitemap_json TEXT,
        limits_json TEXT,
        warnings_json TEXT NOT NULL DEFAULT '[]',
        lighthouse_json TEXT
      );
      CREATE TABLE IF NOT EXISTS pages (
        audit_id TEXT NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
        url TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        has_error INTEGER NOT NULL DEFAULT 0,
        detail_json TEXT NOT NULL,
        PRIMARY KEY (audit_id, url)
      );
      CREATE TABLE IF NOT EXISTS issues (
        audit_id TEXT NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
        issue_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        detail_json TEXT NOT NULL,
        PRIMARY KEY (audit_id, issue_id)
      );
      CREATE TABLE IF NOT EXISTS crawl_relationships (
        audit_id TEXT NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        source TEXT NOT NULL,
        target TEXT NOT NULL,
        detail_json TEXT NOT NULL,
        PRIMARY KEY (audit_id, ordinal)
      );
      CREATE INDEX IF NOT EXISTS audits_site_started ON audits(site_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS audits_started ON audits(started_at DESC);
      CREATE INDEX IF NOT EXISTS audits_status ON audits(status);
      CREATE INDEX IF NOT EXISTS pages_audit_ordinal ON pages(audit_id, ordinal);
      CREATE INDEX IF NOT EXISTS relationships_target ON crawl_relationships(audit_id, target);
    `);
    const auditColumns = this.db.prepare("PRAGMA table_info(audits)").all() as { name: string }[];
    if (!auditColumns.some(column => column.name === "lighthouse_json")) {
      this.db.exec("ALTER TABLE audits ADD COLUMN lighthouse_json TEXT");
    }
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  createAudit(startUrl: string, domain: string, maxPages: number): AuditSummary {
    if (!Number.isInteger(maxPages) || maxPages < 1) throw new Error("The maximum page count must be a positive integer.");
    const id = randomUUID();
    const now = new Date().toISOString();
    this.transaction(() => {
      this.db.prepare("INSERT INTO sites (domain, created_at) VALUES (?, ?) ON CONFLICT(domain) DO NOTHING").run(domain, now);
      this.db.prepare(`
        INSERT INTO audits (id, site_id, start_url, status, started_at, updated_at, max_pages, message)
        VALUES (?, (SELECT id FROM sites WHERE domain = ?), ?, 'queued', ?, ?, ?, ?)
      `).run(id, domain, startUrl, now, now, maxPages, "Audit queued.");
    });
    const row = this.db.prepare(`${SELECT_AUDIT} WHERE a.id = ?`).get(id) as AuditRow;
    return summary(row);
  }

  listAudits(limit = 30): AuditSummary[] {
    const rows = this.db.prepare(`${SELECT_AUDIT} ORDER BY a.started_at DESC, a.rowid DESC LIMIT ?`).all(historyLimit(limit));
    return (rows as AuditRow[]).map(summary);
  }

  listSiteAudits(domain: string, limit = 30): AuditSummary[] {
    const rows = this.db.prepare(`${SELECT_AUDIT} WHERE s.domain = ? ORDER BY a.started_at DESC, a.rowid DESC LIMIT ?`).all(domain, historyLimit(limit));
    return (rows as AuditRow[]).map(summary);
  }

  getAudit(id: string): AuditDetail | null {
    const row = this.db.prepare(`${SELECT_AUDIT} WHERE a.id = ?`).get(id) as AuditRow | undefined;
    if (!row) return null;
    const readDetails = <T>(table: "pages" | "issues" | "crawl_relationships"): T[] => {
      const rows = this.db.prepare(`SELECT detail_json FROM ${table} WHERE audit_id = ? ORDER BY ordinal`).all(id) as { detail_json: string }[];
      return rows.map((item) => JSON.parse(item.detail_json) as T);
    };
    const robots: AuditDetail["robots"] = row.robots_json === null ? null : JSON.parse(row.robots_json);
    const sitemap: AuditDetail["sitemap"] = row.sitemap_json === null ? null : JSON.parse(row.sitemap_json);
    const lighthouse: LighthouseResult | null = row.lighthouse_json === null ? null : JSON.parse(row.lighthouse_json);
    return {
      ...summary(row),
      lighthouse: lighthouse === null ? null : { ...lighthouse, warnings: lighthouse.warnings.map(translateLegacyMessage), error: lighthouse.error === null ? null : translateLegacyMessage(lighthouse.error) },
      pages: readDetails<PageAnalysis>("pages").map(presentPage),
      issues: readDetails<Issue>("issues").map(presentIssue),
      relationships: readDetails("crawl_relationships"),
      robots: robots === null ? null : { ...robots, error: robots.error === null ? null : translateLegacyMessage(robots.error), warnings: robots.warnings.map(translateLegacyMessage) },
      sitemap: sitemap === null ? null : { ...sitemap, error: sitemap.error === null ? null : translateLegacyMessage(sitemap.error) },
      limits: row.limits_json === null ? null : JSON.parse(row.limits_json),
      warnings: (JSON.parse(row.warnings_json) as string[]).map(translateLegacyMessage),
    };
  }

  updateProgress(id: string, update: Partial<Pick<AuditSummary, "status" | "crawledPages" | "errorPages" | "progress" | "message">>): void {
    const columns = { status: "status", crawledPages: "crawled_pages", errorPages: "error_pages", progress: "progress", message: "message" } as const;
    const assignments = ["updated_at = ?"];
    const values: SQLInputValue[] = [new Date().toISOString()];
    for (const key of Object.keys(columns) as (keyof typeof columns)[]) {
      const value = update[key];
      if (value === undefined) continue;
      assignments.push(`${columns[key]} = ?`);
      values.push(key === "progress" ? Math.max(0, Math.min(100, value as number)) : value);
    }
    this.db.prepare(`UPDATE audits SET ${assignments.join(", ")} WHERE id = ?`).run(...values, id);
  }

  savePage(id: string, page: PageAnalysis): void {
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO pages (audit_id, url, ordinal, has_error, detail_json)
        VALUES (?, ?, (SELECT COALESCE(MAX(ordinal) + 1, 0) FROM pages WHERE audit_id = ?), ?, ?)
        ON CONFLICT(audit_id, url) DO UPDATE SET has_error = excluded.has_error, detail_json = excluded.detail_json
      `).run(id, page.url, id, Number(pageHasError(page)), JSON.stringify(page));
      this.db.prepare(`
        UPDATE audits SET crawled_pages = (SELECT COUNT(*) FROM pages WHERE audit_id = ?),
          error_pages = (SELECT COALESCE(SUM(has_error), 0) FROM pages WHERE audit_id = ?), updated_at = ? WHERE id = ?
      `).run(id, id, new Date().toISOString(), id);
    });
  }

  private writeCrawlResult(id: string, result: CrawlResult, issues: Issue[]): void {
    this.db.prepare("DELETE FROM pages WHERE audit_id = ?").run(id);
    this.db.prepare("DELETE FROM issues WHERE audit_id = ?").run(id);
    this.db.prepare("DELETE FROM crawl_relationships WHERE audit_id = ?").run(id);
    const insertPage = this.db.prepare("INSERT INTO pages (audit_id, url, ordinal, has_error, detail_json) VALUES (?, ?, ?, ?, ?)");
    result.pages.forEach((page, ordinal) => insertPage.run(id, page.url, ordinal, Number(pageHasError(page)), JSON.stringify(page)));
    const insertIssue = this.db.prepare("INSERT INTO issues (audit_id, issue_id, ordinal, detail_json) VALUES (?, ?, ?, ?)");
    issues.forEach((issue, ordinal) => insertIssue.run(id, issue.id, ordinal, JSON.stringify(issue)));
    const insertRelationship = this.db.prepare("INSERT INTO crawl_relationships (audit_id, ordinal, source, target, detail_json) VALUES (?, ?, ?, ?, ?)");
    result.relationships.forEach((relationship, ordinal) => insertRelationship.run(id, ordinal, relationship.source, relationship.target, JSON.stringify(relationship)));
    this.db.prepare(`
      UPDATE audits SET updated_at = ?, crawled_pages = ?, error_pages = ?, issue_count = ?,
        robots_json = ?, sitemap_json = ?, limits_json = ?, warnings_json = ? WHERE id = ?
    `).run(new Date().toISOString(), result.pages.length, result.pages.filter(pageHasError).length, issues.length,
      JSON.stringify(result.robots), JSON.stringify(result.sitemap), JSON.stringify(result.limits), JSON.stringify(result.warnings), id);
  }

  /** Durable checkpoint before Lighthouse starts; does not complete or clear the active audit. */
  saveCrawlResult(id: string, result: CrawlResult, issues: Issue[]): void {
    this.transaction(() => this.writeCrawlResult(id, result, issues));
  }

  saveLighthouse(id: string, lighthouse: LighthouseResult | null): void {
    this.db.prepare("UPDATE audits SET lighthouse_json = ?, updated_at = ? WHERE id = ?")
      .run(lighthouse === null ? null : JSON.stringify(lighthouse), new Date().toISOString(), id);
  }

  finishAudit(id: string, result: CrawlResult, issues: Issue[], lighthouse: LighthouseResult | null = null): void {
    const now = new Date().toISOString();
    this.transaction(() => {
      this.writeCrawlResult(id, result, issues);
      this.db.prepare(`
        UPDATE audits SET status = 'completed', completed_at = ?, updated_at = ?, progress = 100,
          message = ?, error = NULL, lighthouse_json = ? WHERE id = ?
      `).run(now, now, "Audit completed.", lighthouse === null ? null : JSON.stringify(lighthouse), id);
    });
  }

  failAudit(id: string, error: string): void {
    const now = new Date().toISOString();
    this.db.prepare("UPDATE audits SET status = 'failed', completed_at = ?, updated_at = ?, message = ?, error = ? WHERE id = ?")
      .run(now, now, "The audit failed. Processed pages have been retained.", error, id);
  }

  interruptRunningAudits(): number {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE audits SET status = 'interrupted', completed_at = ?, updated_at = ?, message = ?, error = ?
      WHERE status IN ('queued', 'running')
    `).run(now, now, "Audit interrupted when the application restarted. Processed pages have been retained.",
      "The process stopped before the audit finished.");
    return Number(result.changes);
  }

  close(): void {
    this.db.close();
  }
}

// Keep one connection through Next.js development module reloads.
const repositoryState = globalThis as typeof globalThis & { __siteInspectorRepository?: AuditRepository };

export function getRepository(): AuditRepository {
  if (!repositoryState.__siteInspectorRepository) {
    repositoryState.__siteInspectorRepository = new AuditRepository(process.env.DATABASE_PATH || process.env.AUDIT_DB_PATH || resolve(process.cwd(), "data", "audits.sqlite"));
  }
  return repositoryState.__siteInspectorRepository;
}
