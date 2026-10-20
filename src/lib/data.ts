import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Category, Item, RepoSnapshot, SourceReport } from "../../pipeline/types.ts";

const root = process.cwd();
const read = <T>(file: string, fallback: T): T => {
  const p = join(root, file);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as T) : fallback;
};

export type { Category, Item, RepoSnapshot };

export interface Deal {
  company: string;
  org?: string;
  round: string | null;
  amountUsd: number | null;
  amountText: string | null;
  valuationText?: string;
  lead: string[];
  participants: string[];
  date: string;
  datePrecision: "day" | "month";
  source: { name: string; url: string };
  extraSources?: { name: string; url: string }[];
  headline?: string;
  note?: string;
  verified: boolean;
  coverage: { title: string; url: string; source: string }[];
}

export interface EventEntry {
  name: string;
  kind: string;
  start: string;
  end: string;
  datePrecision?: "day" | "month";
  location: string | null;
  format?: string;
  url: string;
  description: string;
  deadlines?: { label: string; date: string }[];
  source: { name: string; url: string };
  verified: boolean;
  upcoming: boolean;
  tags?: string[];
}

export interface Meta {
  lastRunAt?: string;
  nextRunAt?: string;
  durationMs?: number;
  mode?: string;
  relevanceGate?: "llm" | "rules";
  llm?: { model: string; requests: number } | null;
  counts?: { total: number; added: number; candidates: number; rejectedThisRun: number; totalByCategory: Record<string, number> };
  sources?: SourceReport[];
}

export interface Person {
  id: string;
  name: string;
  affiliation: string;
  group: "academia" | "industry" | "founder" | "investor";
  focus: string;
  links: { homepage?: string; bluesky?: string; x?: string; github?: string };
  orgs?: string[];
}
export interface Org {
  id: string;
  name: string;
  kind: "company" | "lab" | "investor";
  url: string;
  description: string;
  links?: { bluesky?: string; x?: string; github?: string };
  blog?: { url: string };
}

export const items = read<Item[]>("data/items.json", []);
export const deals = read<Deal[]>("data/deals.json", []);
export const events = read<EventEntry[]>("data/events.json", []);
export const repos = read<RepoSnapshot[]>("data/repos.json", []);
export const meta = read<Meta>("data/meta.json", {});
export const watchlist = read<{ people: Person[]; orgs: Org[]; repos: { repo: string; label: string }[] }>(
  "config/watchlist.json",
  { people: [], orgs: [], repos: [] },
);
export const site = read<{ name: string; tagline: string; scope: string; crawlIntervalHours: number; repoUrl: string; contactUrl: string }>(
  "config/site.json",
  { name: "Silicon Society", tagline: "", scope: "", crawlIntervalHours: 12, repoUrl: "", contactUrl: "" },
);

export const peopleById = new Map(watchlist.people.map((p) => [p.id, p]));
export const orgsById = new Map(watchlist.orgs.map((o) => [o.id, o]));

export const CATEGORIES: { id: Category; label: string; plural: string }[] = [
  { id: "research", label: "Research", plural: "Papers" },
  { id: "voices", label: "Voices", plural: "Posts" },
  { id: "news", label: "News", plural: "Stories" },
  { id: "discussion", label: "Discussion", plural: "Threads" },
  { id: "code", label: "Code", plural: "Releases & repos" },
  { id: "funding", label: "Capital", plural: "Deals" },
  { id: "events", label: "Events", plural: "Events" },
];
export const categoryLabel = (c: Category) => CATEGORIES.find((x) => x.id === c)?.label ?? c;

const now = () => new Date(meta.lastRunAt ?? Date.now());
export const withinDays = (iso: string, days: number) => now().getTime() - new Date(iso).getTime() <= days * 86_400_000;

/** Count of distinct sources that ran successfully on the last crawl. */
export const activeSources = (meta.sources ?? []).filter((s) => s.ok && !s.skipped).length;

/** Items mentioning a watchlist person/org, newest first. */
export const itemsFor = (kind: "people" | "orgs", id: string) => items.filter((i) => i[kind].includes(id));

export function weeklyCounts(weeks = 12) {
  const end = now();
  // Weeks start on Monday (UTC).
  const day = (end.getUTCDay() + 6) % 7;
  const thisMonday = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate() - day);
  const buckets = Array.from({ length: weeks }, (_, i) => {
    const start = thisMonday - (weeks - 1 - i) * 7 * 86_400_000;
    return { start: new Date(start).toISOString().slice(0, 10), total: 0, byCat: {} as Record<string, number> };
  });
  const first = new Date(buckets[0].start).getTime();
  for (const it of items) {
    if (it.category === "events") continue; // event listings are dated by their own calendar
    const t = new Date(it.publishedAt).getTime();
    if (t < first || t > end.getTime()) continue;
    const idx = Math.min(weeks - 1, Math.floor((t - first) / (7 * 86_400_000)));
    buckets[idx].total++;
    buckets[idx].byCat[it.category] = (buckets[idx].byCat[it.category] ?? 0) + 1;
  }
  return buckets;
}

// ---------------------------------------------------------------------------
// Story clustering: syndicated coverage of one event collapses under a lead item.

export interface Cluster {
  lead: Item;
  related: Item[];
}

const STOP = new Set(
  "the and for with from into that this what will how why are its new now has have after amid over about says said report reports announces launch launches its their our you your more than just".split(" "),
);
const tokens = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !STOP.has(w)),
  );
const jaccard = (a: Set<string>, b: Set<string>) => {
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter || 1);
};
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const dealKey = (i: Item) => (i.deal ? `${norm(i.deal.company)}|${i.deal.round === "Acquisition" ? "acq" : norm(i.deal.round ?? "")}` : null);
const clusterable = (i: Item) => i.category === "news" || i.category === "funding";
const DAY = 86_400_000;

export function clusterItems(list: Item[]): Cluster[] {
  const clusters: (Cluster & { last: number; toks: Set<string>[] })[] = [];
  const asc = [...list].sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));
  for (const it of asc) {
    const time = Date.parse(it.publishedAt);
    const toks = tokens(it.title);
    const home = clusterable(it)
      ? clusters.find((c) => {
          if (!clusterable(c.lead) || time - c.last > 21 * DAY) return false;
          const members = [c.lead, ...c.related];
          const k = dealKey(it);
          if (k && members.some((m) => dealKey(m) === k)) return true;
          const lt = it.title.toLowerCase();
          // Names both sides of a deal already in the cluster ("…Salesforce… Listen Labs…").
          if (members.some((m) => m.deal && lt.includes(m.deal.company.toLowerCase()) && m.deal.lead.some((l) => lt.includes(l.toLowerCase())))) return true;
          return time - c.last <= 4 * DAY && c.toks.some((t) => jaccard(t, toks) >= 0.5);
        })
      : undefined;
    if (home) {
      home.related.push(it);
      home.toks.push(toks);
      home.last = Math.max(home.last, time);
    } else {
      clusters.push({ lead: it, related: [], last: time, toks: [toks] });
    }
  }
  return clusters
    .map(({ lead, related }) => {
      // Lead with the most informative report: one with a disclosed amount, then any with deal details.
      const all = [lead, ...related];
      const best = all.find((i) => i.deal?.amountUsd) ?? all.find((i) => i.deal) ?? lead;
      return { lead: best, related: all.filter((i) => i !== best).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)) };
    })
    .sort((a, b) => b.lead.publishedAt.localeCompare(a.lead.publishedAt));
}
