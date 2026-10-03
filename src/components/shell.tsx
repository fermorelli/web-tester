"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "./icons";

export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isReport = pathname.startsWith("/audits/");
  const isSummary = isReport && pathname.endsWith("/summary");
  return <div className="app-shell">
    <aside className="sidebar">
      <Link href="/" className="brand" aria-label="Site Inspector, home"><span className="brand-mark"><Icon name="layers" size={23} /></span><span>Site<span className="brand-light">Inspector</span><small>SEO & TECHNICAL AUDIT</small></span></Link>
      <div className="sidebar-label">WORKSPACE</div>
      <nav aria-label="Main navigation">
        <Link href="/" className={`nav-item ${!isReport ? "active" : ""}`} aria-current={!isReport ? "page" : undefined}><Icon name="grid" /><span>Overview</span>{!isReport && <span className="nav-dot" />}</Link>
        <Link href="/#history" className="nav-item"><Icon name="history" /><span>Audit history</span></Link>
        {isReport && <span className="nav-item active"><Icon name="file" /><span>{isSummary ? "Audit overview" : "Full SEO report"}</span><span className="nav-dot" /></span>}
      </nav>
      <div className="sidebar-note"><span className="note-icon"><Icon name="terminal" size={19} /></span><strong>Your SEO workspace</strong><p>Website audits and technical evidence, saved for review.</p><div className="local-indicator"><span /> Internal workspace</div></div>
      <div className="sidebar-footer"><span className="avatar">SI</span><div><strong>Personal workspace</strong><small>Saved audit history</small></div></div>
    </aside>
    <div className="main-shell">
      <header className="topbar"><div className="breadcrumb"><Link href="/">Workspace</Link><Icon name="chevron" size={13} /><span>{isReport ? "Website audit" : "Overview"}</span></div><span className="local-pill"><span /> Internal workspace</span></header>
      <main id="main-content" tabIndex={-1}>{children}</main>
      <footer className="main-footer"><span>Site Inspector</span><span>Real HTML. Evidence behind every finding.</span></footer>
    </div>
  </div>;
}
