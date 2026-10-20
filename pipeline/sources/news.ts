import { fetchJson, fetchText } from "../lib/http.ts";
import { parseFeed } from "../lib/feed.ts";
import { topics } from "../lib/config.ts";
import { cleanText, lookbackDays, toIso } from "../lib/util.ts";
import type { Candidate, Source } from "../types.ts";

/** Google News search RSS — broad press coverage, links resolve to the publisher. */
export const googleNews: Source = {
  name: "Google News",
  async run(ctx) {
    const out: Candidate[] = [];
    const window = `${lookbackDays(ctx.since, ctx.now)}d`;
    for (const q of topics.newsQueries) {
      const url =
        "https://news.google.com/rss/search?q=" +
        encodeURIComponent(`${q} when:${window}`) +
        "&hl=en-US&gl=US&ceid=US:en";
      const xml = await fetchText(url);
      for (const e of parseFeed(xml)) {
        if (!e.published || new Date(e.published) < ctx.since) continue;
        const publisher = e.sourceName ?? "News";
        // Google appends " - Publisher" to every headline.
        const title = e.title.endsWith(` - ${publisher}`) ? e.title.slice(0, -(publisher.length + 3)) : e.title;
        const snippet = cleanText(e.summary, 400);
        out.push({
          url: e.link,
          title,
          // The RSS description just repeats the headline; keep it only when it adds something.
          snippet: snippet && !snippet.startsWith(title.slice(0, 40)) ? snippet : undefined,
          category: "news",
          source: { kind: "news", name: publisher, url: e.sourceUrl },
          publishedAt: e.published,
        });
      }
    }
    return out;
  },
};

interface GdeltResponse {
  articles?: { url: string; title: string; seendate: string; domain: string; language: string }[];
}

/** GDELT DOC API — global news index with direct publisher URLs. */
export const gdelt: Source = {
  name: "GDELT",
  async run(ctx) {
    const out: Candidate[] = [];
    const queries = [
      '("generative agents" OR "synthetic respondents" OR "synthetic users" OR "silicon sampling")',
      '("digital twins" OR "AI personas" OR "synthetic personas") (consumers OR "market research" OR survey)',
      '("social simulation" OR "simulate human behavior" OR "human behavior simulation" OR MiroFish OR "Simile AI")',
    ];
    const timespan = `${Math.min(90, lookbackDays(ctx.since, ctx.now))}d`;
    for (const q of queries) {
      const url =
        "https://api.gdeltproject.org/api/v2/doc/doc?query=" +
        encodeURIComponent(`${q} sourcelang:english`) +
        `&mode=artlist&format=json&maxrecords=100&sort=datedesc&timespan=${timespan}`;
      let res: GdeltResponse;
      try {
        res = await fetchJson<GdeltResponse>(url, { retries: 1 });
      } catch (err) {
        if (q === queries[0]) throw err; // first query failing means the API is unavailable
        ctx.log(`  gdelt: ${(err as Error).message.slice(0, 80)}`);
        continue;
      }
      for (const a of res.articles ?? []) {
        const m = a.seendate.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
        const published = m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : null;
        if (!published || new Date(published) < ctx.since) continue;
        out.push({
          url: a.url,
          title: cleanText(a.title, 300),
          category: "news",
          source: { kind: "gdelt", name: a.domain.replace(/^www\./, ""), url: `https://${a.domain}` },
          publishedAt: toIso(published)!,
        });
      }
    }
    return out;
  },
};
