import type { Analyzer } from "./types";
export const analyzeHttp: Analyzer = (context, report) => {
  for (const page of context.pages) {
    if (page.blockedByRobots) continue;
    if (page.statusCode !== null && page.statusCode >= 500) report.add("http_5xx", page.url, `HTTP ${page.statusCode}; destination: ${page.finalUrl}`);
    else if (page.statusCode !== null && page.statusCode >= 400) report.add("http_4xx", page.url, `HTTP ${page.statusCode}; destination: ${page.finalUrl}`);
    if (page.error) report.add("fetch_error", page.url, `${page.error}; last received status: ${page.statusCode ?? "no HTTP response"}`);
    if (page.redirects.length) report.add("http_redirect", page.url, page.redirects.map(hop => `${hop.statusCode} ${hop.url} → ${hop.location}`).join(" | "));
    if (page.redirects.length > 1) report.add("redirect_chain", page.url, `${page.redirects.length} hops; destination: ${page.finalUrl}`);
  }
};
