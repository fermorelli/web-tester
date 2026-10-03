import { describe, expect, it } from "vitest";
import { parseSitemap } from "../src/parsers/sitemap";

describe("sitemap XML parsing", () => {
  it("reads URL sets, decodes XML entities, resolves relative URLs and deduplicates", () => {
    const result = parseSitemap('<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://example.com/a?a=1&amp;b=2</loc></url><url><loc>/b</loc></url><url><loc>/b</loc></url></urlset>', "https://example.com/sitemap.xml");
    expect(result).toEqual({ urls: ["https://example.com/a?a=1&b=2", "https://example.com/b"], sitemaps: [] });
  });
  it("handles namespace prefixes and excludes image loc entries", () => {
    const result = parseSitemap('<s:urlset xmlns:s="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:m="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"><m:url><s:loc>https://example.com/a</s:loc><image:image><image:loc>https://example.com/a.jpg</image:loc></image:image></m:url></s:urlset>', "https://example.com/");
    expect(result.urls).toEqual(["https://example.com/a"]);
  });
  it("reads sitemap indexes instead of treating child documents as page URLs", () => {
    expect(parseSitemap('<sitemapindex><sitemap><loc><![CDATA[https://example.com/one.xml]]></loc></sitemap><sitemap><loc>/two.xml</loc></sitemap></sitemapindex>', 'https://example.com/index.xml')).toEqual({ urls: [], sitemaps: ['https://example.com/one.xml', 'https://example.com/two.xml'] });
  });
  it.each([
    '<html><body>Error page</body></html>',
    '<urlset><url><loc>https://example.com/a</loc></url>',
    '<urlset><url></urlset>',
    '<urlset><url><loc>https://example.com/?a=1&b=2</loc></url></urlset>',
    '<urlset invalid=unquoted></urlset>',
    '<urlset/><urlset/>',
    '<s:urlset><s:url><s:loc>https://example.com/</s:loc></s:url></s:urlset>',
    '<!DOCTYPE urlset [<!ENTITY x SYSTEM "file:///secret">]><urlset/>',
    'not xml',
  ])("rejects malformed/non-sitemap documents: %s", xml => {
    expect(() => parseSitemap(xml, 'https://example.com/')).toThrow(/Invalid sitemap XML/);
  });
  it("does not invent links from empty loc elements or non-HTTP URLs", () => {
    expect(parseSitemap('<urlset><url><loc> </loc></url><url><loc>file:///etc/passwd</loc></url></urlset>', 'https://example.com/').urls).toEqual([]);
  });
});
