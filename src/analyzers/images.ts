import { htmlPages, type Analyzer } from "./types";
export const analyzeImages: Analyzer = (context, report) => {
  for (const page of htmlPages(context)) for (const image of page.parsed.images) {
    if (image.alt === null) report.add("image_alt_missing", page.url, `Image missing alt attribute: ${image.src}`);
    else if (!image.alt.trim()) report.add("image_alt_empty", page.url, `Empty alt: ${image.src}; this may correctly mark a decorative or redundant image.`);
    if (image.contentLength !== null && image.contentLength > 500 * 1024) report.add("image_heavy", page.url, `${image.src}: reported Content-Length ${image.contentLength} bytes (${(image.contentLength / 1024).toFixed(0)} KiB) from HEAD. The 500 KiB cutoff is an application heuristic; browser transfer, selected responsive variant, visibility and loading impact were not measured.`);
  }
};
