import { htmlPages, type Analyzer } from "./types";
import type { IssueId } from "../issues/catalog";
export const analyzeMetadata: Analyzer = (context, report) => {
  const pages = htmlPages(context);
  for (const page of pages) {
    const { title, description, social } = page.parsed;
    if (!title) report.add("title_missing", page.url, "Title missing or empty.");
    else if (title.length < 15) report.add("title_short", page.url, `${title.length} characters: ${title}`);
    else if (title.length > 60) report.add("title_long", page.url, `${title.length} characters: ${title}`);
    if (!description) report.add("description_missing", page.url, "Meta description missing or empty.");
    else if (description.length < 70) report.add("description_short", page.url, `${description.length} characters: ${description}`);
    else if (description.length > 160) report.add("description_long", page.url, `${description.length} characters: ${description}`);
    const missing = ["og:title", "og:description", "og:image"].filter(key => !social.openGraph[key]?.trim());
    if (missing.length) report.add("social_incomplete", page.url, `Missing or empty fields: ${missing.join(", ")}`);
    if (!social.twitter["twitter:card"]?.trim()) report.add("twitter_missing", page.url, "twitter:card missing or empty.");
  }
  const collectDuplicates = (field: "title" | "description", id: IssueId) => {
    const values = new Map<string, typeof pages>();
    for (const page of pages) {
      const value = page.parsed[field]?.toLowerCase().replace(/\s+/g, " ").trim();
      if (!value) continue;
      const group = values.get(value) ?? [];
      // Redirect aliases of the same final resource are not two documents.
      if (!group.some(member => member.finalUrl === page.finalUrl)) group.push(page);
      values.set(value, group);
    }
    for (const [value, duplicates] of values) if (duplicates.length > 1) {
      for (const page of duplicates) report.add(id, page.url, `${duplicates.length} pages with the same ${field}: ${value}`);
    }
  };
  collectDuplicates("title", "title_duplicate");
  collectDuplicates("description", "description_duplicate");
};
