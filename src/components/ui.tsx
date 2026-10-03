"use client";

import type { AuditStatus, AuditSummary, Category, Severity } from "@/shared/types";
import { Icon } from "./icons";

export const categoryLabels: Record<Category, string> = { HTTP: "HTTP", Indexability: "Indexability", Metadata: "Metadata", Content: "Content", Links: "Links", Images: "Images", "Structured Data": "Structured Data", Sitemap: "Sitemap", Tracking: "Tracking" };
export const severityLabels: Record<Severity, string> = { critical: "Critical", high: "High", medium: "Medium", low: "Low", info: "Info" };
export const severityDescriptions: Record<Severity, string> = { critical: "Issues requiring immediate attention", high: "Issues with significant impact", medium: "Meaningful opportunities for improvement", low: "Minor adjustments and improvements", info: "Information to review in context" };
const statusLabels: Record<AuditStatus, string> = { queued: "Queued", running: "Analyzing", completed: "Completed", failed: "Failed", interrupted: "Interrupted" };

export function dateLabel(date: string) { return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(date)); }
export function numberLabel(value: number) { return value.toLocaleString("en-US"); }
export function pageHref(id: string, url: string) { return `/audits/${encodeURIComponent(id)}/pages?url=${encodeURIComponent(url)}`; }
export function isActive(status: AuditStatus) { return status === "queued" || status === "running"; }

export async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const data = await response.json().catch(() => null) as T & { error?: string } | null;
  if (!response.ok) throw new Error(data?.error || `The request could not be completed (${response.status}).`);
  if (!data) throw new Error("The server returned an invalid response.");
  return data;
}

export function StatusBadge({ status }: { status: AuditStatus }) {
  return <span className={`status-badge status-${status}`}><span className={isActive(status) ? "status-dot pulsing" : "status-dot"} />{statusLabels[status]}</span>;
}

export function SeverityBadge({ severity }: { severity: Severity }) { return <span className={`severity-badge severity-${severity}`}><span />{severityLabels[severity]}</span>; }

export function ErrorNotice({ message, retry }: { message: string; retry?: () => void }) {
  return <div className="notice error-notice" role="alert"><Icon name="alert" /><div><strong>This action could not be completed</strong><p>{message}</p></div>{retry && <button className="button subtle small" onClick={retry}>Retry</button>}</div>;
}

export function ProgressCard({ audit, compact = false }: { audit: AuditSummary; compact?: boolean }) {
  const progress = Math.max(0, Math.min(100, audit.progress));
  return <div className={`progress-card ${compact ? "compact" : ""}`} aria-live="polite"><div className="progress-heading"><span className="progress-symbol"><Icon name={isActive(audit.status) ? "search" : audit.status === "completed" ? "check" : "alert"} size={20} /></span><div><strong>{isActive(audit.status) ? `Analyzing ${audit.domain}` : audit.status === "completed" ? "Your audit is ready" : "Audit stopped"}</strong><p>{audit.message || (isActive(audit.status) ? "Preparing the audit…" : "Review the available results.")}</p></div><StatusBadge status={audit.status} /></div>{isActive(audit.status) && <><div className="progress-track" role="progressbar" aria-label="Audit progress" aria-valuenow={Math.round(progress)} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${progress}%` }} /></div><div className="progress-foot"><span>{numberLabel(audit.crawledPages)} pages processed · limit {audit.maxPages}</span><strong>{Math.round(progress)}%</strong></div><p className="progress-hint">Progress includes the SEO crawl and homepage Lighthouse analysis. Findings are saved when the audit finishes.</p></>}{audit.error && <p className="progress-error">{audit.error}</p>}</div>;
}

export function LoadingState({ label = "Loading audit…" }: { label?: string }) { return <div className="loading-state" role="status"><span className="spinner" /><span>{label}</span></div>; }
