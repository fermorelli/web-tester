import { describe, expect, it } from "vitest";
import { parsePage } from "../src/parsers/page";

describe("HTML page parsing", () => {
  it("extracts a normalized title and relative canonical while retaining raw evidence", () => {
    const page = parsePage('<title>  Mi &amp; sitio  </title><link rel="alternate CANONICAL" href="../preferida?utm_source=x#fragment">', "https://example.com/path/page");
    expect(page.title).toBe("Mi & sitio");
    expect(page.canonical).toBe("https://example.com/preferida");
    expect(page.canonicalRaw).toBe("../preferida?utm_source=x#fragment");
    expect(page.canonicalCount).toBe(1);
    expect(page.canonicalInvalid).toBe(false);
  });
  it("distinguishes missing, empty, invalid and multiple canonical tags", () => {
    expect(parsePage("<p>Hello</p>", "https://example.com/")).toMatchObject({ title: null, canonicalCount: 0, canonicalInvalid: false });
    expect(parsePage('<link rel="canonical" href="">', "https://example.com/")).toMatchObject({ canonical: null, canonicalInvalid: true });
    expect(parsePage('<link rel="canonical" href="javascript:alert(1)">', "https://example.com/")).toMatchObject({ canonical: null, canonicalInvalid: true });
    expect(parsePage('<link rel="canonical" href="/a"><link rel="canonical" href="/b">', "https://example.com/").canonicalCount).toBe(2);
  });
  it("merges meta and applicable X-Robots-Tag directives, including none", () => {
    const page = parsePage('<meta name="ROBOTS" content="NONE"><meta name="SiteInspectorBot" content="max-snippet:10">', "https://example.com/", { "X-Robots-Tag": "noarchive, unrelatedbot: index, follow, Googlebot: noimageindex" });
    expect(page.noindex).toBe(true);
    expect(page.nofollow).toBe(true);
    expect(page.robots).toContain("noarchive");
    expect(page.robots).toContain("noimageindex");
    expect(page.robots).not.toContain("index");
    expect(page.robots).not.toContain("follow");
    expect(page.robotDirectives).toContainEqual({ source: "meta", agent: "siteinspectorbot", directives: ["max-snippet:10"] });
    expect(parsePage('', 'https://example.com/', { 'x-robots-tag': 'otherbot: noindex, nofollow' }).noindex).toBe(false);
  });
  it("evaluates Googlebot metadata restrictions without applying other crawler scopes", () => {
    const page = parsePage('<meta name="robots" content="nofollow"><meta name="Googlebot" content="noindex, index"><meta name="bingbot" content="noarchive">', 'https://example.com/');
    expect(page.noindex).toBe(true);
    expect(page.nofollow).toBe(true);
    expect(page.robots).not.toContain('noarchive');
    expect(page.robotDirectives).toContainEqual({ source: 'meta', agent: 'bingbot', directives: ['noarchive'] });
    expect(parsePage('<meta name="SiteInspectorBot" content="noindex">', 'https://example.com/').noindex).toBe(false);
    expect(parsePage('<meta name="googlebot-news" content="noindex">', 'https://example.com/').noindex).toBe(false);
    const headers = parsePage('', 'https://example.com/', { 'x-robots-tag': 'otherbot: noindex, nofollow, googlebot: noindex, max-snippet: 20' });
    expect(headers.noindex).toBe(true);
    expect(headers.nofollow).toBe(false);
    expect(headers.robots).toContain('max-snippet:20');
  });
  it("extracts heading order and empty headings and counts visible main text", () => {
    const page = parsePage('<html lang="es"><title>Title</title><nav>Ignore navigation</nav><main><h1>Principal</h1><h3>Sección</h3><h2> </h2><p>Uno dos tres</p><script>ignore these words</script></main></html>', "https://example.com/");
    expect(page.h1).toEqual(["Principal"]);
    expect(page.headings).toEqual([{ level: 1, text: "Principal" }, { level: 3, text: "Sección" }, { level: 2, text: "" }]);
    expect(page.wordCount).toBe(5);
    expect(page.language).toBe("es");
    expect(page.contentSample).not.toContain("ignore");
  });
  it("resolves link and image URLs, excludes non-HTTP links, and preserves alt distinctions", () => {
    const page = parsePage('<base href="https://example.com/sub/"><a href="../a" rel="external NOFOLLOW"> One </a><a href="https://other.com/x">Two</a><a href="mailto:test@example.com">Email</a><a href="#top">Top</a><img src="a.jpg"><img src="b.jpg" alt=""><img src="c.jpg" alt="Photo">', "https://example.com/");
    expect(page.links).toEqual([{ url: "https://example.com/a", text: "One", nofollow: true, internal: true }, { url: "https://other.com/x", text: "Two", nofollow: false, internal: false }]);
    expect(page.images.map(image => image.alt)).toEqual([null, "", "Photo"]);
    expect(page.images[0].src).toBe("https://example.com/sub/a.jpg");
    expect(page.images.every(image => image.contentLength === null)).toBe(true);
  });
  it("detects graph and nested schema types, invalid JSON, and basic inconsistencies", () => {
    const page = parsePage(`<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Organization","@id":"#brand","name":"A"},{"@type":"Organization","@id":"#brand","name":"B"},{"@type":"Article","author":{"@type":"Person","name":"Ana"}}]}</script><script type="application/ld+json">{bad}</script><script type="application/ld+json">{"@type":"Thing","url":"javascript:x"}</script>`, "https://example.com/");
    expect(page.schemaTypes).toEqual(["Organization", "Article", "Person", "Thing"]);
    expect(page.jsonLdCount).toBe(3);
    expect(page.jsonLdErrors).toHaveLength(1);
    expect(page.schemaWarnings.some(warning => warning.includes("repeated @id"))).toBe(true);
    expect(page.schemaWarnings.some(warning => warning.includes("missing @context"))).toBe(true);
    expect(page.schemaWarnings.some(warning => warning.includes("HTTP URL"))).toBe(true);
  });
  it("extracts social metadata and recognizable tracking from scripts", () => {
    const page = parsePage('<meta property="og:title" content="Share"><meta name="twitter:card" content="summary"><script src="https://www.googletagmanager.com/gtag/js?id=G-123"></script><script>fbq("init", "123");</script><script src="https://www.clarity.ms/tag/abc"></script>', "https://example.com/");
    expect(page.social.openGraph["og:title"]).toBe("Share");
    expect(page.social.twitter["twitter:card"]).toBe("summary");
    expect(page.tracking).toEqual(["Google Analytics", "Meta Pixel", "Microsoft Clarity"]);
    expect(parsePage('<p>Example text says GTM-ABCD</p>', 'https://example.com/').tracking).toEqual([]);
  });
  it("hashes normalized text consistently despite whitespace and navigation changes", () => {
    const first = parsePage('<nav>A</nav><main><p>Hello WORLD</p></main>', 'https://example.com/a');
    const second = parsePage('<nav>Totally different</nav><main><p>  hello   world  </p></main>', 'https://example.com/b');
    expect(first.contentHash).toBe(second.contentHash);
  });
  it("does not count title metadata as visible body content", () => {
    expect(parsePage('<title>Not visible body text</title>', 'https://example.com/').wordCount).toBe(0);
  });
});
