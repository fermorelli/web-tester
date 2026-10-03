import { describe, expect, it, vi } from "vitest";
import { crawlSite, type PageFetcher } from "@/crawler/crawl";
import { RequestFailure, type FetchOptions, type FetchResult } from "@/crawler/http";

const origin = "https://audit.example.org";
const root = `${origin}/`;
function response(url: string, body = "", statusCode = 200, headers: Record<string, string> = {}): FetchResult {
  return { url, body, statusCode, headers: { "content-type": "text/html", ...headers }, redirects: [], responseTimeMs: 3 };
}
function transport(fixtures: Record<string, FetchResult | Error>) {
  return vi.fn<PageFetcher>(async (url, options) => {
    if (options.beforeRequest) await options.beforeRequest(url);
    const fixture = fixtures[url];
    if (fixture instanceof Error) throw fixture;
    return fixture ?? response(url, "", 404);
  });
}
const html = (links = "", extra = "") => `<html><head><title>Audit fixture title</title></head><body><h1>Fixture</h1><main>${"Useful words ".repeat(160)}</main>${links}${extra}</body></html>`;

describe("bounded site crawler", () => {
  it("normalizes links, stays on domain, skips assets, honors robots, records errors and relationships", async () => {
    const fetcher = transport({
      [`${origin}/robots.txt`]: response(`${origin}/robots.txt`, "User-agent: *\nDisallow: /private"),
      [root]: response(root, html('<a href="/ok?utm_source=x#one">ok</a><a href="/ok">duplicate</a><a href="/private">private</a><a href="/bad">bad</a><a href="https://external.example.org/">external</a><a href="/a.pdf">pdf</a><a href="/cart">cart</a>')),
      [`${origin}/ok`]: response(`${origin}/ok`, html('<a href="/">home</a>')),
      [`${origin}/bad`]: response(`${origin}/bad`, "Error", 500),
    });
    const onPage = vi.fn();
    const result = await crawlSite(root, { fetcher, onPage });
    expect(result.pages.map(page => page.url)).toEqual([root, `${origin}/ok`, `${origin}/private`, `${origin}/bad`]);
    expect(result.pages.find(page => page.url.endsWith("/private"))).toMatchObject({ blockedByRobots: true, parsed: null, statusCode: null });
    expect(result.pages.find(page => page.url.endsWith("/bad"))?.statusCode).toBe(500);
    expect(fetcher.mock.calls.map(([url]) => url)).not.toContain(`${origin}/private`);
    expect(fetcher.mock.calls.some(([url]) => url.includes("external") || url.endsWith(".pdf") || url.endsWith("/cart"))).toBe(false);
    expect(result.pages.find(page => page.url.endsWith("/ok"))?.depth).toBe(1);
    expect(result.relationships).toContainEqual(expect.objectContaining({ source: root, target: `${origin}/ok` }));
    expect(onPage).toHaveBeenCalledTimes(4);
  });

  it("reads sitemap indexes, marks navigation reachability and reserves space for sitemap samples", async () => {
    const fetcher = transport({
      [`${origin}/robots.txt`]: response(`${origin}/robots.txt`, "User-agent: *\nAllow: /\nSitemap: https://audit.example.org/custom.xml"),
      [`${origin}/custom.xml`]: response(`${origin}/custom.xml`, `<sitemapindex><sitemap><loc>${origin}/part.xml</loc></sitemap></sitemapindex>`),
      [`${origin}/part.xml`]: response(`${origin}/part.xml`, `<urlset><url><loc>${origin}/from-map</loc></url><url><loc>${origin}/ok</loc></url></urlset>`),
      [root]: response(root, html('<a href="/ok">ok</a>')),
      [`${origin}/ok`]: response(`${origin}/ok`, html()),
      [`${origin}/from-map`]: response(`${origin}/from-map`, html()),
    });
    const result = await crawlSite(root, { fetcher });
    expect(result.sitemap.found).toBe(true);
    expect(result.sitemap.documents).toHaveLength(2);
    expect(result.pages.find(page => page.url.endsWith("/ok"))).toMatchObject({ inSitemap: true, depth: 1, discoveredFrom: [root] });
    expect(result.pages.find(page => page.url.endsWith("/from-map"))).toMatchObject({ inSitemap: true, depth: null, discoveredFrom: [] });
  });

  it("never exceeds the page/concurrency budgets and keeps partial successes after a failed request", async () => {
    let active = 0;
    let maximum = 0;
    const fixtureFetcher = transport({
      [root]: response(root, html(Array.from({ length: 20 }, (_, i) => `<a href="/p${i}">${i}</a>`).join(""))),
      [`${origin}/p0`]: new RequestFailure("Timeout", `${origin}/p0`),
    });
    const fetcher: PageFetcher = async (url, options) => {
      active++; maximum = Math.max(maximum, active);
      try { await new Promise(resolve => setTimeout(resolve, 2)); return await fixtureFetcher(url, options); }
      finally { active--; }
    };
    const result = await crawlSite(root, { maxPages: 5, fetcher });
    expect(result.pages).toHaveLength(5);
    expect(maximum).toBeLessThanOrEqual(3);
    expect(result.pages.find(page => page.url.endsWith("/p0"))?.error).toBe("Timeout");
    expect(result.warnings.some(warning => warning.includes("limit of 5 pages"))).toBe(true);
  });

  it("does not crawl when robots cannot be checked and retains the reason", async () => {
    const fetcher = transport({ [`${origin}/robots.txt`]: response(`${origin}/robots.txt`, "Server down", 503) });
    const result = await crawlSite(root, { fetcher });
    expect(result.pages[0].blockedByRobots).toBe(true);
    expect(result.robots.error).toContain("503");
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([`${origin}/robots.txt`]);
  });

  it("checks only bounded internal images with HEAD and never guesses absent Content-Length", async () => {
    const fixtureFetcher = transport({
      [root]: response(root, html("", '<img src="/large.png"><img src="/unknown.png"><img src="https://cdn.example.net/pic.png">')),
    });
    const fetcher = vi.fn(async (url: string, options: FetchOptions) => {
      if (options.method === "HEAD") return response(url, "", 200, url.endsWith("large.png") ? { "content-length": "900000" } : {});
      return fixtureFetcher(url, options);
    });
    const result = await crawlSite(root, { fetcher });
    expect(result.pages[0].parsed?.images.map(image => image.contentLength)).toEqual([900000, null, null]);
    expect(fetcher.mock.calls.filter(([, options]) => options.method === "HEAD")).toHaveLength(2);
  });

  it("resolves depth for a sitemap URL fetched alongside the initial redirect destination", async () => {
    const home = `${origin}/home`;
    const fetcher = transport({
      [`${origin}/sitemap.xml`]: response(`${origin}/sitemap.xml`, `<urlset><url><loc>${home}</loc></url></urlset>`),
      [root]: { ...response(home, html()), redirects: [{ url: root, statusCode: 301, location: home }] },
      [home]: response(home, html()),
    });
    const result = await crawlSite(root, { fetcher });
    expect(result.pages.find(page => page.url === home)?.depth).toBe(0);
    expect(result.pages.find(page => page.url === root)?.depth).toBe(0);
  });

  it("checks robots before redirect destinations and retains the chain when blocked", async () => {
    const fixture = transport({ [`${origin}/robots.txt`]: response(`${origin}/robots.txt`, "User-agent: *\nDisallow: /private") });
    const fetcher: PageFetcher = async (url, options) => {
      if (url !== root) return fixture(url, options);
      const target = `${origin}/private`;
      try { await options.beforeRequest?.(target); }
      catch (error) { throw new RequestFailure((error as Error).message, target, [{ url, statusCode: 301, location: target }], 301); }
      throw new Error("Robots guard was not enforced");
    };
    const result = await crawlSite(root, { fetcher });
    expect(result.pages[0]).toMatchObject({ blockedByRobots: true, indexable: null, finalUrl: `${origin}/private`, statusCode: 301 });
    expect(result.pages[0].redirects).toHaveLength(1);
    expect(fixture.mock.calls.map(([url]) => url)).not.toContain(`${origin}/private`);
  });

  it("hard-clamps requested page counts to 100 and leaves unverified indexability unknown", async () => {
    const fetcher = transport({
      [root]: response(root, html(Array.from({ length: 110 }, (_, i) => `<a href="/p${i}">${i}</a>`).join(""))),
      [`${origin}/p0`]: new RequestFailure("Timeout", `${origin}/p0`),
      [`${origin}/p1`]: response(`${origin}/p1`, "PDF bytes", 200, { "content-type": "application/pdf" }),
    });
    const result = await crawlSite(root, { maxPages: 200, fetcher });
    expect(result.pages).toHaveLength(100);
    expect(result.limits.maxPages).toBe(100);
    expect(result.pages.find(page => page.url.endsWith("/p0"))?.indexable).toBeNull();
    expect(result.pages.find(page => page.url.endsWith("/p1"))?.indexable).toBeNull();
  });
});
