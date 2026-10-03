import { htmlPages, type Analyzer } from "./types";
export const analyzeContent: Analyzer = (context, report) => {
  const contentGroups = new Map<string, ReturnType<typeof htmlPages>>();
  for (const page of htmlPages(context)) {
    const { h1, headings, wordCount, contentHash } = page.parsed;
    if (!h1.some(text => text.trim())) report.add("h1_missing", page.url, `${h1.length} H1 elements; none contain text.`);
    if (h1.length > 1) report.add("h1_multiple", page.url, `${h1.length} H1 elements: ${h1.join(" | ")}`);
    const empty = headings.filter(heading => !heading.text).map(heading => `H${heading.level}`);
    if (empty.length) report.add("heading_empty", page.url, `${empty.length} empty headings: ${empty.join(", ")}`);
    let previous = 0;
    for (const heading of headings) {
      if (heading.level > previous + 1) report.add("heading_hierarchy", page.url, `${previous ? `H${previous}` : "Start"} → H${heading.level}: ${heading.text || "(empty)"}`);
      previous = heading.level;
    }
    if (wordCount < 100) report.add("thin_content", page.url, `${wordCount} approximate words in HTML; JavaScript was not rendered.`);
    if (wordCount >= 50 && contentHash) {
      const group = contentGroups.get(contentHash) ?? [];
      if (!group.some(member => member.finalUrl === page.finalUrl)) group.push(page);
      contentGroups.set(contentHash, group);
    }
  }
  for (const [hash, pages] of contentGroups) if (pages.length > 1) {
    for (const page of pages) report.add("content_duplicate", page.url, `${pages.length} pages with identical normalized text; hash ${hash.slice(0, 16)}; ${page.parsed.wordCount} words.`);
  }
};
