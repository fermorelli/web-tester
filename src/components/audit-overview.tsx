"use client";

import Link from "next/link";
import type { CSSProperties } from "react";
import type { LighthouseResult } from "@/shared/types";
import { Icon } from "./icons";
import { Shell } from "./shell";
import { dateLabel, ErrorNotice, isActive, LoadingState, numberLabel, ProgressCard, StatusBadge } from "./ui";
import { useAudit } from "./use-audit";

export function AuditOverview({ id }: { id: string }) {
  const { audit, loading, error, reload } = useAudit(id);
  const active = audit ? isActive(audit.status) : false;
  const lighthouse = audit?.lighthouse;
  const fullReportUrl = `/audits/${encodeURIComponent(id)}`;

  return <Shell>
    <Link className="back-link" href="/"><Icon name="arrow-left" size={16} /> All audits</Link>
    {loading && <LoadingState label="Loading audit overview…" />}
    {error && <ErrorNotice message={error} retry={() => { void reload(); }} />}
    {audit && <>
      <div className="report-heading">
        <div><div className="eyebrow">AUDIT OVERVIEW</div><h1>{audit.domain}</h1><div className="report-meta"><span><Icon name="clock" size={15} /> {dateLabel(audit.startedAt)}</span><span className="meta-divider" /><StatusBadge status={audit.status} /></div></div>
        {!active && <Link href={fullReportUrl} className="button primary">View full SEO report <Icon name="arrow" size={18} /></Link>}
      </div>
      {active && <ProgressCard audit={audit} />}
      {!active && audit.error && <div className="notice warning-notice"><Icon name="alert" /><p>{audit.error} You can review the SEO data that was saved before the audit stopped.</p></div>}
      <section className="panel lighthouse-panel" aria-labelledby="lighthouse-heading">
        <div className="lighthouse-heading"><div><h2 id="lighthouse-heading">Homepage Lighthouse</h2><p>One homepage check, four scores, and the key performance metrics.</p></div><span className="label-pill">MOBILE LAB TEST</span></div>
        {active && !lighthouse ? <div className="lighthouse-pending" role="status"><span className="spinner" /><div><strong>{audit.progress >= 90 ? "Analyzing homepage performance…" : "Homepage performance analysis is pending."}</strong><p>The overview will update when the SEO crawl and homepage analysis finish.</p></div></div> : lighthouse?.status === "completed" ? <LighthouseOverview result={lighthouse} /> : <div className="lighthouse-unavailable" role="status"><span className="unavailable-symbol"><Icon name="alert" size={24} /></span><div><h3>Performance analysis unavailable</h3><p>{lighthouse?.error || "This saved audit does not include a Lighthouse analysis. Start a new audit to measure the homepage."}</p><p>{audit.status === "completed" ? "The SEO audit is complete, and its full report remains available." : "Any available SEO results can still be viewed in the full report."}</p></div></div>}
        {lighthouse && <div className="lighthouse-target"><span>Tested homepage</span><a href={lighthouse.homepageUrl} target="_blank" rel="noopener noreferrer">{lighthouse.homepageUrl}<Icon name="external" size={14} /></a>{lighthouse.finalUrl && lighthouse.finalUrl !== lighthouse.homepageUrl && <p>Final URL: <span className="break-url">{lighthouse.finalUrl}</span></p>}</div>}
      </section>
      <section className="seo-overview" aria-labelledby="seo-overview-heading">
        <div className="section-heading"><div><h2 id="seo-overview-heading">SEO crawl at a glance</h2><p>{active ? "Your crawl is in progress. Counts will be finalized when the audit finishes." : `A sample of up to ${audit.maxPages} pages, with the evidence behind every finding.`}</p></div></div>
        <div className="report-stats overview-stats"><OverviewStat label="Pages processed" value={audit.crawledPages} detail="Includes blocked URLs and request errors" /><OverviewStat label="Indexable pages" value={audit.pages.filter((page) => page.indexable === true).length} detail="Based on observed HTML and HTTP signals" /><OverviewStat label="Issue types" value={audit.issueCount} detail={active ? "Waiting for final analysis" : "Grouped findings in the full SEO report"} /><OverviewStat label="Pages with errors" value={audit.errorPages} detail="HTTP or request errors" /></div>
      </section>
      {!active && <div className="overview-report-action"><div><h3>Explore the details behind the overview.</h3><p>Review issues, suggested fixes, individual pages, and crawl coverage.</p></div><Link href={fullReportUrl} className="button primary">View full SEO report <Icon name="arrow" size={18} /></Link></div>}
    </>}
  </Shell>;
}

function LighthouseOverview({ result }: { result: LighthouseResult }) {
  return <>
    <div className="lighthouse-scores"><Score label="Performance" value={result.scores?.performance ?? null} /><Score label="Accessibility" value={result.scores?.accessibility ?? null} /><Score label="Best Practices" value={result.scores?.bestPractices ?? null} /><Score label="SEO" value={result.scores?.seo ?? null} /></div>
    <div className="lighthouse-legend"><span className="score-legend-good">90–100 Good</span><span className="score-legend-average">50–89 Needs improvement</span><span className="score-legend-poor">0–49 Poor</span></div>
    <div className="lighthouse-metrics"><Metric name="LCP" fullName="Largest Contentful Paint" value={result.metrics?.lcpMs == null ? "Unavailable" : `${(result.metrics.lcpMs / 1000).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} s`} description="Time until the largest visible content appears." /><Metric name="CLS" fullName="Cumulative Layout Shift" value={result.metrics?.cls == null ? "Unavailable" : result.metrics.cls.toLocaleString("en-US", { minimumFractionDigits: 3, maximumFractionDigits: 3 })} description="How much visible content shifts during loading." /><Metric name="TBT" fullName="Total Blocking Time" value={result.metrics?.tbtMs == null ? "Unavailable" : `${numberLabel(Math.round(result.metrics.tbtMs))} ms`} description="Time the main thread is blocked during loading." /></div>
    <p className="lighthouse-footnote">Mobile lab measurements with simulated throttling. Results can vary between runs and do not represent field data from real visitors.{result.version ? ` Lighthouse ${result.version}.` : ""} Measured {dateLabel(result.analyzedAt)}.</p>
    {result.warnings.length > 0 && <details className="data-details lighthouse-warnings"><summary>Analysis notes ({result.warnings.length})</summary><ul className="warning-list">{result.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
  </>;
}

function Score({ label, value }: { label: string; value: number | null }) {
  const score = value === null ? null : Math.max(0, Math.min(100, Math.round(value)));
  const quality = score === null ? "unknown" : score >= 90 ? "good" : score >= 50 ? "average" : "poor";
  return <div className={`lighthouse-score score-${quality}`}><div className="score-ring" style={{ "--score-turn": `${score ?? 0}%` } as CSSProperties}><strong aria-label={`${label}: ${score === null ? "unavailable" : `${score} out of 100`}`}>{score ?? "—"}</strong></div><h3>{label}</h3><span>{score === null ? "Unavailable" : "out of 100"}</span></div>;
}

function Metric({ name, fullName, value, description }: { name: string; fullName: string; value: string; description: string }) {
  return <div className="lighthouse-metric"><div><h3>{name}</h3><span>{fullName}</span></div><strong>{value}</strong><p>{description}</p></div>;
}

function OverviewStat({ label, value, detail }: { label: string; value: number; detail: string }) {
  return <div className="report-stat"><div className="report-stat-label">{label}</div><strong>{numberLabel(value)}</strong><small>{detail}</small></div>;
}
