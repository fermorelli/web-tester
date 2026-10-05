import { normalizeUrl } from "../crawler/url";
import { htmlPages, pageLookup, type Analyzer } from "./types";
export const analyzeSitemap: Analyzer = (context, report) => {
  const sitemap = context.sitemap;
  if (!sitemap.found) report.add("sitemap_missing", context.startUrl, `No usable sitemap was read at the locations checked during this audit. Successfully read documents: ${sitemap.documents.join(", ") || "none"}. A sitemap may exist elsewhere; small, well-linked sites may not need one. ${sitemap.error ?? ""}`);
  if (sitemap.error) report.add("sitemap_error", context.startUrl, sitemap.error);
  if (!sitemap.found) return;
  const urls = new Set(sitemap.urls.map(url => normalizeUrl(url) ?? url));
  const linked = new Set(context.relationships.map(edge => normalizeUrl(edge.target) ?? edge.target));
  for (const page of htmlPages(context)) for (const link of page.parsed.links) if (link.internal) linked.add(link.url);
  const startUrl = normalizeUrl(context.startUrl) ?? context.startUrl;
  const startPage = context.pages.find(page => page.url === startUrl);
  const initialUrls = new Set([startUrl, startPage?.finalUrl ?? startUrl]);
  const lookup = pageLookup(context);
  const coverage = `Sample: ${context.pages.length}/${context.limits.maxPages} maximum pages; sitemap${sitemap.truncated ? " truncated" : " read"}; navigation without JavaScript. This does not confirm orphan status.`;
  for (const url of urls) {
    const page = lookup.get(url);
    if (page && page.statusCode !== null && page.statusCode >= 400) report.add("sitemap_http_error", url, `HTTP ${page.statusCode} observed.`);
    if (page?.parsed?.noindex && !page.error && page.statusCode !== null && page.statusCode >= 200 && page.statusCode < 300) report.add("sitemap_noindex", url, `Directives applicable to Googlebot in a successful HTML response: ${page.parsed.robots.join(", ")}`);
    if (page?.redirects.length) report.add("sitemap_redirect", url, `${page.redirects.length} hops → ${page.finalUrl}`);
    if (!linked.has(url) && !initialUrls.has(url)) {
      report.add("orphan_candidate", url, `${page?.parsed ? "Page downloaded from sitemap" : "URL listed in sitemap; content unverified"}. ${coverage}`);
    }
  }
  for (const page of htmlPages(context)) if (page.indexable === true && page.depth !== null && !urls.has(page.finalUrl) && !urls.has(page.url)) {
    report.add("sitemap_absent_page", page.url, `Observed URL estimated to be indexable: ${page.finalUrl}; not found in ${sitemap.documents.length} documents read.${sitemap.truncated ? " Sitemap truncated: partial comparison." : ""}`);
  }
};
