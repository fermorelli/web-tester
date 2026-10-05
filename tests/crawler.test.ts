import { describe, expect, it, vi } from "vitest";
import { crawlSite, type PageFetcher } from "@/crawler/crawl";
import { RequestFailure, type FetchOptions, type FetchResult } from "@/crawler/http";
import { isInCrawlScope } from "@/crawler/url";
import { generateIssues } from "@/issues/generate";

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
  it("audits the portfolio project without downloading or reporting its sibling GitHub Pages projects", async () => {
    const host = "https://fermorelli.github.io";
    const portfolio = `${host}/new-portfolio/`;
    const siblings = [`${host}/E-commerce/`, `${host}/traveling-planner/`, `${host}/weather-dashboard/`];
    const map = `${host}/maps/projects.xml`;
    const fetcher = transport({
      [`${host}/robots.txt`]: response(`${host}/robots.txt`, `User-agent: *\nAllow: /\nSitemap: ${map}`),
      [map]: response(map, `<urlset>${[portfolio, ...siblings].map(url => `<url><loc>${url}</loc></url>`).join("")}</urlset>`),
      [portfolio]: response(portfolio, html('<a href="/E-commerce">Store</a><a href="/traveling-planner/">Travel</a><a href="/weather-dashboard/">Weather</a><a href="#work">Work</a>')),
    });

    const result = await crawlSite(portfolio, { fetcher });

    expect(result.pages.map(page => page.url)).toEqual([portfolio]);
    expect(result.relationships).toEqual([]);
    expect(result.sitemap.urls).toEqual([portfolio]);
    expect(result.sitemap.documents).toEqual([map]);
    expect(result.limits).toMatchObject({ scope: { kind: "path", rootUrl: portfolio }, analysisVersion: 2 });
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([`${host}/robots.txt`, map, `${host}/sitemap.xml`, portfolio]);
    const metadata = fetcher.mock.calls.filter(([url]) => url !== portfolio);
    expect(metadata.every(([, options]) => options.scope?.kind === "host")).toBe(true);
    expect(fetcher.mock.calls.find(([url]) => url === portfolio)?.[1].scope?.kind).toBe("path");
    const issues = generateIssues({ ...result, startUrl: portfolio, domain: "fermorelli.github.io" });
    expect(issues.every(issue => issue.affectedUrls.every(url => isInCrawlScope(url, result.limits.scope!)))).toBe(true);
  });

  it("keeps submitted query state and allows a slash redirect while discovering only project descendants", async () => {
    const start = `${origin}/project?lang=es`;
    const final = `${origin}/project/?lang=es`;
    const child = `${origin}/project/about?lang=es`;
    const sitemapChild = `${origin}/project/contact`;
    const fetcher = transport({
      [`${origin}/sitemap.xml`]: response(`${origin}/sitemap.xml`, `<urlset><url><loc>${sitemapChild}</loc></url><url><loc>${origin}/other-project/</loc></url></urlset>`),
      [start]: { ...response(final, html('<a href="about?lang=es">About</a><a href="../other-project/">Other project</a><a href="/project-old/">Prefix collision</a>')), redirects: [{ url: start, statusCode: 301, location: final }] },
      [child]: response(child, html()),
      [sitemapChild]: response(sitemapChild, html()),
    });

    const result = await crawlSite(start, { fetcher });

    expect(result.pages.map(page => page.url).sort()).toEqual([start, child, sitemapChild].sort());
    expect(result.pages[0]).toMatchObject({ finalUrl: final, depth: 0, parsed: expect.any(Object) });
    expect(result.pages.find(page => page.url === child)?.depth).toBe(1);
    expect(result.sitemap.urls).toEqual([sitemapChild]);
    expect(result.limits.scope).toEqual({ kind: "path", rootUrl: `${origin}/project` });
    expect(fetcher.mock.calls.some(([url]) => url === start)).toBe(true);
    expect(fetcher.mock.calls.some(([url]) => url.includes("other-project") || url.includes("project-old"))).toBe(false);
  });

  it("blocks a project redirect before fetching the sibling and retains its observed redirect evidence", async () => {
    const project = `${origin}/project/`;
    const redirect = `${origin}/project/escape`;
    const target = `${origin}/other-project/`;
    const fixtureFetcher = transport({ [project]: response(project, html('<a href="escape">Escaping redirect</a>')) });
    const fetcher = vi.fn<PageFetcher>(async (url, options) => {
      if (url !== redirect) return fixtureFetcher(url, options);
      try { await options.beforeRequest?.(target); }
      catch (error) { throw new RequestFailure((error as Error).message, target, [{ url, statusCode: 301, location: target }], 301); }
      throw new Error("The scope policy did not reject the sibling redirect");
    });

    const result = await crawlSite(project, { fetcher });

    expect(result.pages.find(page => page.url === redirect)).toMatchObject({
      finalUrl: target, statusCode: 301, parsed: null, indexable: null,
      error: expect.stringContaining("selected audit scope"),
      redirects: [{ url: redirect, statusCode: 301, location: target }],
    });
    expect(fetcher.mock.calls.map(([url]) => url)).not.toContain(target);
    expect(result.relationships).toEqual([{ source: project, target: redirect, text: "Escaping redirect", nofollow: false }]);
  });

  it("checks only in-scope image sizes in a project audit", async () => {
    const project = `${origin}/project/`;
    const localImage = `${origin}/project/image.png`;
    const siblingImage = `${origin}/other-project/image.png`;
    const rootImage = `${origin}/shared-image.png`;
    const fixtureFetcher = transport({ [project]: response(project, html("", `<img src="image.png"><img src="${siblingImage}"><img src="${rootImage}">`)) });
    const fetcher = vi.fn<PageFetcher>(async (url, options) => options.method === "HEAD"
      ? response(url, "", 200, { "content-length": "12345" }) : fixtureFetcher(url, options));

    const result = await crawlSite(project, { fetcher });

    expect(fetcher.mock.calls.filter(([, options]) => options.method === "HEAD").map(([url]) => url)).toEqual([localImage]);
    expect(result.pages[0].parsed?.images.map(image => image.contentLength)).toEqual([12345, null, null]);
  });

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
