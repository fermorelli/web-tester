"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { AuditSummary } from "@/shared/types";
import { Shell } from "./shell";
import { Icon } from "./icons";
import { dateLabel, ErrorNotice, isActive, LoadingState, numberLabel, ProgressCard, requestJson, StatusBadge } from "./ui";

export function Home() {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [audits, setAudits] = useState<AuditSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [recentId, setRecentId] = useState<string | null>(null);
  const [maxPages, setMaxPages] = useState(100);
  const load = useCallback(async () => {
    try {
      const data = await requestJson<{ audits: AuditSummary[] }>("/api/audits");
      setAudits(data.audits);
      setLoadError(null);
    } catch (error) { setLoadError(error instanceof Error ? error.message : "The audit history could not be loaded."); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const hasActive = audits.some((audit) => isActive(audit.status));
  useEffect(() => {
    if (!hasActive) return;
    const timer = window.setInterval(() => { void load(); }, 1500);
    return () => window.clearInterval(timer);
  }, [hasActive, load]);

  async function analyze(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!url.trim()) { setFormError("Enter a domain or URL to get started."); return; }
    setSubmitting(true);
    setFormError(null);
    try {
      const { audit } = await requestJson<{ audit: AuditSummary }>("/api/audits", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: url.trim(), maxPages }) });
      setRecentId(audit.id);
      setAudits((previous) => [audit, ...previous.filter((item) => item.id !== audit.id)]);
      router.push(`/audits/${encodeURIComponent(audit.id)}/summary`);
    } catch (error) { setFormError(error instanceof Error ? error.message : "The audit could not be started."); }
    finally { setSubmitting(false); }
  }

  const current = audits.find((audit) => audit.id === recentId) ?? audits.find((audit) => isActive(audit.status));
  const completed = audits.filter((audit) => audit.status === "completed");
  const pageCount = audits.reduce((sum, audit) => sum + audit.crawledPages, 0);
  const domains = new Set(audits.map((audit) => audit.domain)).size;

  return <Shell>
    <div className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" /> YOUR SEO WORKSPACE</div><h1>A clear view of your website.</h1><p>Find technical issues, understand their impact, and know where to start.</p></div><span className="heading-tag"><Icon name="shield" size={15} /> No AI APIs</span></div>
    <section className="analyze-panel" aria-labelledby="analyze-title">
      <div className="analyze-panel-top"><div className="panel-icon"><Icon name="globe" size={26} /></div><span className="label-pill">NEW AUDIT</span></div>
      <h2 id="analyze-title">It starts with a URL.</h2><p className="analyze-description">Check technical SEO within the URL path you enter. Lighthouse tests that starting page once.</p>
      <form onSubmit={analyze} className="analyze-form">
        <label className="sr-only" htmlFor="site-url">Website domain or URL</label>
        <div className={`url-input-wrap ${formError ? "input-error" : ""}`}><Icon name="link" size={20} /><input id="site-url" name="url" type="text" inputMode="url" autoComplete="url" autoCapitalize="none" spellCheck={false} placeholder="example.com or https://example.com" value={url} onChange={(event) => setUrl(event.target.value)} aria-invalid={Boolean(formError)} aria-describedby={formError ? "url-error" : "url-hint"} disabled={submitting} /><button className="button primary analyze-button" type="submit" disabled={submitting || hasActive}>{submitting ? <><span className="spinner light" /> Starting…</> : <>Analyze <Icon name="arrow" size={18} /></>}</button></div>
        {formError && <p className="field-error" id="url-error" role="alert">{formError}</p>}
        <div className="form-options"><p id="url-hint"><Icon name="shield" size={14} /> Public websites · Static HTML · URL path and descendants</p><label htmlFor="max-pages">Up to <select id="max-pages" value={maxPages} onChange={(event) => setMaxPages(Number(event.target.value))} disabled={submitting || hasActive}><option value={25}>25</option><option value={50}>50</option><option value={100}>100</option></select> pages</label></div>
      </form>
      {hasActive && <p className="form-active-note">An audit is running. You can follow its progress below.</p>}
      <div className="analysis-coverage"><span><Icon name="check" size={15} /> Indexability & metadata</span><span><Icon name="check" size={15} /> Links & content</span><span><Icon name="check" size={15} /> HTTP & sitemap</span></div>
    </section>
    {current && <div className="current-audit"><ProgressCard audit={current} /><Link href={`/audits/${current.id}/summary`} className="button secondary">{isActive(current.status) ? "Open audit overview" : "View overview"}<Icon name="arrow" size={17} /></Link></div>}
    <div className="workspace-stats"><div><span className="stat-icon blue"><Icon name="file" /></span><div><strong>{numberLabel(completed.length)}</strong><span>Completed audits</span></div></div><div><span className="stat-icon teal"><Icon name="globe" /></span><div><strong>{numberLabel(domains)}</strong><span>Hosts analyzed</span></div></div><div><span className="stat-icon purple"><Icon name="layers" /></span><div><strong>{numberLabel(pageCount)}</strong><span>Pages processed</span></div></div></div>
    <section className="history-section" id="history" aria-labelledby="history-title"><div className="section-heading"><div><h2 id="history-title">Audit history <span className="count-badge">{audits.length}</span></h2><p>Saved technical evidence for your next review.</p></div><button className="text-button" onClick={() => { void load(); }} disabled={loading}><Icon name="history" size={16} /> Refresh</button></div>
      <div className="panel history-panel">{loadError ? <ErrorNotice message={loadError} retry={() => { void load(); }} /> : loading ? <LoadingState label="Loading audit history…" /> : audits.length === 0 ? <div className="empty-state"><div className="empty-illustration"><div className="empty-file"><Icon name="file" size={35} /><span /><span /></div><span className="empty-search"><Icon name="search" size={23} /></span></div><h3>Your first finding is one URL away.</h3><p>Your audits will appear here with their pages,<br className="desktop-break" /> findings, and technical details.</p><span className="empty-caption">Enter a website above to get started <Icon name="arrow" size={14} /></span></div> : <div className="table-scroll"><table className="history-table"><thead><tr><th>Website / date</th><th>Status</th><th>Pages</th><th>SEO issues / observations</th><th><span className="sr-only">Open overview</span></th></tr></thead><tbody>{audits.map((audit) => <tr key={audit.id}><td><Link href={`/audits/${audit.id}/summary`} className="site-cell"><span className="site-favicon"><Icon name="globe" size={19} /></span><span><strong>{audit.startUrl}</strong><small>{dateLabel(audit.startedAt)}</small></span></Link></td><td><StatusBadge status={audit.status} /></td><td className="tabular">{numberLabel(audit.crawledPages)}<span className="muted"> / {audit.maxPages}</span></td><td>{isActive(audit.status) ? <span className="muted">Processing</span> : <span className="issue-count">{numberLabel(audit.issueCount)} / {numberLabel(audit.observationCount ?? 0)}{(audit.analysisVersion ?? 0) < 2 && <small className="muted"> · legacy</small>}</span>}</td><td><Link className="row-link" href={`/audits/${audit.id}/summary`} aria-label={`View overview for ${audit.domain}`}><Icon name="arrow" size={18} /></Link></td></tr>)}</tbody></table></div>}</div>
    </section>
    <div className="scope-note"><Icon name="terminal" size={18} /><p><strong>Observable data, informed decisions.</strong> A URL at the host root covers that host. A URL with a path covers only that path and its descendants. Technical issues and contextual observations are counted separately; JavaScript-rendered content is not evaluated.</p></div>
  </Shell>;
}
