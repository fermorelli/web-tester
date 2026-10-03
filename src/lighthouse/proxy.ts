import { createServer, request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { connect, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { resolvePublicAddress, validatePublicUrl, type Resolver } from "@/crawler/security";

const MAX_REQUESTS = 600;
const MAX_CONNECTIONS = 64;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_RESOURCE_BYTES = 32 * 1024 * 1024;
const IDLE_TIMEOUT_MS = 30_000;

/** DNS validation and the actual connection use the same pinned public address. */
export async function resolveProxyTarget(input: string, resolver?: Resolver) {
  const url = validatePublicUrl(input);
  return { url, ...await resolvePublicAddress(url.href, resolver) };
}

export function connectTarget(authority: string): string {
  if (!authority || /[\s/?#\\@]/.test(authority)) throw new Error("Invalid CONNECT destination.");
  return validatePublicUrl(`https://${authority}`).href;
}

function forwardingHeaders(input: IncomingHttpHeaders, host?: string): IncomingHttpHeaders {
  const headers: IncomingHttpHeaders = { ...input, ...(host ? { host } : {}) };
  const connectionHeaders = String(input.connection ?? "").split(",").map(value => value.trim().toLowerCase());
  for (const name of ["connection", "proxy-connection", "proxy-authorization", "proxy-authenticate", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade", ...connectionHeaders]) delete headers[name];
  headers.connection = "close";
  return headers;
}

/** A per-audit loopback proxy also guards browser redirects, scripts, iframes and resources. */
export async function startLighthouseProxy(resolver?: Resolver) {
  const sockets = new Set<Duplex>();
  const stats = { blockedRequests: 0, limitedRequests: 0, requests: 0, bytes: 0 };
  let closing = false;
  let active = 0;
  const track = <T extends Duplex>(socket: T): T => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => { /* Each request/tunnel handles its response separately. */ });
    return socket;
  };
  const reserve = () => {
    stats.requests++;
    if (closing || stats.requests > MAX_REQUESTS || active >= MAX_CONNECTIONS || stats.bytes >= MAX_TOTAL_BYTES) {
      stats.limitedRequests++;
      return null;
    }
    active++;
    let released = false;
    return () => { if (!released) { released = true; active--; } };
  };
  const countBytes = (size: number, resourceBytes: number): boolean => {
    stats.bytes += size;
    if (stats.bytes > MAX_TOTAL_BYTES || resourceBytes > MAX_RESOURCE_BYTES) { stats.limitedRequests++; return false; }
    return true;
  };

  const server = createServer({ maxHeaderSize: 32 * 1024 }, (incoming, outgoing) => {
    const release = reserve();
    if (!release) { outgoing.writeHead(503).end(); return; }
    outgoing.once("close", release);
    incoming.setTimeout(IDLE_TIMEOUT_MS, () => incoming.destroy());
    void (async () => {
      let target;
      try {
        target = await resolveProxyTarget(incoming.url ?? "", resolver);
        if (target.url.protocol !== "http:") throw new Error("HTTPS requires a CONNECT tunnel.");
        if (!["GET", "HEAD", "POST", "OPTIONS"].includes(incoming.method ?? "")) throw new Error("Unsupported browser request method.");
      } catch {
        stats.blockedRequests++;
        if (!outgoing.destroyed) outgoing.writeHead(403).end();
        incoming.resume();
        return;
      }
      if (closing || outgoing.destroyed) return;
      const upstream = httpRequest({
        hostname: target.address, family: target.family, port: Number(target.url.port || 80),
        path: `${target.url.pathname}${target.url.search}`, method: incoming.method,
        headers: forwardingHeaders(incoming.headers, target.url.host), agent: false,
      }, response => {
        let size = 0;
        outgoing.writeHead(response.statusCode ?? 502, forwardingHeaders(response.headers));
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (!countBytes(chunk.length, size)) { response.destroy(); upstream.destroy(); outgoing.destroy(); }
        });
        response.on("error", () => outgoing.destroy());
        response.pipe(outgoing);
      });
      upstream.on("socket", socket => track(socket));
      upstream.setTimeout(IDLE_TIMEOUT_MS, () => upstream.destroy(new Error("Browser request timed out.")));
      upstream.on("error", () => {
        if (!outgoing.headersSent && !outgoing.destroyed) outgoing.writeHead(502).end();
        else outgoing.destroy();
      });
      outgoing.once("close", () => upstream.destroy());
      let sent = 0;
      incoming.on("data", (chunk: Buffer) => {
        sent += chunk.length;
        if (sent > 2 * 1024 * 1024 || !countBytes(chunk.length, sent)) { incoming.destroy(); upstream.destroy(); outgoing.destroy(); }
      });
      incoming.on("error", () => upstream.destroy());
      incoming.pipe(upstream);
    })().catch(() => { outgoing.destroy(); release(); });
  });

  server.on("connection", socket => {
    if (sockets.size > MAX_CONNECTIONS * 3) { socket.destroy(); return; }
    track(socket);
    socket.setTimeout(IDLE_TIMEOUT_MS, () => socket.destroy());
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  server.on("upgrade", (_request, socket) => socket.destroy());
  server.on("connect", (incoming, client, head) => {
    const release = reserve();
    if (!release) { client.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n"); return; }
    client.once("close", release);
    void (async () => {
      let target;
      try { target = await resolveProxyTarget(connectTarget(incoming.url ?? ""), resolver); }
      catch {
        stats.blockedRequests++;
        client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return;
      }
      if (closing || client.destroyed) return;
      const upstream: Socket = track(connect({ host: target.address, family: target.family, port: Number(target.url.port || 443) }));
      upstream.setTimeout(IDLE_TIMEOUT_MS, () => upstream.destroy());
      upstream.once("connect", () => {
        if (client.destroyed) { upstream.destroy(); return; }
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        let size = head.length;
        const count = (chunk: Buffer) => {
          size += chunk.length;
          if (!countBytes(chunk.length, size)) { upstream.destroy(); client.destroy(); }
        };
        client.on("data", count);
        upstream.on("data", count);
        client.pipe(upstream);
        upstream.pipe(client);
      });
      upstream.once("error", () => client.destroy());
      upstream.once("close", () => client.destroy());
      client.once("close", () => upstream.destroy());
    })().catch(() => { client.destroy(); release(); });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to start the browser network proxy.");
  return {
    url: `http://127.0.0.1:${address.port}`,
    stats,
    close: async () => {
      closing = true;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
