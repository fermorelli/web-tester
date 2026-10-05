import { htmlPages, type Analyzer } from "./types";
export const analyzeContent: Analyzer = (context, report) => {
  const contentGroups = new Map<string, ReturnType<typeof htmlPages>>();
  for (const page of htmlPages(context)) {
    const { h1, headings, wordCount, contentHash } = page.parsed;
    if (h1.length === 0) report.add("h1_missing", page.url, "0 H1 elements in the received HTML. JavaScript was not rendered; this does not establish the absence of a visible main heading.");
    if (h1.length > 1) report.add("h1_multiple", page.url, `${h1.length} H1 elements in received HTML: ${h1.join(" | ")}. Their visual prominence was not evaluated.`);
    const empty = headings.filter(heading => !heading.text).map(heading => `H${heading.level}`);
    if (empty.length) report.add("heading_empty", page.url, `${empty.length} headings without text in received HTML: ${empty.join(", ")}. JavaScript was not rendered and accessible names were not evaluated.`);
    let previous = 0;
    for (const heading of headings) {
      if (heading.level > previous + 1) report.add("heading_hierarchy", page.url, `${previous ? `H${previous}` : "Start"} → H${heading.level}: ${heading.text || "(empty)"}. HTML document order only; distinct page regions were not evaluated.`);
      previous = heading.level;
    }
    if (wordCount > 0 && contentHash) {
      const group = contentGroups.get(contentHash) ?? [];
      if (!group.some(member => member.finalUrl === page.finalUrl)) group.push(page);
      contentGroups.set(contentHash, group);
    }
  }
  for (const [hash, pages] of contentGroups) if (pages.length > 1) {
    for (const page of pages) report.add("content_duplicate", page.url, `${pages.length} pages with identical normalized text extracted from HTML; hash ${hash.slice(0, 16)}; ${page.parsed.wordCount} estimated words. This does not establish duplicate rendered content or a ranking penalty.`);
  }
};
