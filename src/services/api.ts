import { NextResponse } from "next/server";

export const json = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });
export const validAuditId = (id: string) => /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(id);

export function configuredAppOrigin(): string | null {
  const value = process.env.APP_ORIGIN || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null);
  if (!value) return null;
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("APP_ORIGIN must be an HTTP/HTTPS origin without a path or credentials.");
  }
  return url.origin;
}

function requestOrigin(request: Request): string {
  const url = new URL(request.url);
  const host = request.headers.get("host") ?? url.host;
  if (!host || /[\s/?#\\@]/.test(host)) throw new Error("Invalid request host.");
  const candidate = new URL(`${url.protocol}//${host}`);
  const configured = configuredAppOrigin();
  if (configured && candidate.host === new URL(configured).host) return configured;
  if (["localhost", "127.0.0.1", "[::1]"].includes(candidate.hostname)) return candidate.origin;
  throw new Error("The request host is not allowed. Configure APP_ORIGIN for a public deployment.");
}

/** Validate the configured public origin without trusting arbitrary forwarded headers. */
export function validateLocalWrite(request: Request): string | null {
  const localError = validateLocalRequest(request);
  if (localError) return localError;
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") return "Content-Type: application/json is required.";
  const origin = request.headers.get("origin");
  const expectedOrigin = requestOrigin(request);
  if (origin && origin !== expectedOrigin) return "The request origin is not allowed.";
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && !["same-origin", "none"].includes(fetchSite)) return "The request must originate from this application.";
  return null;
}

export function validateLocalRequest(request: Request): string | null {
  try {
    requestOrigin(request);
  } catch (error) { return error instanceof Error ? error.message : "Invalid request host."; }
  return null;
}

export async function readSmallJson(request: Request): Promise<unknown> {
  if (!request.body) throw new Error("A JSON request body is required.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8192) { await reader.cancel(); throw new Error("The request exceeds the 8 KB limit."); }
      chunks.push(value);
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
    try { return JSON.parse(new TextDecoder().decode(body)) as unknown; }
    catch { throw new Error("Invalid JSON request body."); }
  } finally { reader.releaseLock(); }
}
