import { describe, expect, it } from "vitest";
import { generateIssues } from "../src/issues/generate";
import { issueCatalog } from "../src/issues/catalog";
import { parsePage } from "../src/parsers/page";
import type { AnalysisContext, PageAnalysis } from "../src/shared/types";
import type { Analyzer } from "../src/analyzers/types";

const base = "https://example.com/";
function page(path: string, html = "<main><h1>Principal</h1><p>Content</p></main>", overrides: Partial<PageAnalysis> = {}): PageAnalysis {
  const url = new URL(path, base).href;
  return { url, finalUrl: url, statusCode: 200, redirects: [], contentType: "text/html", responseTimeMs: 50, error: null, blockedByRobots: false, depth: 1, inSitemap: false, discoveredFrom: [], fetchedAt: "2026-10-03T12:00:00Z", indexable: true, parsed: parsePage(html, url), ...overrides };
}
function context(pages: PageAnalysis[], overrides: Partial<AnalysisContext> = {}): AnalysisContext {
  return { startUrl: base, domain: "example.com", pages, relationships: [], robots: { url: `${base}robots.txt`, found: true, statusCode: 200, body: "User-agent: *\nAllow: /", error: null, warnings: [] }, sitemap: { found: true, urls: pages.map(p => p.url), documents: [`${base}sitemap.xml`], error: null, truncated: false }, limits: { maxPages: 100, concurrency: 3, timeoutMs: 10000, maxResponseBytes: 2000000, maxRedirects: 5, maxImageChecks: 30 }, warnings: [], ...overrides };
}

describe("central issue generation", () => {
  it("consolidates a stable issue and deduplicates affected URLs and evidence", () => {
    const duplicateAnalyzer: Analyzer = (_, report) => {
      report.add("title_missing", base, "same evidence");
      report.add("title_missing", base, "same evidence");
      report.add("title_missing", `${base}other`, "another evidence");
    };
    const issues = generateIssues(context([]), [duplicateAnalyzer]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ id: "title_missing", severity: "high", category: "Metadata", affectedUrls: [base, `${base}other`] });
    expect(issues[0].evidence).toHaveLength(2);
    expect(issues[0].description).toBe(issueCatalog.title_missing.description);
    expect(issues[0].whyItMatters).toBeTruthy();
    expect(issues[0].recommendation).toBeTruthy();
  });
  it("reports broken links only for observed HTTP errors, separating fetch failures and unknown targets", () => {
    const source = page("/", '<a href="/404">Broken</a><a href="/timeout">Timeout</a><a href="/unknown">Unknown</a><a href="/blocked">Blocked</a>');
    const broken = page("/404", "", { statusCode: 404, parsed: null, indexable: false });
    const timeout = page("/timeout", "", { statusCode: null, parsed: null, error: "Request timed out", indexable: null });
    const blocked = page("/blocked", "", { statusCode: null, parsed: null, error: "Skipped", blockedByRobots: true, indexable: null });
    const issues = generateIssues(context([source, broken, timeout, blocked]));
    const link = issues.find(issue => issue.id === "internal_link_broken");
    expect(link?.affectedUrls).toEqual([base]);
    expect(link?.evidence).toHaveLength(1);
    expect(link?.evidence[0].detail).toContain("HTTP 404");
    expect(issues.find(issue => issue.id === "internal_link_unverified")?.evidence).toHaveLength(1);
    expect(issues.find(issue => issue.id === "internal_link_unverified")?.evidence[0].detail).toContain("does not confirm");
    expect(issues.find(issue => issue.id === "fetch_error")?.affectedUrls).toEqual([timeout.url]);
  });
  it("does not call a known HTTP200 response broken when body or transport verification failed", () => {
    const source = page('/', '<a href="/large">Large</a>');
    const large = page('/large', '', { statusCode: 200, parsed: null, error: 'Response exceeds maximum size', indexable: null });
    const issues = generateIssues(context([source, large]));
    expect(issues.find(issue => issue.id === 'internal_link_broken')).toBeUndefined();
    expect(issues.find(issue => issue.id === 'internal_link_unverified')?.affectedUrls).toEqual([base]);
  });
  it("diagnoses Googlebot robots rules independently and preserves scoped noindex evidence", () => {
    const privatePage = page('/private');
    const noindex = page('/google-only', '<meta name="googlebot" content="noindex">', { indexable: false });
    const otherOrigin = page('/private', '', { url: 'https://www.example.com/private', finalUrl: 'https://www.example.com/private' });
    const audit = context([privatePage, noindex, otherOrigin], { robots: { url: `${base}robots.txt`, found: true, statusCode: 200, body: 'User-agent: *\nAllow: /\nUser-agent: Googlebot\nDisallow: /private', error: null, warnings: [] } });
    const issues = generateIssues(audit);
    expect(issues.find(issue => issue.id === 'googlebot_robots_blocked')?.affectedUrls).toEqual([privatePage.url]);
    expect(issues.find(issue => issue.id === 'googlebot_robots_blocked')?.evidence[0].detail).toContain('does not confirm');
    expect(issues.find(issue => issue.id === 'robots_blocked')).toBeUndefined();
    expect(issues.find(issue => issue.id === 'noindex')?.evidence[0].detail).toContain('meta, googlebot: noindex');
  });
  it("detects consolidated duplicate metadata and normalized content", () => {
    const words = Array.from({ length: 110 }, (_, index) => `palabra${index}`).join(" ");
    const first = page("/a", `<title>  Duplicado para páginas </title><meta name="description" content="Una descripción repetida"><main><h1>Tema</h1><p>${words}</p></main>`);
    const second = page("/b", `<title>duplicado para páginas</title><meta name="description" content="una descripción repetida"><main><h1>TEMA</h1><p>${words.toUpperCase()}</p></main>`);
    const redirectedAlias = { ...first, url: `${base}old`, finalUrl: first.url };
    const issues = generateIssues(context([first, second, redirectedAlias]));
    for (const id of ["title_duplicate", "description_duplicate", "content_duplicate"]) {
      const issue = issues.find(entry => entry.id === id);
      expect(issue?.affectedUrls).toEqual([first.url, second.url]);
    }
  });
  it("detects redirects and chains, canonical signals and headings", () => {
    const redirected = page("/old", '<link rel="canonical" href="https://other.example/page"><h1>One</h1><h3>Three</h3><h1>Another</h1><h2> </h2>', { redirects: [{ url: `${base}old`, statusCode: 301, location: `${base}middle` }, { url: `${base}middle`, statusCode: 302, location: `${base}new` }], finalUrl: `${base}new` });
    const issues = generateIssues(context([redirected]));
    const ids = issues.map(issue => issue.id);
    expect(ids).toEqual(expect.arrayContaining(["http_redirect", "redirect_chain", "canonical_other", "canonical_suspicious", "h1_multiple", "heading_empty", "heading_hierarchy"]));
  });
  it("checks sitemap overlap with explicit limitations and omits the start page from orphan candidates", () => {
    const home = page("/", '<a href="/linked">Link</a>', { depth: 0 });
    const linked = page("/linked");
    const noindex = page("/noindex", '<meta name="robots" content="noindex">', { depth: null, indexable: false });
    const error = page("/broken", "", { statusCode: 503, parsed: null, depth: null, indexable: false });
    const redirected = page("/redirect", "", { redirects: [{ url: `${base}redirect`, statusCode: 301, location: `${base}linked` }], finalUrl: `${base}linked`, depth: null });
    const audit = context([home, linked, noindex, error, redirected], { sitemap: { found: true, urls: [base, noindex.url, error.url, redirected.url, `${base}unfetched`], documents: [`${base}sitemap.xml`], error: null, truncated: true }, relationships: [{ source: base, target: linked.url, nofollow: false, text: "Link" }] });
    const issues = generateIssues(audit);
    expect(issues.map(issue => issue.id)).toEqual(expect.arrayContaining(["sitemap_noindex", "sitemap_http_error", "sitemap_redirect", "sitemap_absent_page", "sitemap_unlinked", "orphan_candidate"]));
    expect(issues.find(issue => issue.id === "orphan_candidate")?.affectedUrls).not.toContain(base);
    expect(issues.find(issue => issue.id === "orphan_candidate")?.evidence[0].detail).toContain("does not confirm orphan status");
    expect(issues.find(issue => issue.id === "sitemap_absent_page")?.evidence[0].detail).toContain("partial comparison");
    expect(issues.find(issue => issue.id === "sitemap_http_error")?.affectedUrls).toEqual([error.url]);
  });
  it("distinguishes missing and empty image alt and only flags measured Content-Length", () => {
    const p = page("/", '<img src="/one.jpg"><img src="/two.jpg" alt=""><img src="/big.jpg" alt="Big"><img src="/unmeasured-big.jpg" alt="Unmeasured">');
    p.parsed!.images[2].contentLength = 600 * 1024;
    const issues = generateIssues(context([p]));
    expect(issues.find(issue => issue.id === "image_alt_missing")?.evidence).toHaveLength(1);
    expect(issues.find(issue => issue.id === "image_alt_empty")?.severity).toBe("info");
    expect(issues.find(issue => issue.id === "image_heavy")?.evidence).toHaveLength(1);
    expect(issues.find(issue => issue.id === "image_heavy")?.evidence[0].detail).toContain("Content-Length 614400");
  });
  it("reports invalid schema and tracking findings without compliance assertions", () => {
    const p = page("/", '<script type="application/ld+json">{bad}</script><script src="https://plausible.io/js/script.js"></script>');
    const issues = generateIssues(context([p]));
    expect(issues.find(issue => issue.id === "schema_invalid")?.severity).toBe("high");
    expect(issues.find(issue => issue.id === "schema_missing")).toBeUndefined();
    const tracking = issues.find(issue => issue.id === "tracking_detected");
    expect(tracking?.severity).toBe("info");
    expect(tracking?.evidence[0].detail).toContain("Plausible");
    expect(tracking?.description).not.toMatch(/compliant|incumplimiento/i);
  });
  it("sorts critical findings before high findings and accepts empty crawl results", () => {
    const p = page("/", "", { statusCode: 500, parsed: null, indexable: false });
    const issues = generateIssues(context([p], { sitemap: { found: false, urls: [], documents: [], error: "Invalid XML", truncated: false } }));
    expect(issues[0].id).toBe("http_5xx");
    expect(issues[0].severity).toBe("critical");
    expect(generateIssues(context([]))).toEqual([]);
  });
});
