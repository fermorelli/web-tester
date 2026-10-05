export const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
export type Severity = (typeof SEVERITIES)[number];
export const CATEGORIES = ["HTTP", "Indexability", "Metadata", "Content", "Links", "Images", "Structured Data", "Sitemap", "Tracking"] as const;
export type Category = (typeof CATEGORIES)[number];

export interface Issue {
  id: string;
  kind?: "issue" | "observation";
  references?: { label: string; url: string }[];
  name: string;
  category: Category;
  severity: Severity;
  description: string;
  whyItMatters: string;
  recommendation: string;
  affectedUrls: string[];
  evidence: { url: string; detail: string }[];
}
export interface PageLink { url: string; text: string; nofollow: boolean; internal: boolean }
export interface PageImage { src: string; alt: string | null; contentLength: number | null; checkError?: string }
export interface Heading { level: number; text: string }
export interface ParsedPage {
  title: string | null;
  description: string | null;
  canonical: string | null;
  canonicalRaw: string | null;
  canonicalCount: number;
  canonicalInvalid: boolean;
  canonicalDeclarations?: { source: "html" | "header"; raw: string | null; url: string | null }[];
  robots: string[];
  robotDirectives?: { source: "meta" | "header"; agent: string; directives: string[] }[];
  noindex: boolean;
  nofollow: boolean;
  headings: Heading[];
  h1: string[];
  wordCount: number;
  contentHash: string;
  contentSample: string;
  links: PageLink[];
  images: PageImage[];
  schemaTypes: string[];
  jsonLdCount: number;
  jsonLdErrors: string[];
  schemaWarnings: string[];
  social: { openGraph: Record<string, string>; twitter: Record<string, string> };
  tracking: string[];
  language: string | null;
}
export interface RedirectHop { url: string; statusCode: number; location: string }
export interface PageAnalysis {
  url: string;
  finalUrl: string;
  statusCode: number | null;
  redirects: RedirectHop[];
  contentType: string | null;
  responseTimeMs: number;
  error: string | null;
  blockedByRobots: boolean;
  depth: number | null;
  inSitemap: boolean;
  discoveredFrom: string[];
  fetchedAt: string;
  indexable: boolean | null;
  parsed: ParsedPage | null;
}
export interface CrawlRelationship { source: string; target: string; nofollow: boolean; text: string }
export interface RobotsReport {
  url: string;
  found: boolean;
  statusCode: number | null;
  body: string | null;
  error: string | null;
  warnings: string[];
}
export interface SitemapReport {
  found: boolean;
  urls: string[];
  documents: string[];
  error: string | null;
  truncated: boolean;
}
export interface CrawlLimits {
  maxPages: number;
  concurrency: number;
  timeoutMs: number;
  maxResponseBytes: number;
  maxRedirects: number;
  maxImageChecks: number;
  scope?: CrawlScope;
  analysisVersion?: number;
}
export interface CrawlScope { kind: "host" | "path"; rootUrl: string }
export type AuditStatus = "queued" | "running" | "completed" | "failed" | "interrupted";
export interface LighthouseResult {
  status: "completed" | "unavailable";
  homepageUrl: string;
  finalUrl: string | null;
  analyzedAt: string;
  version: string | null;
  device: "mobile";
  scores: { performance: number | null; accessibility: number | null; bestPractices: number | null; seo: number | null } | null;
  metrics: { lcpMs: number | null; cls: number | null; tbtMs: number | null } | null;
  warnings: string[];
  error: string | null;
}
export interface AuditSummary {
  id: string;
  domain: string;
  startUrl: string;
  status: AuditStatus;
  startedAt: string;
  completedAt: string | null;
  updatedAt: string;
  crawledPages: number;
  errorPages: number;
  issueCount: number;
  observationCount?: number;
  analysisVersion?: number;
  maxPages: number;
  progress: number;
  message: string;
  error: string | null;
}
export interface AuditDetail extends AuditSummary {
  lighthouse: LighthouseResult | null;
  pages: PageAnalysis[];
  issues: Issue[];
  relationships: CrawlRelationship[];
  robots: RobotsReport | null;
  sitemap: SitemapReport | null;
  limits: CrawlLimits | null;
  warnings: string[];
}
export interface CrawlResult {
  pages: PageAnalysis[];
  relationships: CrawlRelationship[];
  robots: RobotsReport;
  sitemap: SitemapReport;
  limits: CrawlLimits;
  warnings: string[];
}
export interface AnalysisContext extends CrawlResult { startUrl: string; domain: string }
