const ignoredParams = /^(utm_.+|fbclid|gclid|dclid|msclkid|yclid|_ga|_gl|mc_cid|mc_eid|ref|referrer|session(?:id)?|phpsessid)$/i;
const assetExtension = /\.(?:avif|bmp|gif|ico|jpe?g|png|svg|webp|css|js|mjs|map|woff2?|ttf|eot|pdf|zip|gz|rar|7z|mp[34]|mov|avi|webm|wav|ogg|xml|json|txt|csv|docx?|xlsx?|pptx?)(?:$)/i;
const uselessPath = /\/(?:wp-admin|wp-json|wp-login\.php|admin|login|logout|signin|signup|register|cart|checkout|search|feed|cgi-bin)(?:\/|$)/i;

/** Canonicalizes a crawl identity; retains meaningful parameters such as pagination. */
export function normalizeUrl(input: string, base?: string): string | null {
  try {
    let value = input.trim();
    if (!value) return null;
    if (!base && !/^[a-z][a-z\d+.-]*:/i.test(value)) value = `https://${value}`;
    const url = base ? new URL(value, base) : new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    url.hash = "";
    url.hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    for (const key of [...url.searchParams.keys()]) if (ignoredParams.test(key)) url.searchParams.delete(key);
    url.searchParams.sort();
    return url.href;
  } catch { return null; }
}

export function siteHostname(input: string): string {
  return new URL(input).hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
}

/** Only the exact host and its www alias belong to a crawl. Subdomains are separate sites. */
export function isInternalUrl(input: string, base: string): boolean {
  try {
    const url = new URL(input, base);
    const reference = new URL(base);
    return ["http:", "https:"].includes(url.protocol)
      && siteHostname(url.href) === siteHostname(base)
      && url.port === reference.port;
  } catch { return false; }
}

export function isCrawlableUrl(input: string): boolean {
  try {
    const url = new URL(input);
    return ["http:", "https:"].includes(url.protocol)
      && !assetExtension.test(url.pathname)
      && !uselessPath.test(url.pathname)
      && !["s", "search", "replytocom", "add-to-cart", "sort", "filter"].some(key => url.searchParams.has(key))
      && url.href.length <= 2048;
  } catch { return false; }
}
