import type { Analyzer } from "./types";
import { analyzeHttp } from "./http";
import { analyzeIndexability, analyzeGooglebotRobots } from "./indexability";
import { analyzeMetadata } from "./metadata";
import { analyzeContent } from "./content";
import { analyzeLinks } from "./links";
import { analyzeImages } from "./images";
import { analyzeStructuredData, analyzeTracking } from "./structured";
import { analyzeSitemap } from "./sitemap";

/** Add a pure analyzer here to extend the report without changing crawler or routes. */
export const analyzerRegistry: readonly Analyzer[] = [
  analyzeHttp, analyzeIndexability, analyzeGooglebotRobots, analyzeMetadata, analyzeContent,
  analyzeLinks, analyzeImages, analyzeStructuredData, analyzeTracking, analyzeSitemap,
];
export type { Analyzer, IssueReporter } from "./types";
