import { XMLParser } from "fast-xml-parser";
import { asArray, cleanText, toIso } from "./util.ts";

export interface FeedEntry {
  title: string;
  link: string;
  summary: string;
  published: string | null;
  authors: string[];
  sourceName?: string;
  sourceUrl?: string;
  categories: string[];
  raw: Record<string, unknown>;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  processEntities: true,
  htmlEntities: true,
});

const text = (v: unknown): string => {
  if (v == null) return "";
  if (typeof v === "string" || typeof v === "number") return String(v);
  if (typeof v === "object" && "#text" in (v as object)) return String((v as Record<string, unknown>)["#text"]);
  return "";
};

/** Parses RSS 2.0 and Atom feeds into a common shape. */
export function parseFeed(xml: string): FeedEntry[] {
  const doc = parser.parse(xml);
  if (doc.rss?.channel) {
    return asArray(doc.rss.channel.item).map((it: Record<string, unknown>) => {
      const src = it.source as Record<string, unknown> | string | undefined;
      return {
        title: cleanText(text(it.title), 400),
        link: text(it.link) || text(it.guid),
        summary: text(it["content:encoded"]) || text(it.description),
        published: toIso(text(it.pubDate) || text(it["dc:date"])),
        authors: asArray(it["dc:creator"] ?? it.author).map((a) => cleanText(text(a), 120)).filter(Boolean),
        sourceName: typeof src === "object" ? cleanText(text(src), 120) : src ? String(src) : undefined,
        sourceUrl: typeof src === "object" ? (src["@_url"] as string | undefined) : undefined,
        categories: asArray(it.category).map((c) => text(c)).filter(Boolean),
        raw: it,
      };
    });
  }
  if (doc.feed) {
    return asArray(doc.feed.entry).map((e: Record<string, unknown>) => {
      const links = asArray(e.link as Record<string, string> | Record<string, string>[]);
      const alt = links.find((l) => !l["@_rel"] || l["@_rel"] === "alternate") ?? links[0];
      return {
        title: cleanText(text(e.title), 400),
        link: alt?.["@_href"] ?? text(e.id),
        summary: text(e.summary) || text(e.content),
        published: toIso(text(e.published) || text(e.updated)),
        authors: asArray(e.author as Record<string, unknown>[]).map((a) => cleanText(text(a?.name), 120)).filter(Boolean),
        categories: asArray(e.category as Record<string, string>[]).map((c) => c?.["@_term"] ?? "").filter(Boolean),
        raw: e,
      };
    });
  }
  return [];
}
