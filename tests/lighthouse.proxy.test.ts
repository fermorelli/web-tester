import { request } from "node:http";
import { describe, expect, it } from "vitest";
import { connectTarget, resolveProxyTarget, startLighthouseProxy } from "@/lighthouse/proxy";

describe("Chromium public-only network proxy", () => {
  it("validates all DNS answers and returns the pinned public address", async () => {
    await expect(resolveProxyTarget("https://public.example/asset", async () => [{ address: "93.184.216.34", family: 4 }])).resolves.toMatchObject({ address: "93.184.216.34", family: 4 });
    await expect(resolveProxyTarget("https://rebind.example/", async () => [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.1", family: 4 }])).rejects.toThrow("private");
  });
  it.each(["http://127.1/", "http://169.254.169.254/latest/meta-data/", "http://[::1]/", "http://example.com:5432/", "file:///etc/passwd", "http://user:pass@example.com/"])("blocks %s", async url => {
    await expect(resolveProxyTarget(url)).rejects.toThrow();
  });
  it("rejects CONNECT credentials, path injection and non-web ports", () => {
    expect(connectTarget("example.com:443")).toBe("https://example.com/");
    for (const authority of ["127.0.0.1:443", "example.com:22", "example.com:443@127.0.0.1", "example.com:443/path", "example.com:443\r\nHost: other"]) expect(() => connectTarget(authority)).toThrow();
  });
  it("blocks HTTP resources and HTTPS tunnels resolving to private addresses", async () => {
    const proxy = await startLighthouseProxy(async () => [{ address: "10.0.0.1", family: 4 }]);
    const proxyUrl = new URL(proxy.url);
    try {
      const status = await new Promise<number>(resolve => {
        const req = request({ hostname: proxyUrl.hostname, port: proxyUrl.port, path: "http://rebind.example/script.js" }, response => { response.resume(); resolve(response.statusCode!); });
        req.end();
      });
      expect(status).toBe(403);
      const tunnelStatus = await new Promise<number>((resolve, reject) => {
        const req = request({ hostname: proxyUrl.hostname, port: proxyUrl.port, method: "CONNECT", path: "rebind.example:443" });
        req.once("connect", (response, socket) => { socket.destroy(); resolve(response.statusCode!); });
        req.once("error", reject);
        req.end();
      });
      expect(tunnelStatus).toBe(403);
      expect(proxy.stats.blockedRequests).toBe(2);
    } finally { await proxy.close(); }
  });
});
