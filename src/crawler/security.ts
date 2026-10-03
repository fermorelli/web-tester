import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export class UnsafeUrlError extends Error {
  constructor(message: string) { super(message); this.name = "UnsafeUrlError"; }
}
export interface ResolvedAddress { address: string; family: number }
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

function expandIpv6(address: string): number[] | null {
  if (address.includes(".") || address.includes("%")) return null;
  const halves = address.toLowerCase().split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - left.length - right.length : 0;
  const parts = [...left, ...Array(Math.max(0, fill)).fill("0"), ...right];
  if (parts.length !== 8 || parts.some(part => !/^[\da-f]{1,4}$/.test(part))) return null;
  return parts.map(part => Number.parseInt(part, 16));
}

/** Rejects private, loopback, link-local, multicast, documentation and transition ranges. */
export function isPublicIp(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, "");
  if (isIP(ip) === 4) {
    const [a, b, c] = ip.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) return false;
    if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    return true;
  }
  if (isIP(ip) === 6) {
    const parts = expandIpv6(ip);
    if (!parts || (parts[0] & 0xe000) !== 0x2000) return false;
    if (parts[0] === 0x2002 || parts[0] === 0x3fff) return false;
    if (parts[0] === 0x2001 && (parts[1] < 0x0200 || parts[1] === 0x0db8)) return false;
    return true;
  }
  return false;
}

export function validatePublicUrl(input: string): URL {
  let url: URL;
  try { url = new URL(input); } catch { throw new UnsafeUrlError("The URL is invalid."); }
  if (!["http:", "https:"].includes(url.protocol)) throw new UnsafeUrlError("Only HTTP and HTTPS URLs are allowed.");
  if (url.username || url.password) throw new UnsafeUrlError("The URL must not include credentials.");
  if (url.port && !["80", "443"].includes(url.port)) throw new UnsafeUrlError("Only web ports 80 and 443 are allowed.");
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!hostname || hostname === "localhost" || /\.(localhost|local|internal|home|lan)$/.test(hostname)
      || hostname === "metadata.google.internal" || hostname === "instance-data.ec2.internal") {
    throw new UnsafeUrlError("Local hosts and metadata endpoints are not allowed.");
  }
  if (isIP(hostname) && !isPublicIp(hostname)) throw new UnsafeUrlError("Private or reserved IP addresses are not allowed.");
  if (!isIP(hostname) && !hostname.includes(".")) throw new UnsafeUrlError("Enter a complete public domain name.");
  return url;
}

const systemResolver: Resolver = async hostname => lookup(hostname, { all: true, verbatim: true });

export async function resolvePublicAddress(input: string, resolver: Resolver = systemResolver): Promise<ResolvedAddress> {
  const url = validatePublicUrl(input);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(hostname)) return { address: hostname, family: isIP(hostname) };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const records = await Promise.race([
      resolver(hostname),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Domain resolution timed out.")), 5000); }),
    ]);
    if (!records.length || records.some(record => !isPublicIp(record.address))) {
      throw new UnsafeUrlError("The domain resolves to a private or reserved address; request blocked.");
    }
    return records.find(record => record.family === 4) ?? records[0];
  } finally { if (timer) clearTimeout(timer); }
}
