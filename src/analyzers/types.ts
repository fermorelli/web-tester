import type { AnalysisContext, ParsedPage, PageAnalysis } from "../shared/types";
import type { IssueId } from "../issues/catalog";
export interface IssueReporter { add(id: IssueId, url: string, detail: string): void }
export type Analyzer = (context: AnalysisContext, report: IssueReporter) => void;
export type HtmlPage = PageAnalysis & { parsed: ParsedPage };
export function htmlPages(context: AnalysisContext): HtmlPage[] {
  return context.pages.filter((page): page is HtmlPage => !!page.parsed && !page.blockedByRobots);
}
export function pageLookup(context: AnalysisContext): Map<string, PageAnalysis> {
  const lookup = new Map<string, PageAnalysis>();
  for (const page of context.pages) lookup.set(page.url, page);
  // Requested URL evidence takes priority over aliases reached through redirects.
  for (const page of context.pages) if (!lookup.has(page.finalUrl)) lookup.set(page.finalUrl, page);
  return lookup;
}
