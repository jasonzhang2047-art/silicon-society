import * as cheerio from "cheerio";
import { fetchText } from "../lib/http.ts";
import { parseFeed } from "../lib/feed.ts";
import { watchlist } from "../lib/config.ts";
import { canonicalUrl, cleanText, toIso } from "../lib/util.ts";
import type { Candidate, Source } from "../types.ts";

/** Reads publish date and description from a post page's metadata. */
function readMeta(html: string) {
  const $ = cheerio.load(html);
  const meta = (sel: string) => $(sel).attr("content")?.trim();
  let date =
    meta('meta[property="article:published_time"]') ??
    meta('meta[name="article:published_time"]') ??
    meta('meta[name="publish_date"]') ??
    meta('meta[itemprop="datePublished"]');
  if (!date) {
    $('script[type="application/ld+json"]').each((_, el) => {
      const m = $(el).text().match(/"datePublished"\s*:\s*"([^"]+)"/);
      if (m && !date) date = m[1];
    });
  }
  // A page-wide <time> is often a "related posts" list; only trust one inside the article itself.
  date ??= $("article time[datetime]").first().attr("datetime") ?? $("main header time[datetime]").first().attr("datetime");
  return {
    title: meta('meta[property="og:title"]') ?? cleanText($("title").text(), 200),
    description: meta('meta[property="og:description"]') ?? meta('meta[name="description"]'),
    date: toIso(date),
  };
}

/** "Introducing MaxDiff - Listen Labs | AI-led User Interviews" -> "Introducing MaxDiff" */
function stripSiteSuffix(title: string, orgName: string): string {
  let t = title;
  const at = t.search(new RegExp(`\\s[|–—-]\\s+${orgName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"));
  if (at > 10) t = t.slice(0, at);
  for (let i = 0; i < 3; i++) {
    const m = t.match(/^(.*\S)\s+[|–—-]\s+([^|–—-]{1,40})$/);
    if (!m) break;
    const tail = m[2].trim().toLowerCase();
    const generic = tail.split(/\s+/).length <= 3 && (tail.includes(orgName.toLowerCase()) || /^(ai|blog|news|home)$/.test(tail));
    if (!generic) break;
    t = m[1];
  }
  return t;
}

/** Official blogs of tracked organisations: RSS where available, otherwise a page watcher. */
export const orgBlogs: Source = {
  name: "Official blogs",
  async run(ctx) {
    const out: Candidate[] = [];
    for (const org of watchlist.orgs.filter((o) => o.blog)) {
      const blog = org.blog!;
      try {
        if (blog.type === "rss") {
          for (const e of parseFeed(await fetchText(blog.url))) {
            if (!e.published || new Date(e.published) < ctx.since) continue;
            out.push({
              url: e.link,
              title: e.title,
              snippet: cleanText(e.summary, 500) || undefined,
              category: "voices",
              source: { kind: "blog", name: `${org.name} blog`, url: blog.url },
              author: { name: org.name, url: org.url },
              publishedAt: e.published,
              orgs: [org.id],
              tags: ["official"],
              // Broad corporate blogs (e.g. DeepMind) must pass the topic filter; niche ones are trusted.
              ...(blog.filter ? { boost: 1 } : { trusted: true }),
            });
          }
          continue;
        }

        // Page watcher: diff the blog index against links we've already seen.
        const html = await fetchText(blog.url);
        const $ = cheerio.load(html);
        const pattern = new RegExp(blog.linkPattern ?? "/blog/");
        const links = new Map<string, string>();
        $("a[href]").each((_, a) => {
          const href = $(a).attr("href")!;
          if (!pattern.test(href)) return;
          const abs = canonicalUrl(new URL(href, blog.url).toString());
          const label = cleanText($(a).text(), 200);
          if (!links.has(abs) || (label && label.length > (links.get(abs)?.length ?? 0))) links.set(abs, label);
        });
        const seen = new Set(ctx.state.pagewatch[org.id] ?? []);
        const baseline = !ctx.state.pagewatch[org.id];
        let fetched = 0;
        for (const [url, label] of links) {
          if (seen.has(url) || ctx.knownUrls.has(url)) continue;
          if (fetched >= 12) break;
          fetched++;
          const meta = readMeta(await fetchText(url).catch(() => ""));
          // On the very first visit we only keep posts whose date we can prove.
          if (baseline && !meta.date) {
            seen.add(url);
            continue;
          }
          seen.add(url);
          if (meta.date && new Date(meta.date) < ctx.since) continue;
          out.push({
            url,
            title: stripSiteSuffix(cleanText(meta.title || label, 300), org.name) || label,
            snippet: meta.description ? cleanText(meta.description, 400) : undefined,
            category: "voices",
            source: { kind: "blog", name: `${org.name} blog`, url: blog.url },
            author: { name: org.name, url: org.url },
            publishedAt: meta.date ?? ctx.now.toISOString(),
            orgs: [org.id],
            tags: ["official", ...(meta.date ? [] : ["date-approx"])],
            ...(blog.filter ? { boost: 1 } : { trusted: true }),
          });
        }
        for (const url of links.keys()) seen.add(url);
        ctx.state.pagewatch[org.id] = [...seen].slice(-500);
      } catch (err) {
        ctx.log(`  blog ${org.name}: ${(err as Error).message.slice(0, 120)}`);
      }
    }
    return out;
  },
};
