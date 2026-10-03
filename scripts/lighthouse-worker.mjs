// Deliberately separate from Next, the HTTP crawler, SEO analyzers and database connection.
import lighthouse from "lighthouse";
import * as chromeLauncher from "chrome-launcher";

let chrome;
let started = false;
let cleaning;
function cleanup() {
  cleaning ??= (async () => {
    try { chrome?.kill(); } catch { /* Parent also kills the dedicated browser process group. */ }
    try { chromeLauncher.killAll(); } catch { /* Cleanup must not discard a successful report. */ }
  })();
  return cleaning;
}
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => { void cleanup().finally(() => process.exit(1)); });
}
process.once("disconnect", () => { void cleanup().finally(() => process.exit(1)); });

function send(message) {
  return new Promise(resolve => {
    if (!process.connected) { resolve(); return; }
    process.send(message, () => resolve());
  });
}

process.on("message", async input => {
  if (started) return;
  started = true;
  let output;
  try {
    const url = new URL(input.url);
    const proxy = new URL(input.proxyUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.pathname !== "/" || url.search || url.hash || url.username || url.password
      || proxy.hostname !== "127.0.0.1" || proxy.protocol !== "http:") throw new Error("Invalid homepage worker configuration.");
    const chromeFlags = [
      "--headless=new", "--disable-gpu", "--disable-dev-shm-usage", "--disable-quic",
      `--proxy-server=${proxy.origin}`, "--proxy-bypass-list=<-loopback>",
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
      "--remote-debugging-address=127.0.0.1", "--lang=en-US", "--no-first-run",
    ];
    // Container hosts cannot provide Chromium's user namespace sandbox.
    if (process.platform === "linux") chromeFlags.push("--no-sandbox", "--disable-setuid-sandbox");
    chrome = await chromeLauncher.launch({
      chromePath: input.chromePath, userDataDir: input.profile, chromeFlags, handleSIGINT: false,
      logLevel: "silent", maxConnectionRetries: 30, connectionPollInterval: 250,
    });
    const result = await lighthouse(url.href, {
      port: chrome.port, output: "json", logLevel: "silent", locale: "en-US", formFactor: "mobile",
      onlyCategories: ["performance", "accessibility", "best-practices", "seo"],
      maxWaitForLoad: 45_000, maxWaitForFcp: 30_000,
    });
    if (!result?.lhr) throw new Error("Lighthouse returned no homepage report.");
    const lhr = result.lhr;
    // Limit IPC to the requested result. Do not send traces, HTML, website DOM or screenshots.
    output = { type: "result", report: {
      runtimeError: lhr.runtimeError, lighthouseVersion: lhr.lighthouseVersion,
      finalDisplayedUrl: lhr.finalDisplayedUrl, finalUrl: lhr.finalUrl,
      categories: Object.fromEntries(Object.entries(lhr.categories).map(([id, category]) => [id, { score: category.score }])),
      audits: Object.fromEntries(["largest-contentful-paint", "cumulative-layout-shift", "total-blocking-time"].map(id => [id, { numericValue: lhr.audits[id]?.numericValue }])),
      runWarnings: lhr.runWarnings,
    } };
  } catch (error) {
    let message = error instanceof Error ? error.message.slice(0, 1000) : "The browser performance check failed.";
    if (error?.code === "EPERM" || error?.code === "EACCES") message = "Chromium could not start because browser execution is not permitted on the server.";
    if (error?.code === "ENOENT") message = "Chromium could not be found. Check the server's CHROME_PATH setting.";
    output = { type: "error", error: message };
  } finally {
    await cleanup();
    await send(output);
    process.exit(0);
  }
});
