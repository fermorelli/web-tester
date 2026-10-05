import { parsePage } from "@/parsers/page";
import { parseRobots } from "@/parsers/robots";
import { parseSitemap } from "@/parsers/sitemap";
import type { CrawlLimits, CrawlResult, PageAnalysis, RobotsReport, SitemapReport } from "@/shared/types";
import { safeFetch, RequestFailure, type FetchOptions, type FetchResult } from "./http";
import { inferCrawlScope, isCrawlableUrl, isInCrawlScope, isInternalUrl, normalizeUrl } from "./url";

export const DEFAULT_LIMITS: CrawlLimits = {
  maxPages: 100, concurrency: 3, timeoutMs: 10000,
  maxResponseBytes: 2_000_000, maxRedirects: 5, maxImageChecks: 30,
};
export type PageFetcher = (url: string, options: FetchOptions) => Promise<FetchResult>;
interface CrawlOptions {
  maxPages?: number;
  onPage?: (page: PageAnalysis) => void;
  onProgress?: (progress: number, message: string, pageCount: number) => void;
  /** Dependency injection for deterministic tests. Production always uses safeFetch. */
  fetcher?: PageFetcher;
}
interface Candidate { url: string; depth: number | null; from: string[] }
type RobotsPolicy = ReturnType<typeof parseRobots>;
const messageOf = (error: unknown) => error instanceof Error ? error.message : "Unknown error.";

function sampledSitemapUrls(urls: string[]): string[] {
  const groups = new Map<string, string[]>();
  for (const url of [...urls].sort((a, b) => new URL(a).pathname.split("/").length - new URL(b).pathname.split("/").length)) {
    const section = new URL(url).pathname.split("/").filter(Boolean)[0] ?? "";
    const group = groups.get(section) ?? [];
    group.push(url); groups.set(section, group);
  }
  const output: string[] = [];
  while (groups.size) for (const [key, group] of groups) {
    output.push(group.shift()!);
    if (!group.length) groups.delete(key);
  }
  return output;
}

/** Bounded HTML crawler. It retains per-page failures and never renders JavaScript. */
export async function crawlSite(startUrl: string, options: CrawlOptions = {}): Promise<CrawlResult> {
  const scope = inferCrawlScope(startUrl);
  const limits: CrawlLimits = { ...DEFAULT_LIMITS, maxPages: Math.max(1, Math.min(100, options.maxPages ?? 100)), scope, analysisVersion: 2 };
  const fetcher = options.fetcher ?? safeFetch;
  const warnings: string[] = [
    "The audit uses HTML received over HTTP. It does not execute JavaScript or measure Core Web Vitals.",
    "Only the initial host and its www alias are requested. External links and their images are not verified.",
    "Tracking parameters are removed; functional parameters are retained. Sampling prioritizes navigation and different sitemap sections.",
  ];
  if (scope.kind === "path") warnings.push(`The audit is limited to ${scope.rootUrl} and slash-delimited descendants. Other paths on the same host are excluded; robots.txt and sitemap documents are read as host metadata.`);
  const pages: PageAnalysis[] = [];
  const relationships: CrawlResult["relationships"] = [];
  const policies = new Map<string, Promise<{ report: RobotsReport; policy: RobotsPolicy }>>();
  const requestSlots = new Map<string, number>();
  const deadline = Date.now() + 10 * 60 * 1000;
  const baseOptions: FetchOptions = {
    scopeUrl: startUrl, timeoutMs: limits.timeoutMs,
    scope: { kind: "host", rootUrl: new URL("/", scope.rootUrl).href },
    maxResponseBytes: limits.maxResponseBytes, maxRedirects: limits.maxRedirects,
  };
  const progress = (value: number, message: string) => options.onProgress?.(value, message, pages.length);

  const loadRobots = (origin: string) => {
    let pending = policies.get(origin);
    if (!pending) {
      pending = (async () => {
        const report: RobotsReport = { url: `${origin}/robots.txt`, found: false, statusCode: null, body: null, error: null, warnings: [] };
        let body = "";
        try {
          const response = await fetcher(report.url, baseOptions);
          report.statusCode = response.statusCode;
          report.found = response.statusCode >= 200 && response.statusCode < 300;
          report.body = report.found ? response.body : null;
          if ([401, 403].includes(response.statusCode)) {
            body = "User-agent: *\nDisallow: /";
            report.warnings.push("robots.txt returns 401/403: a conservative policy is applied and this origin is not crawled.");
          } else if (response.statusCode >= 500 || response.statusCode === 429) {
            throw new Error(`robots.txt returned HTTP ${response.statusCode}; crawling suspended for this origin.`);
          } else if (report.found) {
            if (/^\s*(?:<!doctype\s+html|<html)/i.test(response.body)) throw new Error("robots.txt returned HTML; a crawl policy could not be established.");
            body = response.body;
          }
        } catch (error) {
          report.error = messageOf(error);
          report.warnings.push("robots.txt could not be verified: this origin will not be crawled until a new audit.");
          body = "User-agent: *\nDisallow: /";
        }
        return { report, policy: parseRobots(body) };
      })();
      policies.set(origin, pending);
    }
    return pending;
  };

  const beforeRequest = async (url: string) => {
    if (Date.now() > deadline) throw new Error("The 10-minute audit duration limit was reached.");
    const origin = new URL(url).origin;
    const { policy } = await loadRobots(origin);
    if (!policy.isAllowed(url)) throw new Error("ROBOTS_BLOCKED: URL excluded by robots.txt.");
    const delay = Math.max(200, (policy.crawlDelay ?? 0) * 1000);
    const slot = Math.max(Date.now(), requestSlots.get(origin) ?? 0);
    requestSlots.set(origin, slot + delay);
    const wait = slot - Date.now();
    if (slot > deadline) throw new Error("The crawl-delay exceeds the time available for this audit.");
    if (wait > 0 && !options.fetcher) await new Promise(resolve => setTimeout(resolve, wait));
  };
  const beforePageRequest = async (url: string) => {
    if (!isInCrawlScope(url, scope)) throw new Error("Redirect outside the selected audit scope: not followed.");
    await beforeRequest(url);
  };
  const pageOptions: FetchOptions = { ...baseOptions, scope, beforeRequest: beforePageRequest };

  progress(3, "Checking robots.txt…");
  const primaryRobots = await loadRobots(new URL(startUrl).origin);
  progress(7, "Looking for sitemaps…");
  const sitemap: SitemapReport = { found: false, urls: [], documents: [], error: null, truncated: false };
  const sitemapErrors: string[] = [];
  const sitemapUrls = new Set<string>();
  const pendingSitemaps = [...primaryRobots.policy.sitemaps, `${new URL(startUrl).origin}/sitemap.xml`];
  const seenSitemaps = new Set<string>();
  while (pendingSitemaps.length && seenSitemaps.size < 20 && sitemapUrls.size < 10000 && Date.now() < deadline) {
    const url = normalizeUrl(pendingSitemaps.shift()!, startUrl);
    if (!url || seenSitemaps.has(url)) continue;
    if (!isInternalUrl(url, startUrl)) { warnings.push(`External sitemap skipped: ${url}`); continue; }
    seenSitemaps.add(url);
    try {
      await beforeRequest(url);
      const response = await fetcher(url, { ...baseOptions, beforeRequest: async target => { if (target !== url) await beforeRequest(target); } });
      if (response.statusCode === 404 || response.statusCode === 410) continue;
      if (response.statusCode < 200 || response.statusCode >= 300) throw new Error(`HTTP ${response.statusCode} at ${url}`);
      const parsed = parseSitemap(response.body, response.url);
      sitemap.found = true;
      sitemap.documents.push(url);
      for (const entry of parsed.urls) {
        const normalized = normalizeUrl(entry, response.url);
        if (normalized && isInCrawlScope(normalized, scope) && sitemapUrls.size < 10000) sitemapUrls.add(normalized);
        else if (sitemapUrls.size >= 10000) sitemap.truncated = true;
      }
      pendingSitemaps.push(...parsed.sitemaps);
    } catch (error) { sitemapErrors.push(`${url}: ${messageOf(error)}`); }
  }
  sitemap.urls = [...sitemapUrls];
  sitemap.truncated ||= pendingSitemaps.length > 0;
  sitemap.error = sitemapErrors.length ? sitemapErrors.join("\n") : null;
  if (sitemap.truncated) warnings.push("Sitemap reading was limited to 20 documents and 10,000 URLs.");
  if (sitemap.error) warnings.push(`Sitemap incomplete or inaccessible: ${sitemap.error}`);

  const navigation: Candidate[] = [{ url: startUrl, depth: 0, from: [] }];
  const sitemapQueue: Candidate[] = sampledSitemapUrls(sitemap.urls.filter(url => isInCrawlScope(url, scope) && isCrawlableUrl(url))).map(url => ({ url, depth: null, from: [] }));
  const candidates = new Map<string, Candidate>([[startUrl, navigation[0]]]);
  const scheduled = new Set<string>();
  const finalFetched = new Set<string>();
  let candidateLimitReached = false;
  let sequence = 0;
  const nextCandidate = (): Candidate | null => {
    while (navigation.length || sitemapQueue.length) {
      const preferSitemap = sequence > 0 && sequence % 4 === 0;
      const candidate = (preferSitemap && sitemapQueue.length ? sitemapQueue : navigation.length ? navigation : sitemapQueue).shift()!;
      if (!isInCrawlScope(candidate.url, scope)) continue;
      if (scheduled.has(candidate.url) || finalFetched.has(candidate.url)) continue;
      scheduled.add(candidate.url); sequence++;
      return candidates.get(candidate.url) ?? candidate;
    }
    return null;
  };

  progress(12, "Crawling pages and analyzing HTML…");
  while (pages.length < limits.maxPages && Date.now() < deadline) {
    const batch: Candidate[] = [];
    for (let i = 0; i < Math.min(limits.concurrency, limits.maxPages - pages.length); i++) {
      const candidate = nextCandidate();
      if (!candidate) break;
      batch.push(candidate);
    }
    if (!batch.length) break;
    const results = await Promise.all(batch.map(async candidate => {
      const page: PageAnalysis = {
        url: candidate.url, finalUrl: candidate.url, statusCode: null, redirects: [], contentType: null,
        responseTimeMs: 0, error: null, blockedByRobots: false, depth: candidate.depth,
        inSitemap: sitemapUrls.has(candidate.url), discoveredFrom: candidate.from,
        fetchedAt: new Date().toISOString(), indexable: null, parsed: null,
      };
      const begin = Date.now();
      try {
        // Run here as well as on redirects (the injected test transport is intentionally minimal).
        await beforePageRequest(candidate.url);
        const result = await fetcher(candidate.url, { ...pageOptions, beforeRequest: async url => {
          if (url !== candidate.url) await beforePageRequest(url);
        } });
        if (!isInCrawlScope(result.url, scope)) throw new RequestFailure("Redirect outside the selected audit scope: not followed.", result.url, result.redirects, result.statusCode);
        page.finalUrl = result.url; page.statusCode = result.statusCode;
        page.redirects = result.redirects; page.contentType = result.headers["content-type"] ?? null;
        page.responseTimeMs = result.responseTimeMs;
        if (/\b(?:text\/html|application\/xhtml\+xml)\b/i.test(page.contentType ?? "")
          || (!page.contentType && /^\s*(?:<!doctype\s+html|<html)/i.test(result.body))) {
          const parsed = parsePage(result.body, result.url, result.headers);
          page.parsed = parsed;
          page.indexable = result.statusCode >= 200 && result.statusCode < 300 && !parsed.noindex;
        } else {
          page.indexable = result.statusCode >= 400 ? false : null;
        }
      } catch (error) {
        const message = messageOf(error);
        page.blockedByRobots = message.includes("ROBOTS_BLOCKED:");
        page.error = page.blockedByRobots ? null : message;
        page.indexable = null;
        if (error instanceof RequestFailure) {
          page.finalUrl = error.url; page.redirects = error.redirects; page.statusCode = error.statusCode;
          if (error.statusCode !== null && error.statusCode >= 400 && !page.blockedByRobots) page.indexable = false;
        }
        page.responseTimeMs = Date.now() - begin;
      }
      return page;
    }));
    for (const page of results) {
      pages.push(page);
      if (page.statusCode !== null && !page.error) finalFetched.add(normalizeUrl(page.finalUrl) ?? page.finalUrl);
      for (const link of page.parsed?.links ?? []) {
        if (!link.internal || !isInCrawlScope(link.url, scope)) continue;
        relationships.push({ source: page.url, target: link.url, nofollow: link.nofollow, text: link.text });
        if (!isCrawlableUrl(link.url)) continue;
        const existing = candidates.get(link.url);
        if (existing) {
          if (!existing.from.includes(page.url)) existing.from.push(page.url);
          if (page.depth !== null && (existing.depth === null || existing.depth > page.depth + 1)) existing.depth = page.depth + 1;
        } else if (candidates.size < 5000) {
          const candidate = { url: link.url, depth: page.depth === null ? null : page.depth + 1, from: [page.url] };
          candidates.set(link.url, candidate); navigation.push(candidate);
        } else candidateLimitReached = true;
      }
      options.onPage?.(page);
    }
    progress(Math.min(82, 12 + Math.round(pages.length / limits.maxPages * 70)), `Checked ${pages.length} of up to ${limits.maxPages} URLs…`);
  }
  if (candidateLimitReached) warnings.push("Discovery was limited to 5,000 navigation candidates.");
  if (pages.length >= limits.maxPages && (navigation.length || sitemapQueue.length)) warnings.push(`The limit of ${limits.maxPages} pages was reached. Findings apply to the analyzed sample.`);
  if (Date.now() >= deadline) warnings.push("The 10-minute limit was reached. Partial results were retained.");

  // Infer shortest navigation depth over the observed graph, including redirected aliases.
  const aliases = new Map<string, string>();
  const representatives = new Map<string, string>();
  for (const page of pages) {
    const final = normalizeUrl(page.finalUrl) ?? page.finalUrl;
    const representative = !page.error ? representatives.get(final) ?? page.url : page.url;
    aliases.set(page.url, representative);
    if (!page.error) { representatives.set(final, representative); aliases.set(final, representative); }
  }
  const adjacency = new Map<string, Set<string>>();
  for (const relation of relationships) {
    const source = aliases.get(relation.source) ?? relation.source;
    const target = aliases.get(relation.target) ?? relation.target;
    const edges = adjacency.get(source) ?? new Set(); edges.add(target); adjacency.set(source, edges);
  }
  const initial = aliases.get(startUrl) ?? startUrl;
  const depths = new Map<string, number>([[initial, 0]]);
  const frontier = [initial];
  while (frontier.length) {
    const source = frontier.shift()!;
    for (const target of adjacency.get(source) ?? []) if (!depths.has(target)) {
      depths.set(target, depths.get(source)! + 1); frontier.push(target);
    }
  }
  for (const page of pages) {
    page.depth = depths.get(aliases.get(page.url) ?? page.url) ?? null;
    page.discoveredFrom = [...new Set(relationships.filter(edge => (aliases.get(edge.target) ?? edge.target) === (aliases.get(page.url) ?? page.url)).map(edge => edge.source))];
    page.inSitemap ||= sitemapUrls.has(normalizeUrl(page.finalUrl) ?? page.finalUrl);
  }

  progress(86, "Checking available image sizes…");
  const imageChecks = new Map<string, { size: number | null; error?: string }>();
  const imageUrls = [...new Set(pages.flatMap(page => (page.parsed?.images ?? []).map(image => image.src)))].filter(url => isInCrawlScope(url, scope)).slice(0, limits.maxImageChecks);
  for (let offset = 0; offset < imageUrls.length; offset += limits.concurrency) {
    if (Date.now() > deadline) break;
    await Promise.all(imageUrls.slice(offset, offset + limits.concurrency).map(async url => {
      try {
        await beforePageRequest(url);
        const result = await fetcher(url, { ...pageOptions, method: "HEAD", beforeRequest: async target => { if (target !== url) await beforePageRequest(target); } });
        const length = result.headers["content-length"];
        const size = length && /^\d+$/.test(length) && Number.isSafeInteger(Number(length)) ? Number(length) : null;
        imageChecks.set(url, result.statusCode >= 200 && result.statusCode < 300 ? { size } : { size: null, error: `HTTP ${result.statusCode} in HEAD` });
      } catch (error) { imageChecks.set(url, { size: null, error: messageOf(error) }); }
    }));
  }
  for (const page of pages) for (const image of page.parsed?.images ?? []) {
    const checked = imageChecks.get(image.src);
    image.contentLength = checked?.size ?? null;
    if (checked?.error) image.checkError = checked.error;
  }
  warnings.push(`Image sizes: up to ${limits.maxImageChecks} unique in-scope URLs using HEAD. Size is not estimated without Content-Length.`);
  for (const pending of policies.values()) {
    const { report } = await pending;
    warnings.push(...report.warnings.map(warning => `${report.url}: ${warning}`));
    if (report.error) warnings.push(`${report.url}: ${report.error}`);
  }
  progress(92, "Consolidating issues…");
  return { pages, relationships, robots: primaryRobots.report, sitemap, limits, warnings: [...new Set(warnings)] };
}
