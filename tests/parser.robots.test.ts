import { describe, expect, it } from "vitest";
import { parseRobots } from "../src/parsers/robots";

describe("robots.txt evaluator", () => {
  it("honors specific bot groups instead of merging wildcard restrictions", () => {
    const robots = parseRobots("User-agent: *\nDisallow: /\nUser-agent: SiteInspectorBot\nDisallow: /private\nAllow: /private/public\nCrawl-delay: 0.5\nSitemap: https://example.com/map.xml");
    expect(robots.isAllowed("https://example.com/")).toBe(true);
    expect(robots.isAllowed("https://example.com/private/data")).toBe(false);
    expect(robots.isAllowed("https://example.com/private/public")).toBe(true);
    expect(robots.crawlDelay).toBe(0.5);
    expect(robots.sitemaps).toEqual(["https://example.com/map.xml"]);
  });
  it("merges equally specific groups, uses longest match and favors Allow on ties", () => {
    const robots = parseRobots("User-agent: SiteInspectorBot\nDisallow: /x\nUser-agent: SiteInspectorBot\nAllow: /x\nDisallow: /x/private\nUser-agent: Other\nDisallow: /");
    expect(robots.isAllowed("https://example.com/x")).toBe(true);
    expect(robots.isAllowed("https://example.com/x/private")).toBe(false);
  });
  it("supports wildcard and end anchors on the path plus query", () => {
    const robots = parseRobots("User-agent: *\nDisallow: /*.pdf$\nDisallow: /*?secret=*\nAllow: /public/*.pdf$");
    expect(robots.isAllowed("https://example.com/manual.pdf")).toBe(false);
    expect(robots.isAllowed("https://example.com/manual.pdf?download=1")).toBe(true);
    expect(robots.isAllowed("https://example.com/public/manual.pdf")).toBe(true);
    expect(robots.isAllowed("https://example.com/a?secret=123")).toBe(false);
  });
  it("supports comments, multiple agents per group, percent encoding and empty disallow", () => {
    const robots = parseRobots("\uFEFFUser-agent: Other\nUser-agent: *\nDisallow:\nDisallow: /caf%C3%A9 # comment\nDisallow: /a%2Fb\nAllow: /a/b\nDisallow: /%7Ename");
    expect(robots.isAllowed("https://example.com/other")).toBe(true);
    expect(robots.isAllowed("https://example.com/café")).toBe(false);
    expect(robots.isAllowed("https://example.com/a%2Fb")).toBe(false);
    expect(robots.isAllowed("https://example.com/a/b")).toBe(true);
    expect(robots.isAllowed("https://example.com/~name")).toBe(false);
  });
  it("does not let a blank line discard adjacent user agents or treat invalid delay as valid", () => {
    const robots = parseRobots("User-agent: SiteInspectorBot\n\nUser-agent: Partner\nDisallow: /hidden\nCrawl-delay: nope\nSitemap: file:///tmp/map.xml");
    expect(robots.isAllowed("https://example.com/hidden")).toBe(false);
    expect(robots.crawlDelay).toBeNull();
    expect(robots.sitemaps).toEqual([]);
  });
});
