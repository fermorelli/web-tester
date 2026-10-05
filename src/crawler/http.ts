import http from "node:http";
import https from "node:https";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import type { Readable } from "node:stream";
import type { CrawlScope, RedirectHop } from "@/shared/types";
import { resolvePublicAddress, validatePublicUrl, type Resolver } from "./security";
import { inferCrawlScope, isInCrawlScope, isInternalUrl } from "./url";

export const USER_AGENT = "SiteInspectorBot/1.0 (personal technical SEO audit)";
export interface FetchOptions {
  method?: "GET" | "HEAD";
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxRedirects?: number;
  scopeUrl: string;
  /** Page requests use the audit path; host metadata explicitly uses host scope. */
  scope?: CrawlScope;
  beforeRequest?: (url: string) => Promise<void> | void;
}
export interface FetchResult {
  url: string;
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  redirects: RedirectHop[];
  responseTimeMs: number;
}
export class RequestFailure extends Error {
  constructor(message: string, public readonly url: string, public readonly redirects: RedirectHop[] = [], public readonly statusCode: number | null = null) {
    super(message); this.name = "RequestFailure";
  }
}

async function requestOnce(url: URL, options: FetchOptions, resolver?: Resolver): Promise<Omit<FetchResult, "redirects" | "responseTimeMs">> {
  const resolved = await resolvePublicAddress(url.href, resolver);
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    let response: http.IncomingMessage | undefined;
    let decoded: Readable | undefined;
    let settled = false;
    const maxBytes = options.maxResponseBytes ?? 2_000_000;
    const finish = (error?: Error, result?: Omit<FetchResult, "redirects" | "responseTimeMs">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) { response?.destroy(); decoded?.destroy(); request.destroy(); reject(new RequestFailure(error.message, url.href, [], response?.statusCode ?? null)); }
      else if (result) resolve(result);
    };
    // Pin the validated address to the socket. TLS still verifies the original hostname.
    const request = transport.request(url, {
      method: options.method ?? "GET", agent: false,
      lookup: (_host, _lookupOptions, callback) => callback(null, resolved.address, resolved.family),
      family: resolved.family,
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml,application/xml,text/xml,text/plain;q=0.9,*/*;q=0.1", "Accept-Encoding": "identity" },
    }, res => {
      response = res;
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(res.headers)) if (value !== undefined) headers[key] = Array.isArray(value) ? value.join(", ") : value;
      const statusCode = res.statusCode ?? 0;
      const result = { url: url.href, statusCode, headers, body: "" };
      if (options.method === "HEAD" || ([301, 302, 303, 307, 308].includes(statusCode) && headers.location)) {
        finish(undefined, result); res.destroy(); return;
      }
      if (Number(headers["content-length"]) > maxBytes) { finish(new Error(`The response exceeds the limit of ${maxBytes} bytes.`)); return; }
      let rawBytes = 0;
      res.on("data", (chunk: Buffer) => {
        rawBytes += chunk.length;
        if (rawBytes > maxBytes) finish(new Error(`The response exceeds the limit of ${maxBytes} bytes.`));
      });
      const encoding = headers["content-encoding"]?.toLowerCase().trim();
      const gzipDocument = !encoding && statusCode >= 200 && statusCode < 300
        && (/\.(?:xml\.)?gz$/i.test(url.pathname) || /application\/(?:x-)?gzip/i.test(headers["content-type"] ?? ""));
      decoded = encoding === "gzip" || gzipDocument ? res.pipe(createGunzip()) : encoding === "br" ? res.pipe(createBrotliDecompress()) : encoding === "deflate" ? res.pipe(createInflate()) : res;
      const chunks: Buffer[] = [];
      let bytes = 0;
      decoded.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > maxBytes) { finish(new Error(`The decompressed response exceeds the limit of ${maxBytes} bytes.`)); return; }
        chunks.push(Buffer.from(chunk));
      });
      decoded.on("end", () => finish(undefined, { ...result, body: Buffer.concat(chunks).toString("utf8") }));
      decoded.on("error", error => finish(error));
      res.on("error", error => finish(error));
      res.on("aborted", () => finish(new Error("The connection ended before the complete response was received.")));
    });
    const timer = setTimeout(() => finish(new Error(`Request timed out (${options.timeoutMs ?? 10000} ms).`)), options.timeoutMs ?? 10000);
    request.on("error", error => finish(error));
    request.end();
  });
}

/** Every hop validates scope, DNS and robots before connecting; no automatic redirects. */
export async function safeFetch(input: string, options: FetchOptions, resolver?: Resolver): Promise<FetchResult> {
  const started = Date.now();
  const redirects: RedirectHop[] = [];
  const seen = new Set<string>();
  let target = input;
  const scope = options.scope ?? inferCrawlScope(options.scopeUrl);
  for (;;) {
    try {
      const url = validatePublicUrl(target);
      if (!isInternalUrl(url.href, options.scopeUrl)) throw new Error("Redirect outside the site domain: not followed.");
      if (!isInCrawlScope(url.href, scope)) throw new Error("Redirect outside the selected audit scope: not followed.");
      if (seen.has(url.href)) throw new Error("Redirect loop detected.");
      seen.add(url.href);
      await options.beforeRequest?.(url.href);
      const result = await requestOnce(url, options, resolver);
      if (![301, 302, 303, 307, 308].includes(result.statusCode) || !result.headers.location) {
        return { ...result, redirects, responseTimeMs: Date.now() - started };
      }
      const location = new URL(result.headers.location, url).href;
      redirects.push({ url: url.href, statusCode: result.statusCode, location });
      if (redirects.length > (options.maxRedirects ?? 5)) throw new Error("The redirect limit was exceeded.");
      target = location;
    } catch (error) {
      throw new RequestFailure(error instanceof Error ? error.message : "Request error.", target, redirects,
        error instanceof RequestFailure ? error.statusCode : redirects.at(-1)?.statusCode ?? null);
    }
  }
}
