import { describe, expect, it } from "vitest";
import { auditRootUrl, inferCrawlScope, isCrawlableUrl, isInCrawlScope, isInternalUrl, normalizeUrl, siteHostname } from "@/crawler/url";

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

describe("submitted website scope", () => {
  const scope = inferCrawlScope("https://fermorelli.github.io/new-portfolio/?lang=es#work");

  it("preserves the submitted path while excluding query state from the audit root", () => {
    expect(auditRootUrl("HTTPS://FerMorelli.GitHub.io:443/new-portfolio/?lang=es&utm_source=test#work"))
      .toBe("https://fermorelli.github.io/new-portfolio/");
    expect(scope).toEqual({ kind: "path", rootUrl: "https://fermorelli.github.io/new-portfolio/" });
    expect(inferCrawlScope("fermorelli.github.io?lang=es")).toEqual({ kind: "host", rootUrl: "https://fermorelli.github.io/" });
    expect(inferCrawlScope("https://example.com/project/index.html").rootUrl).toBe("https://example.com/project/index.html");
    expect(() => auditRootUrl("https://user:secret@example.com/project/")).toThrow();
  });

  it.each([
    "https://fermorelli.github.io/new-portfolio",
    "https://fermorelli.github.io/new-portfolio/",
    "https://fermorelli.github.io/new-portfolio/about?lang=es",
    "https://fermorelli.github.io/new-portfolio/about?return=%2Fother",
    "http://www.fermorelli.github.io/new-portfolio/contact",
    "https://fermorelli.github.io/new-portfolio/work/../about",
    "about",
  ])("allows the exact path and slash-delimited descendants: %s", url => {
    expect(isInCrawlScope(url, scope)).toBe(true);
  });

  it.each([
    "https://fermorelli.github.io/",
    "https://fermorelli.github.io/E-commerce/",
    "https://fermorelli.github.io/traveling-planner/",
    "https://fermorelli.github.io/weather-dashboard/",
    "https://fermorelli.github.io/new-portfolio-old/",
    "https://fermorelli.github.io/new-portfolio%2Fother/",
    "https://fermorelli.github.io/New-Portfolio/",
    "https://fermorelli.github.io/new-portfolio/../E-commerce/",
    "https://fermorelli.github.io/new-portfolio/%2e%2e/E-commerce/",
    "https://fermorelli.github.io/new-portfolio/%2e%2e%2fE-commerce/",
    "https://fermorelli.github.io/new-portfolio/%5C..%5CE-commerce/",
    "https://fermorelli.github.io/new-portfolio/%252e%252e%252fE-commerce/",
    "https://api.fermorelli.github.io/new-portfolio/",
    "https://fermorelli.github.io:3000/new-portfolio/",
    "https://user:secret@fermorelli.github.io/new-portfolio/",
    "../E-commerce/",
    "mailto:x@example.com",
  ])("excludes sibling projects, prefix collisions, escaped paths and other hosts: %s", url => {
    expect(isInCrawlScope(url, scope)).toBe(false);
  });

  it("keeps host classification separate and retains whole-host audits at the root", () => {
    const sibling = "https://fermorelli.github.io/E-commerce/";
    expect(isInternalUrl(sibling, scope.rootUrl)).toBe(true);
    expect(isInCrawlScope(sibling, scope)).toBe(false);
    expect(isInCrawlScope(sibling, inferCrawlScope("https://fermorelli.github.io/"))).toBe(true);
    expect(isInCrawlScope("https://other.example/new-portfolio/", inferCrawlScope("https://fermorelli.github.io/"))).toBe(false);
    expect(isInCrawlScope("https://fermorelli.github.io/new-portfolio/%2e%2e%2fE-commerce/", inferCrawlScope("https://fermorelli.github.io/"))).toBe(true);
  });

  it("does not widen a submitted path by collapsing repeated slash segments", () => {
    const repeated = inferCrawlScope("https://example.com/project//");
    expect(repeated.rootUrl).toBe("https://example.com/project//");
    expect(isInCrawlScope("https://example.com/project//child", repeated)).toBe(true);
    expect(isInCrawlScope("https://example.com/project/child", repeated)).toBe(false);
    expect(isInCrawlScope("https://example.com/project", repeated)).toBe(false);
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
