export type Category =
  | "research"
  | "funding"
  | "news"
  | "voices"
  | "code"
  | "events"
  | "discussion";

export type SourceKind =
  | "arxiv"
  | "huggingface"
  | "news"
  | "gdelt"
  | "hackernews"
  | "reddit"
  | "github"
  | "bluesky"
  | "x"
  | "blog"
  | "comses"
  | "wikicfp"
  | "curated";

export interface DealInfo {
  company: string;
  round: string | null;
  amountText: string | null;
  amountUsd: number | null;
  lead: string[];
  participants: string[];
  /** true when extracted by rules/LLM from a news item rather than hand-verified */
  auto: boolean;
}

export interface EventInfo {
  name: string;
  start: string | null;
  end: string | null;
  location: string | null;
  url: string | null;
}

export interface Item {
  id: string;
  url: string;
  title: string;
  /** Text taken verbatim (cleaned/truncated) from the source. */
  snippet?: string;
  /** Machine-written one-line summary; always labelled as such in the UI. */
  aiSummary?: string;
  category: Category;
  source: { kind: SourceKind; name: string; url?: string };
  author?: { name: string; handle?: string; url?: string; avatar?: string };
  authors?: string[];
  /** Secondary link, e.g. the article a Hacker News thread points to. */
  link?: string;
  publishedAt: string;
  firstSeenAt: string;
  people: string[];
  orgs: string[];
  tags: string[];
  score: number;
  verdict: { by: "rules" | "llm" | "trusted"; reason?: string };
  metrics?: Partial<Record<"points" | "comments" | "stars" | "upvotes" | "likes" | "reposts" | "replies", number>>;
  deal?: DealInfo;
  event?: EventInfo;
}

/** What a source emits before relevance filtering and merging. */
export interface Candidate {
  url: string;
  title: string;
  snippet?: string;
  category: Category;
  source: Item["source"];
  author?: Item["author"];
  authors?: string[];
  link?: string;
  publishedAt: string;
  tags?: string[];
  metrics?: Item["metrics"];
  event?: EventInfo;
  /** Watchlist people/org ids this candidate is known to come from (e.g. a tracked account). */
  people?: string[];
  orgs?: string[];
  /** Skip the relevance gate: tracked repo releases, curated feeds, etc. */
  trusted?: boolean;
  /** Extra score for candidates from tracked accounts or official channels. */
  boost?: number;
}

export interface SourceReport {
  name: string;
  ok: boolean;
  fetched: number;
  error?: string;
  ms: number;
  skipped?: string;
}

export interface Source {
  name: string;
  /** Returns a reason string when the source can't run (e.g. missing key). */
  disabled?: () => string | undefined;
  run: (ctx: RunContext) => Promise<Candidate[]>;
}

export interface RunContext {
  now: Date;
  /** Look-back window start for this run. */
  since: Date;
  firstRun: boolean;
  state: PipelineState;
  knownUrls: Set<string>;
  log: (msg: string) => void;
}

export interface RepoSnapshot {
  repo: string;
  label: string;
  org?: string;
  description: string;
  url: string;
  stars: number;
  forks: number;
  openIssues: number;
  pushedAt: string;
  language: string | null;
  latestRelease?: { tag: string; name: string; url: string; publishedAt: string };
  history: { date: string; stars: number }[];
}

export interface PipelineState {
  pagewatch: Record<string, string[]>;
  rejected: Record<string, { at: string; by: "rules" | "llm"; title: string }>;
  repos: Record<string, RepoSnapshot>;
}
