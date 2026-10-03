import { pageLookup, type Analyzer } from "./types";
export const analyzeLinks: Analyzer = (context, report) => {
  const lookup = pageLookup(context);
  const relationships = [...context.relationships];
  // Make the analyzer useful for individually parsed pages as well as crawl results.
  for (const page of context.pages) for (const link of page.parsed?.links ?? []) if (link.internal && !relationships.some(edge => edge.source === page.url && edge.target === link.url)) {
    relationships.push({ source: page.url, target: link.url, nofollow: link.nofollow, text: link.text });
  }
  for (const edge of relationships) {
    const target = lookup.get(edge.target);
    if (!target || target.blockedByRobots) continue;
    if (target.statusCode !== null && target.statusCode >= 400) report.add("internal_link_broken", edge.source, `Link to ${edge.target}; HTTP ${target.statusCode}; text: ${edge.text || "(empty)"}.`);
    else if (target.error) report.add("internal_link_unverified", edge.source, `Link to ${edge.target}; request failed: ${target.error}. This does not confirm a broken link.`);
    if (target.redirects.length) report.add("internal_link_redirect", edge.source, `${edge.target} → ${target.finalUrl} (${target.redirects.length} hops).`);
  }
  for (const page of context.pages) if (page.depth !== null && page.depth > 3 && page.parsed) report.add("deep_page", page.url, `Observed depth: ${page.depth}; start ${context.startUrl}.`);
};
