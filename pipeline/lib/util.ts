import { createHash } from "node:crypto";

export function hashId(input: string): string {
  return createHash("sha1").update(input).digest("hex").slice(0, 12);
}

const TRACKING_PARAMS = /^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$|ref$|ref_src$|s$|share$|oc$)/i;

/** Normalises a URL so the same resource found via different routes dedupes to one item. */
export function canonicalUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return raw.trim();
  }
  u.hash = "";
  if (u.hostname.endsWith("arxiv.org")) {
    const m = u.pathname.match(/\/(?:abs|pdf|html)\/([^/?#]+?)(?:v\d+)?(?:\.pdf)?$/);
    if (m) return `https://arxiv.org/abs/${m[1]}`;
  }
  if (u.hostname === "news.google.com") return u.origin + u.pathname;
  for (const key of [...u.searchParams.keys()]) {
    if (TRACKING_PARAMS.test(key)) u.searchParams.delete(key);
  }
  u.hostname = u.hostname.replace(/^www\./, "");
  let s = u.toString();
  if (s.endsWith("/") && u.pathname !== "/") s = s.slice(0, -1);
  return s.replace(/^http:\/\//, "https://");
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", hellip: "…",
  mdash: "—", ndash: "–", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“",
};

export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z0-9#]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

export function cleanText(s: unknown, max = 600): string {
  if (s == null) return "";
  let t = String(s);
  t = t.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ");
  t = decodeEntities(decodeEntities(t)).replace(/\s+/g, " ").trim();
  if (t.length > max) t = t.slice(0, max).replace(/\s+\S*$/, "") + "…";
  return t;
}

export function toIso(d: unknown): string | null {
  if (!d) return null;
  const date = d instanceof Date ? d : new Date(String(d));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export const daysAgo = (n: number, from = new Date()) => new Date(from.getTime() - n * 86_400_000);

/** Whole days between `since` and `now`, at least `min` — sources size their lookback windows from this. */
export function lookbackDays(since: Date, now: Date, min = 3): number {
  return Math.max(min, Math.ceil((now.getTime() - since.getTime()) / 86_400_000));
}

export function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Key for fuzzy duplicate detection of syndicated headlines. */
export function titleKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/[‘’'"“”]/g, "")
    .replace(/[^a-z0-9一-鿿]+/g, " ")
    .trim()
    .slice(0, 90);
}

export function uniq<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

export function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}
