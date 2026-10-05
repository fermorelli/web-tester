import { EventEmitter } from "node:events";
import http from "node:http";
import https from "node:https";
import { PassThrough } from "node:stream";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RequestFailure, safeFetch } from "@/crawler/http";
import { isPublicIp, resolvePublicAddress, UnsafeUrlError, validatePublicUrl } from "@/crawler/security";

const publicResolver = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);

type MockResponse = {
  status?: number;
  headers?: Record<string, string>;
  body?: string | Buffer;
  chunks?: Buffer[];
  error?: Error;
  aborted?: boolean;
  hang?: boolean;
};

function mockTransport(responses: MockResponse[]) {
  const calls: { url: URL; options: http.RequestOptions; request: EventEmitter & { end: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> } }[] = [];
  const implementation = ((url: URL, options: http.RequestOptions, callback: (response: http.IncomingMessage) => void) => {
    const request = Object.assign(new EventEmitter(), { end: vi.fn(), destroy: vi.fn() });
    calls.push({ url, options, request });
    const next = responses.shift();
    if (!next) throw new Error("Unexpected network request in test");
    request.end.mockImplementation(() => {
      queueMicrotask(() => {
        if (next.error) { request.emit("error", next.error); return; }
        if (next.hang) return;
        const response = Object.assign(new PassThrough(), { statusCode: next.status ?? 200, headers: next.headers ?? {} });
        callback(response as unknown as http.IncomingMessage);
        if (next.aborted) { response.emit("aborted"); return; }
        if (response.destroyed) return;
        for (const chunk of next.chunks ?? [Buffer.from(next.body ?? "ok")]) {
          if (response.destroyed) break;
          response.write(chunk);
        }
        response.end();
      });
    });
    return request;
  }) as unknown as typeof http.request;
  vi.spyOn(http, "request").mockImplementation(implementation);
  vi.spyOn(https, "request").mockImplementation(implementation);
  return calls;
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); publicResolver.mockClear(); });

describe("public URL and DNS validation", () => {
  it.each([
    "http://localhost/", "http://localhost./", "http://app.localhost/", "http://app.internal/",
    "http://metadata.google.internal/", "http://169.254.169.254/", "http://127.0.0.1/",
    "http://127.1/", "http://2130706433/", "http://0x7f000001/", "http://017700000001/",
    "http://10.0.0.1/", "http://192.168.0.1/", "http://[::1]/", "http://[::]/",
    "http://[::ffff:127.0.0.1]/", "http://[::ffff:7f00:1]/", "http://[fc00::1]/", "http://[fe80::1]/",
  ])("blocks private/local and alternate literal forms: %s", (url) => {
    expect(() => validatePublicUrl(url)).toThrow(UnsafeUrlError);
  });

  it.each([
    "0.0.0.0", "100.64.0.1", "172.16.0.1", "172.31.255.255", "192.0.0.1", "192.0.2.1",
    "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "255.255.255.255",
    "2001:db8::1", "2001::1", "2002:7f00:1::", "3fff::1", "64:ff9b::7f00:1", "ff02::1",
  ])("blocks non-public address range %s", (address) => {
    expect(isPublicIp(address)).toBe(false);
  });

  it.each(["file:///etc/passwd", "ftp://example.com/", "javascript:alert(1)", "https://user:secret@example.com/", "https://example.com:3000/", "https://single-host/"])("rejects forbidden scheme, credentials, port or host: %s", (url) => {
    expect(() => validatePublicUrl(url)).toThrow(UnsafeUrlError);
  });

  it("accepts real public IPv4/IPv6 literals and web ports", async () => {
    expect(isPublicIp("8.8.8.8")).toBe(true);
    expect(isPublicIp("2606:4700:4700::1111")).toBe(true);
    expect(validatePublicUrl("https://example.com:443/").port).toBe("");
    const resolver = vi.fn();
    expect(await resolvePublicAddress("http://8.8.8.8/", resolver)).toEqual({ address: "8.8.8.8", family: 4 });
    expect(await resolvePublicAddress("https://[2606:4700:4700::1111]/", resolver)).toEqual({ address: "2606:4700:4700::1111", family: 6 });
    expect(resolver).not.toHaveBeenCalled();
  });

  it("rejects any private address in a mixed DNS answer and empty DNS answers", async () => {
    await expect(resolvePublicAddress("https://example.com/", async () => [
      { address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 },
    ])).rejects.toBeInstanceOf(UnsafeUrlError);
    await expect(resolvePublicAddress("https://example.com/", async () => [])).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it("terminates stalled DNS resolution", async () => {
    vi.useFakeTimers();
    const pending = resolvePublicAddress("https://example.com/", () => new Promise(() => {}));
    const assertion = expect(pending).rejects.toThrow(/Domain resolution timed out/);
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
  });
});

describe("safeFetch connection and redirect boundaries", () => {
  it.each([
    "/E-commerce/", "/new-portfolio-old/", "/new-portfolio/../traveling-planner/",
    "/new-portfolio/%2e%2e/weather-dashboard/", "https://www.example.com/other-project/",
    "/new-portfolio/%2e%2e%2fE-commerce/", "/new-portfolio/%5c..%5ctraveling-planner/",
  ])("blocks a same-host project escape before its policy, DNS or connection: %s", async location => {
    const start = "https://example.com/new-portfolio/";
    const calls = mockTransport([{ status: 302, headers: { location } }]);
    const beforeRequest = vi.fn();
    await expect(safeFetch(start, { scopeUrl: start, beforeRequest }, publicResolver)).rejects.toMatchObject({
      message: expect.stringContaining("outside the selected audit scope"),
      url: new URL(location, start).href, statusCode: 302,
      redirects: [{ url: start, statusCode: 302, location: new URL(location, start).href }],
    });
    expect(calls).toHaveLength(1);
    expect(publicResolver).toHaveBeenCalledTimes(1);
    expect(beforeRequest).toHaveBeenCalledExactlyOnceWith(start);
  });

  it("rejects an out-of-scope initial request without resolving or connecting", async () => {
    const calls = mockTransport([]);
    await expect(safeFetch("https://example.com/other/", { scopeUrl: "https://example.com/project/" }, publicResolver)).rejects.toThrow(/selected audit scope/);
    expect(calls).toHaveLength(0);
    expect(publicResolver).not.toHaveBeenCalled();
  });

  it("allows slash canonicalization, HTTPS and www within the submitted path without losing query state", async () => {
    const start = "http://example.com/new-portfolio?lang=es";
    const final = "https://www.example.com/new-portfolio/?lang=es";
    const calls = mockTransport([{ status: 301, headers: { location: final } }, { body: "Portfolio HTML" }]);
    const result = await safeFetch(start, { scopeUrl: start }, publicResolver);
    expect(result).toMatchObject({ url: final, body: "Portfolio HTML", redirects: [{ url: start, statusCode: 301, location: final }] });
    expect(calls.map(call => call.url.href)).toEqual([start, final]);
  });

  it("permits host metadata outside the project while retaining the original host and DNS guards", async () => {
    const start = "https://example.com/new-portfolio/";
    const options: Parameters<typeof safeFetch>[1] = { scopeUrl: start, scope: { kind: "host", rootUrl: "https://example.com/" } };
    const calls = mockTransport([
      { status: 301, headers: { location: "/maps/main.xml" } }, { body: "<urlset/>" },
      { status: 302, headers: { location: "https://other.example/robots.txt" } },
    ]);
    expect((await safeFetch("https://example.com/sitemap.xml", options, publicResolver)).body).toBe("<urlset/>");
    await expect(safeFetch("https://example.com/robots.txt", options, publicResolver)).rejects.toThrow(/outside the site domain/);
    expect(calls).toHaveLength(3);
    expect(publicResolver).toHaveBeenCalledTimes(3);
  });

  it("pins the validated DNS address without replacing the original TLS hostname", async () => {
    const calls = mockTransport([{ body: "<html>public</html>" }]);
    const resolver = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);
    const result = await safeFetch("https://example.com/", { scopeUrl: "https://example.com/" }, resolver);
    expect(result.body).toBe("<html>public</html>");
    expect(calls[0].url.hostname).toBe("example.com");
    expect(calls[0].options.agent).toBe(false);
    expect(calls[0].options.family).toBe(4);
    const lookup = calls[0].options.lookup as unknown as (host: string, options: object, callback: (error: Error | null, address: string, family: number) => void) => void;
    const callback = vi.fn();
    lookup("example.com", {}, callback);
    expect(callback).toHaveBeenCalledWith(null, "93.184.216.34", 4);
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it("blocks mixed/private DNS before opening a connection", async () => {
    const calls = mockTransport([]);
    await expect(safeFetch("https://example.com/", { scopeUrl: "https://example.com/" }, async () => [
      { address: "93.184.216.34", family: 4 }, { address: "10.1.2.3", family: 4 },
    ])).rejects.toThrow(/private/);
    expect(calls).toHaveLength(0);
  });

  it.each(["https://other.example/private", "https://api.example.com/private", "http://127.0.0.1/private", "http://[::ffff:127.0.0.1]/private", "file:///etc/passwd"])("blocks an unsafe or out-of-scope redirect before the next connection: %s", async (location) => {
    const calls = mockTransport([{ status: 302, headers: { location } }]);
    const promise = safeFetch("https://example.com/", { scopeUrl: "https://example.com/" }, publicResolver);
    await expect(promise).rejects.toMatchObject({ redirects: [{ url: "https://example.com/", statusCode: 302, location: new URL(location).href }], statusCode: 302 });
    expect(calls).toHaveLength(1);
    expect(publicResolver).toHaveBeenCalledTimes(1);
  });

  it("follows relative redirects, invokes policy checks for every hop and preserves the chain", async () => {
    const calls = mockTransport([{ status: 301, headers: { location: "/new" } }, { status: 307, headers: { location: "https://www.example.com/final" } }, { body: "final" }]);
    const beforeRequest = vi.fn();
    const result = await safeFetch("https://example.com/old", { scopeUrl: "https://example.com/", beforeRequest }, publicResolver);
    expect(result.url).toBe("https://www.example.com/final");
    expect(result.body).toBe("final");
    expect(result.redirects).toEqual([
      { url: "https://example.com/old", statusCode: 301, location: "https://example.com/new" },
      { url: "https://example.com/new", statusCode: 307, location: "https://www.example.com/final" },
    ]);
    expect(beforeRequest.mock.calls.map(([url]) => url)).toEqual(calls.map((call) => call.url.href));
    expect(publicResolver).toHaveBeenCalledTimes(3);
  });

  it("revalidates DNS at each redirect and blocks rebinding before the redirected connection", async () => {
    const calls = mockTransport([{ status: 302, headers: { location: "/next" } }]);
    const resolver = vi.fn().mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }]).mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
    await expect(safeFetch("https://example.com/", { scopeUrl: "https://example.com/" }, resolver)).rejects.toThrow(/private/);
    expect(calls).toHaveLength(1);
  });

  it("stops redirect loops and the configured redirect limit before another request", async () => {
    const calls = mockTransport([{ status: 302, headers: { location: "/next" } }, { status: 302, headers: { location: "/" } }]);
    await expect(safeFetch("https://example.com/", { scopeUrl: "https://example.com/" }, publicResolver)).rejects.toThrow(/loop/);
    expect(calls).toHaveLength(2);
    vi.restoreAllMocks();
    const limitedCalls = mockTransport([{ status: 301, headers: { location: "/new" } }]);
    await expect(safeFetch("https://example.com/", { scopeUrl: "https://example.com/", maxRedirects: 0 }, publicResolver)).rejects.toThrow(/redirect limit/);
    expect(limitedCalls).toHaveLength(1);
  });

  it("enforces policy rejection before connecting", async () => {
    const calls = mockTransport([]);
    await expect(safeFetch("https://example.com/private", { scopeUrl: "https://example.com/", beforeRequest: () => { throw new Error("Blocked by robots.txt"); } }, publicResolver)).rejects.toThrow(/robots/);
    expect(calls).toHaveLength(0);
  });

  it("retains HTTP error responses as inspectable evidence", async () => {
    mockTransport([{ status: 404, body: "missing" }]);
    const result = await safeFetch("https://example.com/missing", { scopeUrl: "https://example.com/" }, publicResolver);
    expect(result.statusCode).toBe(404);
    expect(result.body).toBe("missing");
  });

  it("rejects oversized declared and streamed payloads", async () => {
    mockTransport([{ headers: { "content-length": "11" }, body: "small" }, { chunks: [Buffer.from("12345"), Buffer.from("678901")] }]);
    const options = { scopeUrl: "https://example.com/", maxResponseBytes: 10 };
    await expect(safeFetch("https://example.com/", options, publicResolver)).rejects.toThrow(/exceeds the limit/);
    await expect(safeFetch("https://example.com/", options, publicResolver)).rejects.toThrow(/exceeds the limit/);
  });

  it("preserves the failing response HTTP status when body reading fails after a redirect", async () => {
    mockTransport([{ status: 301, headers: { location: "/unavailable" } }, { status: 503, headers: { "content-length": "9999" } }]);
    await expect(safeFetch("https://example.com/", { scopeUrl: "https://example.com/", maxResponseBytes: 100 }, publicResolver)).rejects.toMatchObject({
      url: "https://example.com/unavailable",
      statusCode: 503,
      redirects: [{ url: "https://example.com/", statusCode: 301, location: "https://example.com/unavailable" }],
    });
  });

  it("caps decompressed bodies even when the compressed response fits", async () => {
    const compressed = gzipSync("a".repeat(10000));
    expect(compressed.byteLength).toBeLessThan(1000);
    mockTransport([{ headers: { "content-encoding": "gzip" }, body: compressed }]);
    await expect(safeFetch("https://example.com/", { scopeUrl: "https://example.com/", maxResponseBytes: 1000 }, publicResolver)).rejects.toThrow(/decompressed/);
  });

  it("decodes a gzip sitemap file without a Content-Encoding header", async () => {
    const xml = '<urlset><url><loc>https://example.com/about</loc></url></urlset>';
    const compressed = gzipSync(xml);
    mockTransport([{ headers: { "content-type": "application/octet-stream", "content-length": String(compressed.byteLength) }, body: compressed }]);
    const result = await safeFetch("https://example.com/sitemap.xml.gz?version=1", { scopeUrl: "https://example.com/" }, publicResolver);
    expect(result.body).toBe(xml);
    expect(result.statusCode).toBe(200);
    expect(result.headers["content-encoding"]).toBeUndefined();
  });

  it.each(["application/gzip", "application/x-gzip"])("decodes extensionless gzip sitemap content declared as %s", async (contentType) => {
    const xml = '<urlset><url><loc>https://example.com/about</loc></url></urlset>';
    mockTransport([{ headers: { "content-type": contentType }, body: gzipSync(xml) }]);
    const result = await safeFetch("https://example.com/sitemap-download", { scopeUrl: "https://example.com/" }, publicResolver);
    expect(result.body).toBe(xml);
  });

  it("caps a gzip sitemap file's expanded body and preserves the HTTP evidence", async () => {
    const xml = `<urlset>${'<url><loc>https://example.com/about</loc></url>'.repeat(500)}</urlset>`;
    const compressed = gzipSync(xml);
    expect(compressed.byteLength).toBeLessThan(1000);
    mockTransport([{ headers: { "content-type": "application/gzip", "content-length": String(compressed.byteLength) }, body: compressed }]);
    await expect(safeFetch("https://example.com/sitemap.xml.gz", { scopeUrl: "https://example.com/", maxResponseBytes: 1000 }, publicResolver)).rejects.toMatchObject({
      name: "RequestFailure", url: "https://example.com/sitemap.xml.gz", statusCode: 200, message: expect.stringMatching(/decompressed/),
    });
  });

  it("rejects aborted responses and request errors", async () => {
    mockTransport([{ aborted: true }, { error: new Error("ECONNRESET") }]);
    await expect(safeFetch("https://example.com/", { scopeUrl: "https://example.com/" }, publicResolver)).rejects.toThrow(/complete response/);
    await expect(safeFetch("https://example.com/", { scopeUrl: "https://example.com/" }, publicResolver)).rejects.toBeInstanceOf(RequestFailure);
  });

  it("destroys stalled requests after the configured timeout", async () => {
    vi.useFakeTimers();
    const calls = mockTransport([{ hang: true }]);
    const promise = safeFetch("https://example.com/", { scopeUrl: "https://example.com/", timeoutMs: 50 }, publicResolver);
    const assertion = expect(promise).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
    expect(calls[0].request.destroy).toHaveBeenCalled();
  });
});
