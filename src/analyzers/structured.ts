import { htmlPages, type Analyzer } from "./types";
export const analyzeStructuredData: Analyzer = (context, report) => {
  for (const page of htmlPages(context)) {
    if (!page.parsed.jsonLdCount) report.add("schema_missing", page.url, "0 JSON-LD blocks in the received HTML. Microdata, RDFa and JavaScript-injected markup were not evaluated; structured data is optional for general indexing.");
    for (const error of page.parsed.jsonLdErrors) report.add("schema_invalid", page.url, error);
  }
};
export const analyzeTracking: Analyzer = (context, report) => {
  for (const page of htmlPages(context)) if (page.parsed.tracking.length) report.add("tracking_detected", page.url, `Patterns recognized in HTML: ${page.parsed.tracking.join(", ")}. Scripts were not executed.`);
};
