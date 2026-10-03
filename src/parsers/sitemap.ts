import * as cheerio from "cheerio";
import type { Element } from "domhandler";
import { normalizeUrl } from "../crawler/url";

const localName = (name: string) => name.split(":").at(-1)?.toLowerCase();
const prefix = (name: string) => name.includes(":") ? name.slice(0, name.indexOf(":")) : "";

/** Validate structure before Cheerio's deliberately forgiving XML reader consumes it. */
function validateXml(xml: string): string {
  const stack: string[] = [];
  let root = "";
  let closedRoot = false;
  let cursor = 0;
  const validateEntities = (value: string) => {
    if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);)/.test(value)) throw new Error("Invalid sitemap XML: unescaped or unknown entity.");
  };
  while (cursor < xml.length) {
    const start = xml.indexOf("<", cursor);
    const text = xml.slice(cursor, start < 0 ? xml.length : start);
    validateEntities(text);
    if (!stack.length && text.trim()) throw new Error("Invalid sitemap XML: text outside the root element.");
    if (start < 0) break;
    if (xml.startsWith("<!--", start)) {
      const end = xml.indexOf("-->", start + 4);
      if (end < 0 || xml.slice(start + 4, end).includes("--")) throw new Error("Invalid sitemap XML: unclosed comment.");
      cursor = end + 3; continue;
    }
    if (xml.startsWith("<![CDATA[", start)) {
      const end = xml.indexOf("]]>", start + 9);
      if (end < 0 || !stack.length) throw new Error("Invalid sitemap XML: unclosed CDATA or CDATA outside the root element.");
      cursor = end + 3; continue;
    }
    if (xml.startsWith("<?", start)) {
      const end = xml.indexOf("?>", start + 2);
      if (end < 0) throw new Error("Invalid sitemap XML: unclosed processing instruction.");
      cursor = end + 2; continue;
    }
    if (xml.startsWith("<!", start)) throw new Error("Invalid sitemap XML: DTD declarations are not supported.");
    let end = start + 1;
    let quote = "";
    for (; end < xml.length; end++) {
      const character = xml[end];
      if (quote) { if (character === quote) quote = ""; }
      else if (character === "\"" || character === "'") quote = character;
      else if (character === ">") break;
      else if (character === "<") throw new Error("Invalid sitemap XML: malformed tag.");
    }
    if (end >= xml.length || quote) throw new Error("Invalid sitemap XML: unclosed tag.");
    const tag = xml.slice(start + 1, end);
    const closing = tag.match(/^\/([A-Za-z_][\w.:-]*)\s*$/);
    if (closing) {
      if (stack.pop() !== closing[1]) throw new Error("Invalid sitemap XML: unbalanced tags.");
      if (!stack.length) closedRoot = true;
    } else {
      const opening = tag.match(/^([A-Za-z_][\w.:-]*)([\s\S]*?)(\/?)$/);
      if (!opening || closedRoot) throw new Error("Invalid sitemap XML: malformed root element or tag.");
      const attributes = opening[2];
      let position = 0;
      const names = new Set<string>();
      const attribute = /\s+([A-Za-z_][\w.:-]*)\s*=\s*("[^"<]*"|'[^'<]*')/gy;
      while (position < attributes.length) {
        if (!attributes.slice(position).trim()) break;
        attribute.lastIndex = position;
        const match = attribute.exec(attributes);
        if (!match || names.has(match[1])) throw new Error("Invalid sitemap XML: malformed or duplicate attributes.");
        names.add(match[1]); validateEntities(match[2]); position = attribute.lastIndex;
      }
      if (!root) root = opening[1];
      if (!opening[3]) stack.push(opening[1]);
      else if (!stack.length) closedRoot = true;
    }
    cursor = end + 1;
  }
  if (stack.length || !root || !["urlset", "sitemapindex"].includes(localName(root) ?? "")) throw new Error("Invalid sitemap XML: expected a complete urlset or sitemapindex.");
  return root;
}

export function parseSitemap(xml: string, baseUrl: string): { urls: string[]; sitemaps: string[] } {
  const body = xml.replace(/^\uFEFF/, "");
  const rootName = validateXml(body);
  const $ = cheerio.load(body, { xmlMode: true });
  const root = $.root().children().filter((_, el) => el.type === "tag" && el.tagName === rootName).first();
  const namespace = (element: Element): string | null => {
    const attribute = prefix(element.tagName) ? `xmlns:${prefix(element.tagName)}` : "xmlns";
    let current = $(element);
    while (current.length) {
      const uri = current.attr(attribute);
      if (uri !== undefined) return uri;
      current = current.parent();
    }
    return prefix(element.tagName) ? `unbound:${prefix(element.tagName)}` : null;
  };
  $("*").each((_, element) => {
    if ("tagName" in element && namespace(element)?.startsWith("unbound:")) throw new Error("Invalid sitemap XML: undeclared namespace prefix.");
  });
  const rootNamespace = root[0] ? namespace(root[0]) : null;
  const urls = new Set<string>();
  const sitemaps = new Set<string>();
  const index = localName(rootName) === "sitemapindex";
  root.children().each((_, el) => {
    if (localName(el.tagName) !== (index ? "sitemap" : "url") || namespace(el) !== rootNamespace) return;
    $(el).children().filter((_, child) => localName(child.tagName) === "loc" && namespace(child) === rootNamespace).each((_, loc) => {
      const raw = $(loc).text().trim();
      const url = raw ? normalizeUrl(raw, baseUrl) : null;
      if (url) (index ? sitemaps : urls).add(url);
    });
  });
  return { urls: [...urls], sitemaps: [...sitemaps] };
}
