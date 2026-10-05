import { normalizeUrl } from "../crawler/url";
import { parseRobots } from "../parsers/robots";
import { htmlPages, pageLookup, type Analyzer } from "./types";
function directivesEvidence(parsed: ReturnType<typeof htmlPages>[number]["parsed"]): string {
  const records = parsed.robotDirectives?.filter(record => ["*", "googlebot"].includes(record.agent));
  const details = records?.map(record => `${record.source}, ${record.agent === "*" ? "all bots" : record.agent}: ${record.directives.join(", ")}`).join(" | ");
  return `Directives applicable to Googlebot (generic + specific): ${details || parsed.robots.join(", ")}`;
}
export const analyzeIndexability: Analyzer = (context, report) => {
  for (const page of context.pages) if (page.blockedByRobots) report.add("robots_blocked", page.url, `Policy from ${new URL(page.finalUrl).origin}/robots.txt for SiteInspectorBot; blocked HTML was not requested.`);
  const lookup = pageLookup(context);
  for (const page of htmlPages(context)) {
    const parsed = page.parsed;
    if (parsed.noindex) report.add("noindex", page.url, directivesEvidence(parsed));
    if (parsed.nofollow) report.add("nofollow", page.url, directivesEvidence(parsed));
    if (!parsed.canonicalCount) report.add("canonical_missing", page.url, "No canonical was found in the received HTML head or HTTP Link header. Google can select a canonical without an explicit declaration.");
    if (parsed.canonicalInvalid) {
      const declarations = parsed.canonicalDeclarations?.map(declaration => `${declaration.source}: ${declaration.raw ?? "missing href"} → ${declaration.url ?? "invalid HTTP/HTTPS destination"}`).join(" | ");
      report.add("canonical_invalid", page.url, `${parsed.canonicalCount} declarations; ${declarations ?? `href: ${parsed.canonicalRaw ?? "missing"}`}`);
    }
    if (!parsed.canonical) continue;
    if (parsed.canonical !== normalizeUrl(page.finalUrl)) report.add("canonical_other", page.url, `${page.finalUrl} → declared canonical ${parsed.canonical}. Content equivalence and the search engine's selected canonical were not verified.`);
    const target = lookup.get(parsed.canonical);
    if (target && ((target.statusCode !== null && target.statusCode >= 400) || target.parsed?.noindex)) {
      report.add("canonical_suspicious", page.url, `Declared canonical ${parsed.canonical}: observed HTTP ${target.statusCode ?? "unverified"}, noindex applicable to Googlebot=${target.parsed?.noindex ?? "unknown"}. This does not confirm Google's selected canonical or current indexing state.`);
    }
  }
};

/** Diagnose Googlebot access independently; fetching always follows SiteInspectorBot's policy. */
export const analyzeGooglebotRobots: Analyzer = (context, report) => {
  if (!context.robots.found || context.robots.body === null || context.robots.error) return;
  const policy = parseRobots(context.robots.body, "Googlebot");
  const origin = new URL(context.robots.url).origin;
  for (const page of context.pages) if (new URL(page.url).origin === origin && !policy.isAllowed(page.url)) {
    report.add("googlebot_robots_blocked", page.url, `Policy evaluated for Googlebot at ${context.robots.url}. Crawl access denied; this does not confirm indexing state.`);
  }
};
