# Silicon Society

A public dashboard tracking **AI that simulates people**: generative agents, LLM social simulation, synthetic respondents, human digital twins, and swarm prediction engines. It covers the research, funding, launches, public posts, open-source code and events in the field.

A scheduled job crawls public sources **every 12 hours**, filters them for topical relevance, and rebuilds a static site. Every item on the site links to the public page it came from.

## How it's built

```
config/      what to track: topics & keywords, watchlist (people, orgs, repos), hand-verified deals & events
pipeline/    the crawler (TypeScript, runs with `npm run crawl`)
  sources/   one adapter per source
  lib/       relevance scoring, deal detection, optional LLM gate, Google News link resolver
data/        crawler output, committed to git so the site and its history are reproducible
src/         the Astro site (static HTML, no backend)
.github/workflows/update.yml   cron: crawl → commit data → build → deploy to GitHub Pages
```

### Sources

| Source | What it gives | Needs |
|---|---|---|
| arXiv API | new papers (8 targeted queries) | — |
| Hugging Face Daily Papers | community-trending papers | — |
| Google News RSS | press coverage; links are resolved to the publisher's own URL | — |
| GDELT | global news index with direct publisher URLs | — (rate-limited on shared IPs) |
| Hacker News (Algolia) | discussion threads | — |
| Reddit (field subreddits) | discussion threads | — (often rate-limited) |
| GitHub | tracked repo stars & releases, new repos gaining traction | `GITHUB_TOKEN` (automatic in Actions) |
| Bluesky | posts from tracked accounts | — |
| Bluesky search | keyword search across all of Bluesky | `BSKY_HANDLE` + `BSKY_APP_PASSWORD` (free app password) |
| X / Twitter | tracked accounts + keyword search | `X_BEARER_TOKEN` (paid X API) |
| Official blogs | RSS or a page watcher for company/lab blogs | — |
| CoMSES Net, WikiCFP | community event calendars & calls for papers | — |

LinkedIn isn't crawled. It has no public API for posts, and scraping it violates its terms, so LinkedIn posts only show up when the press covers them.

### Relevance

Every candidate goes through a gate before it's published:

- **Rules (always on).** Tiered keyword patterns in `config/topics.json`: strong field terms, looser terms that need social-science context, and negative terms for engineering/robotics/industrial "digital twins". Mentioning a tracked person isn't enough on its own; the text itself has to be about the field.
- **LLM editor (optional, recommended).** Set `ANTHROPIC_API_KEY` and each candidate the rules find plausible goes to Claude, which decides relevance, assigns a section, writes a one-line summary from the source text only (labelled "AI summary" on the site), and extracts deal/event fields that are explicitly stated. Model: `CLAUDE_MODEL`, default `claude-opus-5-5`. Rejections are cached, so each item is judged once. `LLM_MAX_ITEMS` caps items per run (default 400).

### Authenticity rules

- Nothing is generated as content. Every item is a real public page, linked.
- Dates come from the publisher. If a page has no date, the site shows when the item was first seen and labels it.
- Deals and events are marked **Verified** (hand-checked, in `config/curated.json`) or **Auto-detected** (extracted from headlines). Rumours ("in talks to acquire…") are not counted as deals.
- Syndicated coverage of one story is collapsed under a single lead item ("+14 more reports").
- The Method page shows live source health from the last crawl.

## Run locally

```bash
npm install
GH_TOKEN=$(gh auth token) npm run crawl     # first run backfills ~120 days
npm run dev                                 # http://localhost:4321
```

Handy flags: `SKIP_SOURCES="Reddit,GDELT"` for quick runs, `BACKFILL=1` to re-scan the last 120 days, `DISABLE_LLM=1`.

## Deploy (GitHub Pages)

1. Push this folder to a GitHub repository.
2. **Settings → Pages → Source: GitHub Actions.**
3. Optional: add repository secrets `ANTHROPIC_API_KEY`, `BSKY_HANDLE`, `BSKY_APP_PASSWORD`, `X_BEARER_TOKEN`.
4. **Actions → Crawl & deploy → Run workflow.** After that it runs at 00:17 and 12:17 UTC.

For a custom domain, set the repository variables `SITE_URL` (e.g. `https://siliconsociety.ai`) and `BASE_PATH` (`/`), then add the domain under Pages settings. Set `repoUrl` in `config/site.json` so the "Corrections" links point at your issue tracker.

Notes: GitHub may start scheduled runs a few minutes late. Each run commits its data, which keeps the repository active, so the schedule isn't paused for inactivity.

## Editing what's tracked

- **Add a person or company:** `config/watchlist.json`. Only add social handles you have verified.
- **Add a verified deal or event:** `config/curated.json`. Every entry needs a `source` URL.
- **Tune relevance:** `config/topics.json` (`strong`, `medium`, `context`, `negative`, plus the arXiv, news and GitHub queries).
