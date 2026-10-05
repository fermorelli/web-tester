import { createHash } from "node:crypto";
import * as cheerio from "cheerio";
import { isInternalUrl, normalizeUrl } from "../crawler/url";
import type { ParsedPage } from "../shared/types";

const clean = (value: string) => value.replace(/\s+/g, " ").trim();

/** Link headers may contain commas inside a target URI or a quoted parameter. */
function linkValues(header: string, separator = ","): string[] {
  const values: string[] = [];
  let start = 0, inTarget = false, quoted = false, escaped = false;
  for (let index = 0; index < header.length; index++) {
    const char = header[index];
    if (escaped) { escaped = false; continue; }
    if (quoted && char === "\\") { escaped = true; continue; }
    if (!inTarget && char === '"') quoted = !quoted;
    if (!quoted && char === "<") inTarget = true;
    if (!quoted && char === ">") inTarget = false;
    if (char === separator && !inTarget && !quoted) { values.push(header.slice(start, index)); start = index + 1; }
  }
  values.push(header.slice(start));
  return values;
}

function linkParameters(value: string): Map<string, string> | null {
  const parameters = new Map<string, string>();
  for (const part of linkValues(value, ";")) {
    if (!part.trim()) continue;
    const match = part.trim().match(/^([^=\s]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s;"]+))$/);
    if (!match) return null;
    const key = match[1].toLowerCase();
    if (parameters.has(key)) return null; // Ambiguous parameters are not canonical evidence.
    parameters.set(key, (match[2] ?? match[3]).replace(/\\(.)/g, "$1"));
  }
  return parameters;
}

/** Parse the server response only: this function never executes scripts or requests resources. */
export function parsePage(html: string, url: string, responseHeaders: Record<string, string> = {}): ParsedPage {
  const $ = cheerio.load(html);
  const pageBase = normalizeUrl($("base[href]").first().attr("href") ?? "", url) ?? url;
  const meta = (name: string) => $("meta").filter((_, el) => ($(el).attr("name") ?? "").toLowerCase() === name).first().attr("content");
  // Google accepts HTML canonicals in head and canonicals in the HTTP Link header.
  const canonicalElements = $("head link").filter((_, el) => ($(el).attr("rel") ?? "").toLowerCase().split(/\s+/).includes("canonical"));
  const canonicalDeclarations: NonNullable<ParsedPage["canonicalDeclarations"]> = canonicalElements.toArray().map(el => {
    const raw = $(el).attr("href")?.trim() ?? null;
    return { source: "html", raw, url: raw ? normalizeUrl(raw, pageBase) : null };
  });
  const linkHeader = Object.entries(responseHeaders).find(([key]) => key.toLowerCase() === "link")?.[1];
  for (const value of linkValues(linkHeader ?? "")) {
    const match = value.trim().match(/^<([^<>]*)>(.*)$/);
    if (!match) continue;
    const parameters = linkParameters(match[2]);
    if (!parameters?.get("rel")?.toLowerCase().split(/\s+/).includes("canonical")) continue;
    const anchor = parameters.get("anchor");
    if (anchor !== undefined) {
      try { if (new URL(anchor, url).href !== new URL(url).href) continue; }
      catch { continue; }
    }
    const raw = match[1].trim();
    canonicalDeclarations.push({ source: "header", raw, url: raw ? normalizeUrl(raw, url) : null });
  }
  const canonicalRaw = canonicalDeclarations[0]?.raw ?? null;
  const canonical = canonicalDeclarations.find(declaration => declaration.url)?.url ?? null;
  const canonicalTargets = new Set(canonicalDeclarations.flatMap(declaration => declaration.url ? [declaration.url] : []));
  const robots = new Set<string>();
  const robotDirectives: NonNullable<ParsedPage["robotDirectives"]> = [];
  const parseDirectives = (value: string): string[] => {
    const tokens = value.toLowerCase().split(",").flatMap(part => {
      const trimmed = clean(part);
      if (/^(?:max-snippet|max-image-preview|max-video-preview|unavailable_after)\s*:/.test(trimmed)) return [trimmed.replace(/\s*:\s*/, ":")];
      return trimmed.split(/\s+/);
    }).filter(Boolean);
    return [...new Set(tokens.flatMap(token => token === "none" ? ["noindex", "nofollow"] : [token]))];
  };
  $("meta").each((_, el) => {
    const agent = ($(el).attr("name") ?? "").toLowerCase();
    if (["robots", "googlebot", "googlebot-news", "bingbot", "slurp", "duckduckbot", "baiduspider", "yandex", "yandexbot", "siteinspectorbot"].includes(agent) || /(?:bot|spider)$/.test(agent)) {
      robotDirectives.push({ source: "meta", agent: agent === "robots" ? "*" : agent, directives: parseDirectives($(el).attr("content") ?? "") });
    }
  });
  // A scoped X-Robots-Tag applies until another scope appears, including across commas.
  const header = Object.entries(responseHeaders).find(([key]) => key.toLowerCase() === "x-robots-tag")?.[1];
  if (header) {
    let current: NonNullable<ParsedPage["robotDirectives"]>[number] | null = null;
    for (const part of header.split(",")) {
      const match = part.trim().match(/^([a-z][a-z\d_-]*):\s*(.*)$/i);
      const isDirectiveWithValue = match && ["max-snippet", "max-image-preview", "max-video-preview", "unavailable_after"].includes(match[1].toLowerCase());
      if (match && !isDirectiveWithValue) {
        current = { source: "header", agent: match[1].toLowerCase(), directives: parseDirectives(match[2]) };
        robotDirectives.push(current);
      } else {
        if (!current) { current = { source: "header", agent: "*", directives: [] }; robotDirectives.push(current); }
        current.directives = [...new Set([...current.directives, ...parseDirectives(part)])];
      }
    }
  }
  // Google combines generic and Googlebot restrictions; a positive rule does not cancel noindex.
  for (const record of robotDirectives) if (["*", "googlebot"].includes(record.agent)) {
    for (const directive of record.directives) if (directive !== "all") robots.add(directive);
  }
  const headings = $("h1,h2,h3,h4,h5,h6").toArray().map(el => ({ level: Number(el.tagName.slice(1)), text: clean($(el).text()) }));
  const content = $.root().clone();
  content.find("script,style,nav,header,footer,aside,form,noscript,template,svg").remove();
  content.find("br").replaceWith(" ");
  content.find("p,div,section,article,main,li,td,th,h1,h2,h3,h4,h5,h6,blockquote,pre").append(" ");
  const contentRoot = content.find("main").first();
  const body = content.find("body");
  const contentText = clean(contentRoot.length ? contentRoot.text() : body.length ? body.text() : content.text());
  const linkKeys = new Set<string>();
  const links: ParsedPage["links"] = [];
  $("a[href]").each((_, el) => {
    const href = ($(el).attr("href") ?? "").trim();
    if (!href || href.startsWith("#")) return;
    const target = normalizeUrl(href, pageBase);
    if (!target) return;
    const text = clean($(el).text());
    const nofollow = ($(el).attr("rel") ?? "").toLowerCase().split(/\s+/).includes("nofollow");
    const key = `${target}\u0000${text}\u0000${nofollow}`;
    if (!linkKeys.has(key)) { links.push({ url: target, text, nofollow, internal: isInternalUrl(target, url) }); linkKeys.add(key); }
  });
  const images: ParsedPage["images"] = [];
  $("img").each((_, el) => {
    const raw = $(el).attr("src") || $(el).attr("data-src") || $(el).attr("srcset")?.split(",")[0]?.trim().split(/\s+/)[0];
    if (!raw) return;
    const src = normalizeUrl(raw, pageBase) ?? (raw.startsWith("data:image/") ? "data:image (inline)" : raw);
    images.push({ src, alt: $(el).attr("alt") ?? null, contentLength: null });
  });
  const schemaTypes = new Set<string>();
  const jsonLdErrors: string[] = [];
  const jsonLdScripts = $("script").filter((_, el) => ($(el).attr("type") ?? "").toLowerCase().split(";")[0].trim() === "application/ld+json");
  // Inventory declared types only. This is not a JSON-LD or rich-result validator.
  const inspectSchema = (value: unknown): void => {
    const pending: unknown[] = [value];
    while (pending.length) {
      const entry = pending.pop();
      if (Array.isArray(entry)) { for (let index = entry.length - 1; index >= 0; index--) pending.push(entry[index]); continue; }
      if (!entry || typeof entry !== "object") continue;
      const node = entry as Record<string, unknown>;
      const types = Array.isArray(node["@type"]) ? node["@type"] : [node["@type"]];
      for (const type of types) if (typeof type === "string" && type.trim()) schemaTypes.add(type.trim());
      // Reverse insertion preserves document order when popping the stack.
      for (const [key, child] of Object.entries(node).reverse()) if (key !== "@context" && key !== "@type") pending.push(child);
    }
  };
  jsonLdScripts.each((index, el) => {
    let value: unknown;
    try { value = JSON.parse($(el).html() ?? ""); }
    catch (error) { jsonLdErrors.push(`Block ${index + 1}: ${error instanceof Error ? error.message : "Invalid JSON"}`); return; }
    inspectSchema(value);
  });
  const openGraph: Record<string, string> = {};
  const twitter: Record<string, string> = {};
  $("meta").each((_, el) => {
    const name = ($(el).attr("property") || $(el).attr("name") || "").toLowerCase();
    const value = $(el).attr("content") ?? "";
    if (name.startsWith("og:")) openGraph[name] = value;
    if (name.startsWith("twitter:")) twitter[name] = value;
  });
  const tracking: string[] = [];
  const patterns: [string, RegExp][] = [
    ["Google Analytics", /google-analytics\.com\/(?:analytics|ga)\.js|googletagmanager\.com\/gtag\/js|\bgtag\s*\(\s*['"]config['"]\s*,\s*['"](?:G-|UA-)|\bga\s*\(\s*['"]create['"]/i],
    ["Google Tag Manager", /googletagmanager\.com\/(?:gtm\.js|ns\.html)\?[^\s"']*id=GTM-|\bGTM-[A-Z0-9]+\b/i],
    ["Meta Pixel", /connect\.facebook\.net\/[^\s"']*fbevents\.js|\bfbq\s*\(\s*['"]init['"]/i],
    ["Microsoft Clarity", /clarity\.ms\/tag\/|\bclarity\s*\(\s*['"](?:set|identify)['"]/i],
    ["Hotjar", /static\.hotjar\.com\/c\/hotjar-|\bhj\s*\(\s*['"](?:identify|event)['"]/i],
    ["Plausible", /plausible\.io\/js\//i],
    ["Matomo", /(?:matomo|piwik)\.js|\b_paq\.push\s*\(/i],
    ["Mixpanel", /cdn\.mxpnl\.com\/|\bmixpanel\.init\s*\(/i],
    ["Segment", /cdn\.segment\.com\/analytics\.js\/|\banalytics\.load\s*\(/i],
  ];
  const executableMarkup = $("script").toArray().map(el => `${$(el).attr("src") ?? ""} ${$(el).html() ?? ""}`).join("\n") + $("noscript").html();
  for (const [name, pattern] of patterns) if (pattern.test(executableMarkup)) tracking.push(name);
  return {
    title: clean($("title").first().text()) || null,
    description: clean(meta("description") ?? "") || null,
    canonical, canonicalRaw, canonicalCount: canonicalDeclarations.length, canonicalDeclarations,
    canonicalInvalid: canonicalDeclarations.some(declaration => !declaration.url) || canonicalTargets.size > 1,
    robots: [...robots], robotDirectives, noindex: robots.has("noindex"), nofollow: robots.has("nofollow"),
    headings, h1: headings.filter(heading => heading.level === 1).map(heading => heading.text),
    wordCount: contentText.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu)?.length ?? 0,
    contentHash: createHash("sha256").update(contentText.toLowerCase()).digest("hex"), contentSample: contentText.slice(0, 600),
    links, images, schemaTypes: [...schemaTypes], jsonLdCount: jsonLdScripts.length, jsonLdErrors, schemaWarnings: [],
    social: { openGraph, twitter }, tracking, language: $("html").attr("lang")?.trim() || null,
  };
}
