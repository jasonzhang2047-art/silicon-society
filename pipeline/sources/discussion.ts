import { fetchJson, fetchText } from "../lib/http.ts";
import { parseFeed } from "../lib/feed.ts";
import { topics } from "../lib/config.ts";
import { cleanText, lookbackDays, toIso } from "../lib/util.ts";
import type { Candidate, Source } from "../types.ts";

interface HnHit {
  objectID: string;
  title: string | null;
  url: string | null;
  story_text: string | null;
  author: string;
  points: number | null;
  num_comments: number | null;
  created_at: string;
}

export const hackerNews: Source = {
  name: "Hacker News",
  async run(ctx) {
    const out: Candidate[] = [];
    const since = Math.floor(ctx.since.getTime() / 1000);
    for (const q of topics.discussionQueries) {
      const url =
        "https://hn.algolia.com/api/v1/search_by_date?tags=story&hitsPerPage=50" +
        `&query=${encodeURIComponent(q)}&numericFilters=created_at_i>${since}`;
      const res = await fetchJson<{ hits: HnHit[] }>(url);
      for (const h of res.hits) {
        if (!h.title) continue;
        out.push({
          url: `https://news.ycombinator.com/item?id=${h.objectID}`,
          title: cleanText(h.title, 300),
          snippet: cleanText(h.story_text, 400) || undefined,
          link: h.url ?? undefined,
          category: "discussion",
          source: { kind: "hackernews", name: "Hacker News", url: "https://news.ycombinator.com" },
          author: { name: h.author, url: `https://news.ycombinator.com/user?id=${h.author}` },
          publishedAt: h.created_at,
          metrics: { points: h.points ?? 0, comments: h.num_comments ?? 0 },
        });
      }
    }
    return out;
  },
};

/** Subreddits where this field is actually discussed; site-wide search is mostly noise. */
const SUBREDDITS = [
  "MachineLearning", "LocalLLaMA", "artificial", "singularity", "compsci", "datascience", "agi",
  "ArtificialInteligence", "UXResearch", "Marketresearch", "socialscience", "AskSocialScience",
  "AgentBasedModeling", "ClaudeAI", "OpenAI", "academia", "statistics", "PoliticalScience",
].join("+");

/** Reddit search RSS. Reddit often blocks datacenter IPs, so failures here are expected and non-fatal. */
export const reddit: Source = {
  name: "Reddit",
  async run(ctx) {
    const out: Candidate[] = [];
    const days = lookbackDays(ctx.since, ctx.now);
    const t = days <= 7 ? "week" : days <= 31 ? "month" : "year";
    for (const q of topics.discussionQueries.slice(0, 8)) {
      const url = `https://www.reddit.com/r/${SUBREDDITS}/search.rss?q=${encodeURIComponent(`"${q}"`)}&restrict_sr=on&sort=new&t=${t}&limit=50`;
      let xml: string;
      try {
        xml = await fetchText(url, { retries: 1 });
      } catch (err) {
        if (q === topics.discussionQueries[0]) throw err;
        ctx.log(`  reddit: ${(err as Error).message.slice(0, 80)}`);
        continue;
      }
      for (const e of parseFeed(xml)) {
        if (!e.published || new Date(e.published) < ctx.since) continue;
        const sub = e.categories[0] ?? (e.link.match(/\/r\/([^/]+)/)?.[1] ?? "reddit");
        out.push({
          url: e.link,
          title: e.title,
          snippet: cleanText(e.summary, 400).replace(/submitted by .*$/i, "").trim() || undefined,
          category: "discussion",
          source: { kind: "reddit", name: `r/${sub}`, url: `https://www.reddit.com/r/${sub}` },
          author: e.authors[0] ? { name: e.authors[0].replace(/^\/u\//, "u/") } : undefined,
          publishedAt: toIso(e.published)!,
        });
      }
    }
    return out;
  },
};
