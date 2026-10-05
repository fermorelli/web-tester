# Site Inspector

A personal website auditing tool built with Next.js App Router, strict TypeScript, Tailwind, Node.js, Cheerio, SQLite and Vitest. It performs a real HTTP crawl, generates deterministic SEO issues, and runs a separate mobile Lighthouse lab test on the site's homepage. No AI API is used.

## Run locally

Use **Node.js 24 or newer**. SQLite uses Node's built-in `node:sqlite`; no database server or native addon build is required. Node 24 may print an experimental SQLite warning.

```powershell
npm ci
npm run dev
```

Open <http://127.0.0.1:3000>. Enter a domain (HTTPS is assumed) or a full URL, select 25, 50 or 100 pages, and click **Analyze**. A progress screen opens, followed by the homepage overview and a **View full SEO report** button after both steps finish. Previous audits remain in the local history.

For production mode:

```powershell
npm run build
npm run start
```

Production startup reads `PORT` (default `3000`) and `APP_HOST` (default `127.0.0.1`). `npm run start:railway` defaults to `0.0.0.0`. Development always binds to `127.0.0.1`; use `npm run dev -- --port 3001` to change its port. Run **one server instance per database**. After a restart, unfinished audits become interrupted and retain their saved pages and SEO checkpoint; they are not resumed automatically.

Copy `.env.example` to `.env.local` for optional configuration. Lighthouse discovers common Chrome/Chromium installations, including Chrome and Microsoft Edge on Windows. Set `CHROME_PATH` to override discovery, for example `C:/Program Files/Google/Chrome/Application/chrome.exe`. The HTTP crawl remains usable when Chrome is unavailable.

## Reports and interpretation

- A short English summary, issue groups by severity/category, expandable explanations, affected URLs, technical evidence and JSON export.
- A page table and inspector with HTTP, title, description, canonical, indexability estimate, words, headings, links, images, schema, social tags and tracking signatures.
- HTTP 4xx/5xx and redirect chains; network errors remain separate from confirmed broken links.
- Robots.txt, generic/Googlebot metadata directives, X-Robots-Tag, noindex/nofollow and basic canonical checks. Other agent-specific metadata is retained in the inspector.
- Missing titles and duplicate metadata; title/description lengths are visible measurements, with no automatic character-count failure. Headings are static-HTML observations, not ranking requirements.
- Approximate main-content words and potential duplication using normalized-text hashes; navigation, scripts and common layout blocks are excluded.
- Internal/external links, observed broken internal destinations, links to redirects, minimum observed navigation depth and possible orphan pages.
- Missing/empty image alt, and potentially large images when HEAD supplies Content-Length.
- JSON-LD type inventory and malformed JSON; syntax checks do not validate JSON-LD semantics or rich-result eligibility. Open Graph/Twitter tags and tracking signatures are contextual observations.
- Standard/robots-declared sitemaps, sitemap indexes and gzip XML; comparisons between declared, linked and sampled URLs.

SEO issue counts include only observed technical defects. **Contextual observations** (optional metadata, intentional directives, sharing tags, declared image sizes, navigation and unverified requests) are kept separately and do not increase that count. Each rule includes reference guidance and response evidence. Missing canonical, sitemap or JSON-LD is not a general SEO failure. Character/word thresholds do not generate new findings. There is no overall SEO score. Lighthouse's separate category scores describe one homepage lab run.

The SEO crawl analyzes **HTML returned by HTTP**. It does not execute JavaScript or query a search engine index. Dynamic sites may expose less content to this crawler. Indexability is an estimate rather than proof of indexing; robots.txt does not guarantee removal from an index. Unverifiable HTML remains undetermined.

**Scope follows the submitted URL.** A host-root URL covers that host and its `www` alias. A URL with a path covers that exact path and slash-delimited descendants; `/new-portfolio/` does not include sibling projects such as `/E-commerce/`. The report displays and persists this boundary. Page redirects cannot escape it. Same-host robots.txt and sitemap documents may be read outside the path to discover scoped URLs, but out-of-scope page URLs do not enter the audit or its sitemap comparisons. Links outside the scope remain visible in the inspector and are not tested. Fragments and known tracking/session parameters are removed; functional parameters, path case and trailing slashes remain distinct. Assets and login/cart/search/feed paths are skipped. The entered starting URL is reviewed even when its path is unusual.

Navigation is prioritized and interleaved with samples from different sitemap sections. Limits are **100 pages**, **3 concurrent requests**, **10 seconds per HTTP request**, **5 seconds for DNS**, **2 MB per response**, **5 redirects**, **20 sitemap documents**, **10,000 sitemap URLs**, **5,000 navigation candidates** and an approximate **10-minute crawl scheduling budget**. Response caps also apply after decompression. In-flight requests can finish beyond the scheduling budget. Page, sitemap and image requests are scheduled at least 200 ms apart per origin, respecting a longer robots `crawl-delay`; the initial robots.txt lookup establishes that policy.

Up to **30 unique internal images** are checked with HEAD. External images and responses without Content-Length have an unknown size. Text is decoded as UTF-8. Limits, uncertainty and truncation appear in the report. Orphans, alt quality and potential text duplication require context and are not confirmed by a crawl sample. JSON-LD semantic completeness is not assessed. Sitemap HTTP/noindex/redirect findings require an observed response; unsampled link destinations remain unverified. Tracking reports observed signatures and makes no compliance assessment.

The crawler uses **SiteInspectorBot** robots rules separately for each origin and redirect destination. It applies a conservative stop when robots.txt returns 401/403, 429, 5xx or cannot be checked; 404/410 allow crawling. Googlebot's rules in the initial robots.txt are also evaluated for SEO findings. Every crawl request validates public DNS and pins a verified address; private/local addresses, unsupported schemes/ports, credentials and unsafe redirects are refused.

Audits generated before scope/rule version 2 retain their original crawl evidence and show a legacy warning. Start a new audit to apply path scoping and the conservative rules; saved pages are not silently reclassified as a new crawl.

The rule criteria follow [Google Search Central](https://developers.google.com/search/docs/fundamentals/seo-starter-guide), including its guidance that content length and heading counts are not ranking requirements. Canonical signals from both HTML and HTTP `Link` headers are recorded; identical repeated declarations are not treated as conflicting. Content rules do not produce secondary findings for HTTP error templates or unverified HTML.

## Homepage Lighthouse test

After the SEO crawl is checkpointed in SQLite, Lighthouse runs **once on the submitted audit root**, using a mobile configuration. It keeps a project path such as `/new-portfolio/` and removes query/fragment state; it does not substitute the hostname root `/` for a path-hosted website. It records Performance, Accessibility, Best Practices and SEO scores plus LCP, CLS and TBT when available. It does not run on every crawled page. These are lab observations, not real-user Core Web Vitals or proof of accessibility/compliance. Scores can vary with load and network conditions.

Chrome runs in an isolated child process with an overall timeout. `LIGHTHOUSE_TIMEOUT_MS` defaults to `120000` and is clamped between `10000` and `180000` milliseconds. Missing Chrome, timeout, browser crashes and unsuccessful runs produce an unavailable result with an explanation; saved SEO pages and findings remain available. Older audits without Lighthouse data are shown as not previously measured.

Full-page screenshot gathering is disabled because this application uses only Lighthouse scores and metrics. If Chromium crashes, check Railway's **Deploy Logs** for `[Lighthouse] Analysis unavailable` and its resource **Metrics**. The log retains the Lighthouse error code, worker exit status/signal, and memory snapshots. On hosts exposing cgroup v2 counters, an increased `oom_kill` count identifies a memory kill during that run; a tab crash alone does not prove memory exhaustion. The memory peak is the container's peak since startup, not a per-audit measurement. A completed audit's saved result stays unchanged; start a new audit after adjusting resources or deploying a fix. `example.com` is a useful lightweight comparison when only larger homepages fail.

Browser requests pass through a local public-IP-only proxy that checks DNS and pins validated addresses. Lighthouse can load public third-party resources needed by the homepage; local/private resources are refused. The proxy and hosting hardware can affect timings. Chromium uses container-compatible flags in Docker. This is an intentionally small trusted-testing setup, not a multi-tenant browser service.

## Railway preparation

The repository includes a `Dockerfile`, `.dockerignore` and environment-aware startup script for **one Railway service**. These files do not create a project or deploy anything. Configure Railway in its dashboard; the older `railway.json` config-as-code flow is deprecated. See [Railway configuration](https://docs.railway.com/config-as-code).

When you choose to deploy:

1. Connect this repository to a Railway service with its root directory set to this application's repository root. Railway detects `Dockerfile`; leave the custom **Start Command empty** so the image's entrypoint and default command run. The Dockerfile uses Node 24 on Debian Bookworm, installs Chromium, certificates and fonts, builds Next.js, and removes development dependencies. Runtime Lighthouse dependencies, Next's configuration loader and the worker script are retained. Tini forwards shutdown signals and reaps orphaned browser processes. A custom Railway Start Command would override that entrypoint. See [Railway start commands](https://docs.railway.com/deployments/start-command).
2. Attach a **persistent volume mounted at `/data`** and set `DATABASE_PATH=/data/seo-analyzer.db`. Files outside the volume do not persist between deployments. Volumes mount at runtime, so the database is created/migrated on startup. See [Railway volumes](https://docs.railway.com/volumes).
3. Keep **one instance in one region**. The active-audit lock lives in the server process; replicas or a second service sharing the database are unsupported. Volume-backed redeployments have brief downtime. See [Railway volume limitations](https://docs.railway.com/volumes/reference).
4. Generate a public domain and set `APP_ORIGIN` to its exact HTTPS origin, for example `https://your-service.up.railway.app`. The generated `RAILWAY_PUBLIC_DOMAIN` is a fallback; set `APP_ORIGIN` explicitly for a custom domain. Include the scheme and optional port, with no path.
5. Keep `APP_HOST=0.0.0.0` and `CHROME_PATH=/usr/bin/chromium` (Docker defaults). The start script respects Railway's provided `PORT`; leave the networking target port on automatic detection or match that value. In service settings, configure **Healthcheck Path `/api/health`**, **Healthcheck Timeout `120` seconds**, **Restart Policy `On Failure`** and **Maximum Restart Attempts `5`**. The probe checks application/database readiness; it does not start an audit or launch Chrome. Railway probes that port with Host `healthcheck.railway.app`. See [Railway healthchecks](https://docs.railway.com/deployments/healthchecks).

```dotenv
DATABASE_PATH=/data/seo-analyzer.db
APP_HOST=0.0.0.0
APP_ORIGIN=https://your-service.up.railway.app
CHROME_PATH=/usr/bin/chromium
LIGHTHOUSE_TIMEOUT_MS=120000
```

Use a single long-running deployment: keep replicas at **1** and disable Railway Serverless/App Sleeping for this service so background audits stay running after the initial request returns. Do not configure a pre-deploy database migration; the persistent volume is available to the running container. The image currently uses its default root UID so SQLite can write to a newly attached volume; changing the container user also requires matching volume permissions.

To check the image locally when Docker is available:

```powershell
docker build -t site-inspector .
docker volume create site-inspector-data
docker run --rm --name site-inspector -p 127.0.0.1:3000:3000 --mount source=site-inspector-data,target=/data -e PORT=3000 -e APP_ORIGIN=http://127.0.0.1:3000 site-inspector
```

Then open <http://127.0.0.1:3000/api/health> and run an audit from the home page. The named volume keeps the database after the container exits. Docker `EXPOSE 3000` documents the local default; it does not override Railway's runtime `PORT`.

Authentication is intentionally absent. Anyone who can reach the allowed application origin can view saved reports and request audits. Use the hosted instance with only a few trusted testers. Same-origin JSON validation protects the write boundary; it is not sign-in. There are no accounts, billing or SaaS features.

Budget memory for Next.js, the crawler and the temporary Chromium process together; 2 GB is a reasonable starting point to test with larger homepages. The image runs Chromium with `--no-sandbox` as part of its container configuration. The browser still uses the public-address network proxy and a fresh temporary profile for each run.

## Database and backups

The local default stays at `data/audits.sqlite`, preserving existing history. `DATABASE_PATH` overrides it; `AUDIT_DB_PATH` remains a compatibility fallback. Restart after changing the path. Tables are `sites`, `audits`, `pages`, `issues` and `crawl_relationships`, with foreign keys and WAL. A backward-compatible migration adds Lighthouse storage. Final snapshots and the pre-Lighthouse SEO checkpoint are transactional.

Known legacy application diagnostics are presented in English on read using templates and current issue definitions. Stored snapshots and fetched titles, descriptions, headings, link text, alt text and other website content are preserved.

Create a consistent SQLite snapshot, including committed changes in WAL, with the supplied backup script:

```powershell
node scripts/backup.mjs ./data/audits.sqlite ./backups/audits-2026-10-03.sqlite
```

The destination must be new. The script uses Node's SQLite Online Backup API and also works with `/data/seo-analyzer.db` inside the container. Copy the completed backup off the volume and verify a separate restore. See [SQLite's backup API](https://www.sqlite.org/backup.html). Railway also provides [volume backups](https://docs.railway.com/volumes/backups).

To restore, stop the application and all database writers. Preserve the current database and any `-wal`/`-shm` files together, then place the completed backup in a clean destination directory. Do not leave old sidecars beside the restored file. Restart using that path. Never copy only the live main SQLite file while writes are in progress.

## Architecture and checks

```text
src/
  crawler/       URL, SSRF, protected HTTP and bounded crawl
  parsers/       HTML, robots.txt and sitemap XML without network effects
  analyzers/     Independent rules by topic
  issues/        Stable catalog and consolidated evidence
  database/      SQLite, migration and restart recovery
  lighthouse/    Isolated homepage runner and public-only browser proxy
  services/      Audit coordination, Lighthouse and API boundaries
  shared/        Contracts and legacy diagnostic presentation
  app/           App Router and small HTTP routes
  components/    Home, report, page inspector and UI states
scripts/         Production startup, Lighthouse worker and SQLite backup
tests/           Parser, crawler, issues, API, Lighthouse and database tests
```

POST validates and reserves an audit before DNS resolution. Next's `after()` runs the service after sending the response. Only one audit runs at a time; the UI polls every 1.5 seconds. Rules live outside React/routes. To add one, define its stable ID in `src/issues/catalog.ts`, implement a pure `Analyzer`, register it in `src/analyzers/index.ts`, and add a behavior test.

```powershell
npm run typecheck
npm test
npm run build
```

Tests inject transport fixtures without requesting private networks. Production uses real protected HTTP and Lighthouse. Coverage includes URL/scope, metadata, robots, headings, canonical, sitemap/gzip, broken links, issue generation, SSRF/DNS pinning, redirects, timeouts, response caps, legacy history and transactional SQLite/Lighthouse storage. `package-lock.json` fixes dependency versions.

GitHub Actions also builds the actual Linux Docker image on pushes to `main` and manual runs. The deployment smoke check uses a fresh test volume, audits `https://example.com/` with Debian Chromium, requires Lighthouse scores and metrics, then restarts the container and verifies the saved SQLite report. It cleans up its test container and volume; it does not deploy to Railway. To run the same check locally with a Linux Docker engine and port 3000 available:

```powershell
docker build -t site-inspector-smoke:ci .
node scripts/smoke-deployment.mjs site-inspector-smoke:ci
```

`.gitignore` excludes environment files, SQLite files and sidecars, local reports/screenshots, backups, credentials, dependencies and generated output. Only the placeholder `.env.example` is committed. `.dockerignore` also keeps these local files out of the image build context.
