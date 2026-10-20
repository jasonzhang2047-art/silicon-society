import { fetchJson, fetchText } from "../lib/http.ts";
import { parseFeed } from "../lib/feed.ts";
import { topics } from "../lib/config.ts";
import { cleanText, daysAgo, lookbackDays, toIso, ymd } from "../lib/util.ts";
import type { Candidate, Source } from "../types.ts";

export const arxiv: Source = {
  name: "arXiv",
  async run(ctx) {
    const out: Candidate[] = [];
    for (const q of topics.arxivQueries) {
      const url =
        "https://export.arxiv.org/api/query?search_query=" +
        encodeURIComponent(q) +
        `&sortBy=submittedDate&sortOrder=descending&max_results=${ctx.firstRun ? 100 : 50}`;
      const xml = await fetchText(url, { timeoutMs: 40_000 });
      for (const e of parseFeed(xml)) {
        if (!e.published || new Date(e.published) < ctx.since) continue;
        const raw = e.raw as Record<string, unknown>;
        const primary = (raw["arxiv:primary_category"] as Record<string, string> | undefined)?.["@_term"];
        out.push({
          url: e.link,
          title: e.title.replace(/\s+/g, " "),
          snippet: cleanText(e.summary, 700),
          category: "research",
          source: { kind: "arxiv", name: "arXiv", url: "https://arxiv.org" },
          authors: e.authors,
          publishedAt: e.published,
          tags: primary ? [primary] : [],
        });
      }
    }
    return out;
  },
};

interface HfPaper {
  paper: {
    id: string;
    title: string;
    summary: string;
    publishedAt: string;
    upvotes: number;
    authors: { name: string }[];
  };
  publishedAt: string;
  numComments?: number;
}

/** Hugging Face Daily Papers — community-curated trending papers, filtered for relevance. */
export const hfDaily: Source = {
  name: "Hugging Face Daily Papers",
  async run(ctx) {
    const out: Candidate[] = [];
    const days = Math.min(30, lookbackDays(ctx.since, ctx.now));
    for (let i = 0; i < days; i++) {
      const date = ymd(daysAgo(i, ctx.now));
      let papers: HfPaper[] = [];
      try {
        papers = await fetchJson<HfPaper[]>(`https://huggingface.co/api/daily_papers?date=${date}&limit=100`);
      } catch {
        continue; // missing days (weekends) return errors
      }
      for (const p of papers) {
        out.push({
          url: `https://arxiv.org/abs/${p.paper.id}`,
          title: cleanText(p.paper.title, 300),
          snippet: cleanText(p.paper.summary, 700),
          category: "research",
          source: { kind: "huggingface", name: "Hugging Face Papers", url: `https://huggingface.co/papers/${p.paper.id}` },
          authors: p.paper.authors.map((a) => a.name),
          publishedAt: toIso(p.paper.publishedAt) ?? toIso(p.publishedAt) ?? ctx.now.toISOString(),
          tags: ["hf-trending"],
          metrics: { upvotes: p.paper.upvotes, comments: p.numComments },
        });
      }
    }
    return out;
  },
};
