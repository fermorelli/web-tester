import { afterEach, describe, expect, it, vi } from "vitest";
import { readSmallJson, validateLocalRequest, validateLocalWrite } from "@/services/api";

describe("local API request boundary", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("accepts same-origin JSON writes and non-browser JSON clients", () => {
    expect(validateLocalWrite(new Request("http://127.0.0.1:3000/api/audits", { method: "POST", headers: { "content-type": "application/json", origin: "http://127.0.0.1:3000" } }))).toBeNull();
    expect(validateLocalWrite(new Request("http://localhost:3000/api/audits", { method: "POST", headers: { "content-type": "application/json" } }))).toBeNull();
  });
  it("rejects cross-origin writes and rebinding hostnames", () => {
    expect(validateLocalWrite(new Request("http://localhost:3000/api/audits", { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" } }))).toContain("origin");
    expect(validateLocalRequest(new Request("http://evil.example:3000/api/audits"))).not.toBeNull();
    expect(validateLocalWrite(new Request("http://localhost:3000/api/audits", { method: "POST", headers: { "content-type": "text/plain" } }))).toContain("application/json");
    expect(validateLocalRequest(new Request("http://localhost:3000/api/audits", { headers: { host: "evil.example:3000" } }))).not.toBeNull();
  });
  it("uses the browser Host header when Next supplies its internal localhost request URL", () => {
    expect(validateLocalWrite(new Request("http://localhost:3000/api/audits", { method: "POST", headers: { host: "127.0.0.1:3000", "content-type": "application/json", origin: "http://127.0.0.1:3000" } }))).toBeNull();
  });
  it("accepts the configured Railway HTTPS origin behind an internal HTTP proxy", () => {
    vi.stubEnv("APP_ORIGIN", "https://seo-testing.up.railway.app");
    const request = (origin: string) => new Request("http://localhost:8080/api/audits", { method: "POST", headers: {
      host: "seo-testing.up.railway.app", origin, "content-type": "application/json", "sec-fetch-site": "same-origin", "x-forwarded-proto": "https",
    } });
    expect(validateLocalWrite(request("https://seo-testing.up.railway.app"))).toBeNull();
    expect(validateLocalWrite(request("http://seo-testing.up.railway.app"))).toContain("origin");
    expect(validateLocalWrite(request("https://other.up.railway.app"))).toContain("origin");
  });
  it("supports Railway's generated public domain without trusting forwarded hostnames", () => {
    vi.stubEnv("APP_ORIGIN", "");
    vi.stubEnv("RAILWAY_PUBLIC_DOMAIN", "seo-testing.up.railway.app");
    expect(validateLocalRequest(new Request("http://localhost/api", { headers: { host: "seo-testing.up.railway.app" } }))).toBeNull();
    expect(validateLocalRequest(new Request("http://evil.example/api", { headers: { "x-forwarded-host": "seo-testing.up.railway.app" } }))).not.toBeNull();
    expect(validateLocalRequest(new Request("http://localhost/api", { headers: { host: "seo-testing.up.railway.app@evil.example" } }))).not.toBeNull();
  });
  it("fails closed for malformed deployment origins and rejects cross-site fetches", () => {
    vi.stubEnv("APP_ORIGIN", "https://seo.example/path");
    expect(validateLocalRequest(new Request("http://localhost/api"))).toContain("APP_ORIGIN");
    vi.stubEnv("APP_ORIGIN", "https://seo.example");
    expect(validateLocalWrite(new Request("http://localhost/api", { method: "POST", headers: { host: "seo.example", "content-type": "application/json", "sec-fetch-site": "cross-site" } }))).not.toBeNull();
  });
  it("reads valid JSON and rejects malformed or oversized streamed bodies", async () => {
    const request = (body: string) => new Request("http://localhost/api", { method: "POST", body });
    await expect(readSmallJson(request('{"url":"example.com"}'))).resolves.toEqual({ url: "example.com" });
    await expect(readSmallJson(request("{"))).rejects.toThrow();
    await expect(readSmallJson(request("x".repeat(8200)))).rejects.toThrow("8 KB");
  });
});
