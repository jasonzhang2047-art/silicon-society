import rss from "@astrojs/rss";
import type { APIContext } from "astro";
import { categoryLabel, items, site } from "../lib/data";

export function GET(context: APIContext) {
  const latest = items
    .filter((i) => i.source.kind !== "wikicfp" && i.source.kind !== "comses")
    .slice(0, 150);
  return rss({
    title: site.name,
    description: site.tagline,
    site: new URL(import.meta.env.BASE_URL, context.site ?? "https://example.com").toString(),
    items: latest.map((i) => ({
      title: i.title,
      link: i.url,
      pubDate: new Date(i.publishedAt),
      description: [i.aiSummary ? `AI summary: ${i.aiSummary}` : i.snippet, `Source: ${i.source.name}`].filter(Boolean).join(" — "),
      categories: [categoryLabel(i.category)],
    })),
  });
}
