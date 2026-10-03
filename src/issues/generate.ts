import type { AnalysisContext, Issue } from "../shared/types";
import { SEVERITIES } from "../shared/types";
import { analyzerRegistry } from "../analyzers";
import { issueCatalog, type IssueId } from "./catalog";
import type { Analyzer, IssueReporter } from "../analyzers/types";

/** One consolidated issue per rule, with independently replaceable/additional analyzers. */
export function generateIssues(context: AnalysisContext, analyzers: readonly Analyzer[] = analyzerRegistry): Issue[] {
  const issues = new Map<IssueId, Issue>();
  const evidenceKeys = new Map<IssueId, Set<string>>();
  const reporter: IssueReporter = {
    add(id, url, detail) {
      let issue = issues.get(id);
      if (!issue) { issue = { id, ...issueCatalog[id], affectedUrls: [], evidence: [] }; issues.set(id, issue); evidenceKeys.set(id, new Set()); }
      if (!issue.affectedUrls.includes(url)) issue.affectedUrls.push(url);
      const key = `${url}\u0000${detail}`;
      if (!evidenceKeys.get(id)?.has(key)) { issue.evidence.push({ url, detail }); evidenceKeys.get(id)?.add(key); }
    },
  };
  for (const analyzer of analyzers) analyzer(context, reporter);
  return [...issues.values()].sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || a.category.localeCompare(b.category) || a.id.localeCompare(b.id));
}
