import { describe, expect, it, vi } from "vitest";
import { executeAudit } from "@/services/audits";
import { unavailableLighthouse } from "@/lighthouse";
import type { AuditSummary, CrawlResult } from "@/shared/types";

const audit: AuditSummary = { id: "audit-test", domain: "example.com", startUrl: "https://example.com/nested", status: "queued", startedAt: "2026-10-03T12:00:00Z", completedAt: null, updatedAt: "2026-10-03T12:00:00Z", crawledPages: 0, errorPages: 0, issueCount: 0, maxPages: 25, progress: 0, message: "Audit queued.", error: null };
const result: CrawlResult = { pages: [], relationships: [], robots: { url: "https://example.com/robots.txt", found: false, statusCode: 404, body: null, error: null, warnings: [] }, sitemap: { found: false, urls: [], documents: [], error: null, truncated: false }, limits: { maxPages: 25, concurrency: 3, timeoutMs: 10000, maxResponseBytes: 2000000, maxRedirects: 5, maxImageChecks: 30 }, warnings: [] };
const repository = () => ({ updateProgress: vi.fn(), savePage: vi.fn(), saveCrawlResult: vi.fn(), finishAudit: vi.fn(), failAudit: vi.fn() });

describe("SEO and homepage Lighthouse lifecycle", () => {
  it("checkpoints the SEO results before running exactly one homepage analysis", async () => {
    const repo = repository();
    const lighthouse = vi.fn(async () => {
      expect(repo.saveCrawlResult).toHaveBeenCalledWith(audit.id, result, []);
      expect(repo.finishAudit).not.toHaveBeenCalled();
      return unavailableLighthouse(audit.startUrl, "Chromium is unavailable.");
    });
    const crawl = vi.fn(async () => result);
    await executeAudit(audit, { repository: repo, crawl, lighthouse, issues: () => [] });
    expect(crawl).toHaveBeenCalledOnce();
    expect(lighthouse).toHaveBeenCalledExactlyOnceWith(audit.startUrl);
    expect(repo.finishAudit).toHaveBeenCalledWith(audit.id, result, [], expect.objectContaining({ status: "unavailable", homepageUrl: "https://example.com/" }));
    expect(repo.failAudit).not.toHaveBeenCalled();
  });
  it("completes the SEO report even if the isolated Lighthouse module throws", async () => {
    const repo = repository();
    await executeAudit(audit, { repository: repo, crawl: async () => result, lighthouse: async () => { throw new Error("Browser launch failed."); }, issues: () => [] });
    expect(repo.finishAudit).toHaveBeenCalledWith(audit.id, result, [], expect.objectContaining({ status: "unavailable", error: "Browser launch failed." }));
    expect(repo.failAudit).not.toHaveBeenCalled();
  });
  it("preserves the crawler failure state and does not start Lighthouse after an incomplete crawl", async () => {
    const repo = repository();
    const lighthouse = vi.fn();
    await executeAudit(audit, { repository: repo, crawl: async () => { throw new Error("Crawl interrupted."); }, lighthouse, issues: () => [] });
    expect(repo.failAudit).toHaveBeenCalledWith(audit.id, "Crawl interrupted.");
    expect(lighthouse).not.toHaveBeenCalled();
  });
});
