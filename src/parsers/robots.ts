export interface RobotsEvaluator {
  isAllowed: (url: string) => boolean;
  sitemaps: string[];
  crawlDelay: number | null;
}
interface Group { agents: string[]; rules: { allow: boolean; path: string }[]; delay: number | null }

// Decode only unreserved bytes so / and %2F remain distinct, as required by RFC 9309.
function comparablePath(value: string): string {
  return value.replace(/%[\da-f]{2}|[^\x00-\x7F]/giu, token => {
    if (token.startsWith("%")) {
      const character = String.fromCharCode(Number.parseInt(token.slice(1), 16));
      return /[A-Za-z\d._~-]/.test(character) ? character : token.toUpperCase();
    }
    return encodeURIComponent(token);
  });
}

export function parseRobots(body: string, userAgent = "SiteInspectorBot"): RobotsEvaluator {
  const groups: Group[] = [];
  const sitemaps = new Set<string>();
  let group: Group | null = null;
  let hasDirectives = false;
  for (const rawLine of body.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = rawLine.split("#", 1)[0].trim();
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === "sitemap") { if (/^https?:\/\//i.test(value)) sitemaps.add(value); continue; }
    if (key === "user-agent") {
      if (!group || hasDirectives) { group = { agents: [], rules: [], delay: null }; groups.push(group); hasDirectives = false; }
      if (value) group.agents.push(value.toLowerCase());
      continue;
    }
    if (!group) continue;
    hasDirectives = true;
    if ((key === "allow" || key === "disallow") && value) group.rules.push({ allow: key === "allow", path: comparablePath(value) });
    if (key === "crawl-delay" && /^\d+(?:\.\d+)?$/.test(value)) group.delay = Number(value);
  }
  const agent = userAgent.toLowerCase();
  const matches = groups.map(candidate => ({ candidate, specificity: Math.max(-1, ...candidate.agents.map(value => value === "*" ? 0 : agent.includes(value) ? value.length : -1)) }));
  const specificity = Math.max(-1, ...matches.map(match => match.specificity));
  const selected = matches.filter(match => match.specificity === specificity && specificity >= 0).map(match => match.candidate);
  const rules = selected.flatMap(candidate => candidate.rules).map(rule => {
    const end = rule.path.endsWith("$");
    const path = end ? rule.path.slice(0, -1) : rule.path;
    const escaped = path.split("*").map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
    return { allow: rule.allow, length: path.replace(/\*/g, "").match(/%[\da-f]{2}|[\s\S]/gi)?.length ?? 0, regex: new RegExp(`^${escaped}${end ? "$" : ""}`) };
  });
  return {
    sitemaps: [...sitemaps],
    crawlDelay: selected.reduce<number | null>((delay, candidate) => candidate.delay === null ? delay : Math.max(delay ?? 0, candidate.delay), null),
    isAllowed(url) {
      let path: string;
      try { const parsed = new URL(url); path = comparablePath(parsed.pathname + parsed.search); } catch { return false; }
      let best: { allow: boolean; length: number } | undefined;
      for (const rule of rules) if (rule.regex.test(path) && (!best || rule.length > best.length || (rule.length === best.length && rule.allow))) best = rule;
      return best?.allow ?? true;
    },
  };
}
