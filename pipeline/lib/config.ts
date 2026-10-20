import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = <T>(file: string): T => JSON.parse(readFileSync(join(root, file), "utf8")) as T;

export interface Person {
  id: string;
  name: string;
  affiliation: string;
  group: "academia" | "industry" | "founder" | "investor";
  focus: string;
  links: { homepage?: string; bluesky?: string; x?: string; github?: string; scholar?: string };
  orgs?: string[];
  match?: string;
}

export interface Org {
  id: string;
  name: string;
  kind: "company" | "lab" | "investor";
  url: string;
  description: string;
  match?: string;
  links?: { bluesky?: string; x?: string; github?: string };
  blog?: { type: "rss" | "pagewatch"; url: string; linkPattern?: string; filter?: boolean };
}

export interface Watchlist {
  people: Person[];
  orgs: Org[];
  repos: { repo: string; org?: string; label: string }[];
  feeds: { name: string; type: string; url?: string; trusted?: boolean }[];
}

export interface Topics {
  strong: string[];
  medium: string[];
  context: string[];
  ai: string[];
  negative: string[];
  arxivQueries: string[];
  newsQueries: string[];
  discussionQueries: string[];
  githubDiscovery: string[];
}

export interface CuratedDeal {
  company: string;
  org?: string;
  round: string;
  amountUsd: number | null;
  amountText: string;
  valuationText?: string;
  lead: string[];
  participants: string[];
  date: string;
  datePrecision: "day" | "month";
  source: { name: string; url: string };
  extraSources?: { name: string; url: string }[];
  note?: string;
}

export interface CuratedEvent {
  name: string;
  kind: string;
  start: string;
  end: string;
  datePrecision?: "day" | "month";
  location: string;
  format: string;
  url: string;
  description: string;
  deadlines?: { label: string; date: string }[];
  source: { name: string; url: string };
}

export const watchlist = read<Watchlist>("config/watchlist.json");
export const topics = read<Topics>("config/topics.json");
export const curated = read<{ deals: CuratedDeal[]; events: CuratedEvent[] }>("config/curated.json");
export const site = read<{ name: string; tagline: string; scope: string; crawlIntervalHours: number }>(
  "config/site.json",
);
