import { afterEach, describe, expect, it, vi } from "vitest";
import { analyzeHomepage, homepageUrl, lighthouseTimeout, parseLighthouseReport } from "@/lighthouse";

describe("isolated homepage Lighthouse result", () => {
  afterEach(() => vi.unstubAllEnvs());
  it.each([
    ["https://www.example.com/products/item?sort=price#details", "https://www.example.com/"],
    ["example.com/nested/path", "https://example.com/"],
    ["http://example.com/?campaign=x", "http://example.com/"],
  ])("measures the normalized root of %s", (input, root) => expect(homepageUrl(input)).toBe(root));
  it("extracts scores and numeric metrics without inventing missing values", () => {
    const result = parseLighthouseReport({
      lighthouseVersion: "13.5.0", finalDisplayedUrl: "https://www.example.com/",
      categories: { performance: { score: 0.876 }, accessibility: { score: 1 }, "best-practices": { score: 0 }, seo: { score: null } },
      audits: { "largest-contentful-paint": { numericValue: 1234.5 }, "cumulative-layout-shift": { numericValue: 0 }, "total-blocking-time": { numericValue: NaN } },
      runWarnings: ["A resource could not be loaded."],
    }, "https://example.com/path");
    expect(result).toMatchObject({ status: "completed", homepageUrl: "https://example.com/", finalUrl: "https://www.example.com/", scores: { performance: 88, accessibility: 100, bestPractices: 0, seo: null }, metrics: { lcpMs: 1234.5, cls: 0, tbtMs: null }, error: null });
  });
  it("turns browser runtime errors and empty reports into an unavailable result", () => {
    expect(parseLighthouseReport({ runtimeError: { message: "The page failed to load." } }, "https://example.com/path")).toMatchObject({ status: "unavailable", scores: null, metrics: null, error: "The page failed to load." });
    expect(parseLighthouseReport({}, "https://example.com/").status).toBe("unavailable");
    expect(parseLighthouseReport({ categories: {}, audits: {} }, "https://example.com/").status).toBe("unavailable");
  });
  it("rejects private homepage destinations before spawning any browser", async () => {
    const result = await analyzeHomepage("http://127.0.0.1/private");
    expect(result.status).toBe("unavailable");
    expect(result.homepageUrl).toBe("http://127.0.0.1/");
    expect(result.error).toMatch(/private/i);
  });
  it("bounds configurable timeout values", () => {
    vi.stubEnv("LIGHTHOUSE_TIMEOUT_MS", "bad"); expect(lighthouseTimeout()).toBe(120000);
    vi.stubEnv("LIGHTHOUSE_TIMEOUT_MS", "1000"); expect(lighthouseTimeout()).toBe(10000);
    vi.stubEnv("LIGHTHOUSE_TIMEOUT_MS", "9999999"); expect(lighthouseTimeout()).toBe(180000);
  });
});

const live = process.env.RUN_LIGHTHOUSE_SMOKE === "1" ? it : it.skip;
live("runs a real Chromium Lighthouse homepage check", async () => {
  const result = await analyzeHomepage("https://example.com/a-path-that-is-not-the-homepage?test=1");
  expect(result.status, result.error ?? "No Lighthouse result").toBe("completed");
  expect(result.homepageUrl).toBe("https://example.com/");
  expect(result.scores?.performance).toBeTypeOf("number");
  expect(result.metrics?.lcpMs).toBeTypeOf("number");
  console.info("Real homepage Lighthouse smoke result:", JSON.stringify(result));
}, 190000);
