import { describe, expect, it } from "vitest";
import { isCrawlableUrl, isInternalUrl, normalizeUrl, siteHostname } from "@/crawler/url";

describe("URL normalization", () => {
  it("canonicalizes host, default port, fragment and tracking parameters while retaining useful query state", () => {
    expect(normalizeUrl("HTTPS://WWW.Example.COM.:443/products?utm_source=test&fbclid=123&page=2&lang=es#reviews"))
      .toBe("https://www.example.com/products?lang=es&page=2");
    expect(normalizeUrl("example.com")).toBe("https://example.com/");
  });

  it("resolves relative and protocol-relative links and retains encoded path semantics", () => {
    expect(normalizeUrl("../about?b=2&a=1#team", "https://example.com/blog/post")).toBe("https://example.com/about?a=1&b=2");
    expect(normalizeUrl("//www.example.com/path", "https://example.com/")).toBe("https://www.example.com/path");
    expect(normalizeUrl("https://example.com/a%2Fb/")).toBe("https://example.com/a%2Fb/");
  });

  it.each(["", "  ", "mailto:person@example.com", "tel:+123456", "javascript:alert(1)", "data:text/html,test", "https://user:pass@example.com/", "http://["])("ignores unusable input %s", (url) => {
    expect(normalizeUrl(url)).toBeNull();
  });

  it("does not merge pagination, duplicate meaningful parameters, or case-sensitive paths", () => {
    expect(normalizeUrl("https://example.com/Products?page=2&tag=b&tag=a"))
      .toBe("https://example.com/Products?page=2&tag=b&tag=a");
    expect(normalizeUrl("https://example.com/Products?page=1")).not.toBe(normalizeUrl("https://example.com/products?page=2"));
  });
});

describe("crawl URL classification", () => {
  const base = "https://example.com/";

  it.each(["https://example.com/about", "http://example.com/about", "https://www.example.com/about", "https://EXAMPLE.COM./", "/relative"])("recognizes the exact host and www alias: %s", (url) => {
    expect(isInternalUrl(url, base)).toBe(true);
  });

  it.each(["https://api.example.com/", "https://example.com.evil.test/", "https://other.example/", "https://example.com:3000/", "mailto:x@example.com", "http://["])("excludes external, different-port and invalid URLs: %s", (url) => {
    expect(isInternalUrl(url, base)).toBe(false);
  });

  it("groups www aliases without treating subdomains as the same site", () => {
    expect(siteHostname("https://WWW.Example.com./path")).toBe("example.com");
    expect(siteHostname("https://shop.example.com/")).toBe("shop.example.com");
  });

  it.each(["https://example.com/photo.JPG?version=2", "https://example.com/style.css", "https://example.com/file.pdf", "https://example.com/sitemap.xml", "https://example.com/wp-admin/", "https://example.com/login", "https://example.com/cart/item", "https://example.com/products?sort=name", "https://example.com/?s=test", "https://example.com/?add-to-cart=12", "mailto:x@example.com"])("skips assets and unhelpful crawl destinations: %s", (url) => {
    expect(isCrawlableUrl(url)).toBe(false);
  });

  it.each(["https://example.com/", "https://example.com/product", "https://example.com/blog?page=2", "https://example.com/admin-guide", "https://example.com/news/feed-quality"])("retains normal pages and pagination: %s", (url) => {
    expect(isCrawlableUrl(url)).toBe(true);
  });

  it("enforces the maximum URL length", () => {
    expect(isCrawlableUrl(`https://example.com/${"a".repeat(2048)}`)).toBe(false);
  });
});
