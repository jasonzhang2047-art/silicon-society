import { curated, site, watchlist } from "./lib/config.ts";
import { readData, writeData } from "./lib/store.ts";
import { canonicalUrl, daysAgo, hashId, titleKey, uniq } from "./lib/util.ts";
import { detectDeal, KEEP_THRESHOLD, LLM_THRESHOLD, scoreCandidate } from "./lib/relevance.ts";
import { classify, llmEnabled, llmUsage, type LlmVerdict } from "./lib/llm.ts";
import { isGoogleNews, RateLimited, resolveGoogleNews } from "./lib/gnews.ts";
import { arxiv, hfDaily } from "./sources/research.ts";
import { gdelt, googleNews } from "./sources/news.ts";
import { hackerNews, reddit } from "./sources/discussion.ts";
import { githubDiscovery, githubRepos } from "./sources/github.ts";
import { blueskyAccounts, blueskySearch, xPosts } from "./sources/social.ts";
import { orgBlogs } from "./sources/blogs.ts";
import { comses, wikicfp } from "./sources/events.ts";
import type { Candidate, DealInfo, Item, PipelineState, RunContext, Source, SourceReport } from "./types.ts";

const SOURCES: Source[] = [
  arxiv, hfDaily, googleNews, gdelt, hackerNews, reddit, githubRepos, githubDiscovery,
  blueskyAccounts, blueskySearch, xPosts, orgBlogs, comses, wikicfp,
];
const SOURCE_TIMEOUT_MS = 8 * 60_000;
const RETENTION_DAYS = 400;

const log = (msg: string) => console.log(msg);

interface Meta {
  lastRunAt?: string;
  [k: string]: unknown;
}

async function runSource(s: Source, ctx: RunContext): Promise<{ report: SourceReport; candidates: Candidate[] }> {
  const t0 = Date.now();
  const reason = s.disabled?.();
  if (reason) return { report: { name: s.name, ok: true, fetched: 0, ms: 0, skipped: reason }, candidates: [] };
  let timer: NodeJS.Timeout | undefined;
  try {
    const candidates = await Promise.race([
      s.run(ctx),
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error("timed out")), SOURCE_TIMEOUT_MS);
      }),
    ]);
    log(`✓ ${s.name}: ${candidates.length} candidates (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    return { report: { name: s.name, ok: true, fetched: candidates.length, ms: Date.now() - t0 }, candidates };
  } catch (err) {
    const error = (err as Error).message.slice(0, 200);
    log(`✗ ${s.name}: ${error}`);
    return { report: { name: s.name, ok: false, fetched: 0, ms: Date.now() - t0, error }, candidates: [] };
  } finally {
    clearTimeout(timer); // a pending timer would keep the process alive for minutes
  }
}

/** Merge candidates that point at the same resource (e.g. an arXiv paper also trending on HF). */
function dedupeCandidates(cands: Candidate[]): Map<string, Candidate> {
  const byId = new Map<string, Candidate>();
  for (const c of cands) {
    c.url = canonicalUrl(c.url);
    const id = hashId(c.url);
    const prev = byId.get(id);
    if (!prev) {
      byId.set(id, c);
      continue;
    }
    prev.tags = uniq([...(prev.tags ?? []), ...(c.tags ?? [])]);
    prev.metrics = { ...prev.metrics, ...c.metrics };
    prev.people = uniq([...(prev.people ?? []), ...(c.people ?? [])]);
    prev.orgs = uniq([...(prev.orgs ?? []), ...(c.orgs ?? [])]);
    if ((c.snippet?.length ?? 0) > (prev.snippet?.length ?? 0)) prev.snippet = c.snippet;
    if (prev.source.kind === "huggingface" && c.source.kind === "arxiv") prev.source = c.source;
    prev.trusted ||= c.trusted;
    prev.boost = Math.max(prev.boost ?? 0, c.boost ?? 0);
  }
  return byId;
}

function buildItem(id: string, c: Candidate, now: string, extra: Partial<Item>): Item {
  return {
    id,
    url: c.url,
    title: c.title,
    snippet: c.snippet,
    category: c.category,
    source: c.source,
    author: c.author,
    authors: c.authors?.slice(0, 30),
    link: c.link,
    publishedAt: c.publishedAt,
    firstSeenAt: now,
    people: c.people ?? [],
    orgs: c.orgs ?? [],
    tags: c.tags ?? [],
    score: 0,
    verdict: { by: "rules" },
    metrics: c.metrics,
    event: c.event,
    ...extra,
  };
}

function applyDeal(item: Item, llmDeal: LlmVerdict["deal"] | undefined) {
  if (item.category !== "news" && item.category !== "funding") return;
  const deal: DealInfo | null = llmDeal ? { ...llmDeal, auto: true } : detectDeal(item.title, item.snippet);
  if (deal) {
    item.deal = deal;
    item.category = "funding";
  }
}

// ---------------------------------------------------------------------------
// Derived datasets

function sameCompany(a: string, b: string) {
  const n = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  return n(a) === n(b) || n(a).startsWith(n(b)) || n(b).startsWith(n(a));
}

function buildDeals(items: Item[]) {
  const deals: Record<string, unknown>[] = curated.deals.map((d) => ({ ...d, verified: true, coverage: [] as { title: string; url: string; source: string }[] }));
  const auto: Record<string, unknown>[] = [];
  // Oldest first, so a deal is dated by its first report and later coverage fills gaps.
  for (const it of items.filter((i) => i.deal).sort((a, b) => a.publishedAt.localeCompare(b.publishedAt))) {
    const d = it.deal!;
    const when = new Date(it.publishedAt).getTime();
    const match = deals.find(
      (cd) => sameCompany(String(cd.company), d.company) && Math.abs(new Date(String(cd.date)).getTime() - when) < 45 * 86_400_000,
    );
    if (match) {
      (match.coverage as unknown[]).push({ title: it.title, url: it.url, source: it.source.name });
      continue;
    }
    const dup = auto.find((a) => sameCompany(String(a.company), d.company) && (a.round === d.round || !d.round || !a.round));
    if (dup) {
      (dup.coverage as unknown[]).push({ title: it.title, url: it.url, source: it.source.name });
      if (dup.amountUsd == null && d.amountUsd != null) {
        dup.amountUsd = d.amountUsd;
        dup.amountText = d.amountText;
      }
      if (!(dup.lead as string[]).length && d.lead.length) dup.lead = d.lead;
      continue;
    }
    auto.push({
      company: d.company,
      org: it.orgs[0],
      round: d.round,
      amountUsd: d.amountUsd,
      amountText: d.amountText,
      lead: d.lead,
      participants: d.participants,
      date: it.publishedAt.slice(0, 10),
      datePrecision: "day",
      source: { name: it.source.name, url: it.url },
      headline: it.title,
      verified: false,
      coverage: [],
    });
  }
  return [...deals, ...auto].sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

function buildEvents(items: Item[], today: string) {
  const events: Record<string, unknown>[] = curated.events.map((e) => ({ ...e, verified: true }));
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 40);
  for (const it of items.filter((i) => i.event?.start)) {
    const e = it.event!;
    if (events.some((x) => norm(String(x.name)) === norm(e.name))) continue;
    events.push({
      name: e.name,
      kind: it.tags.includes("cfp") ? "call for papers" : "event",
      start: e.start,
      end: e.end ?? e.start,
      location: e.location,
      url: e.url ?? it.url,
      description: it.snippet ?? "",
      source: { name: it.source.name, url: it.url },
      verified: false,
      tags: it.tags,
    });
  }
  return events
    .filter((e) => String(e.end ?? e.start) >= String(daysAgo(120).toISOString().slice(0, 10)))
    .sort((a, b) => String(a.start).localeCompare(String(b.start)))
    .map((e) => ({ ...e, upcoming: String(e.end ?? e.start) >= today }));
}

// ---------------------------------------------------------------------------

async function main() {
  const started = Date.now();
  const now = new Date();
  const nowIso = now.toISOString();
  const meta = readData<Meta>("meta.json", {});
  const existing = readData<Item[]>("items.json", []);
  const state = readData<PipelineState>("state.json", { pagewatch: {}, rejected: {}, repos: {} });
  const firstRun = !meta.lastRunAt || process.env.BACKFILL === "1";
  const since = firstRun
    ? daysAgo(Number(process.env.BACKFILL_DAYS ?? 120), now)
    : new Date(Math.min(new Date(meta.lastRunAt!).getTime(), now.getTime()) - 4 * 86_400_000);

  log(`${site.name} crawl · ${nowIso} · ${firstRun ? "backfill" : "incremental"} since ${since.toISOString().slice(0, 10)}`);
  log(`LLM relevance gate: ${llmEnabled() ? `on (${llmUsage.model})` : "off — using rules"}`);

  const byId = new Map(existing.map((i) => [i.id, i]));
  const ctx: RunContext = { now, since, firstRun, state, knownUrls: new Set(existing.map((i) => i.url)), log };

  // SKIP_SOURCES="Reddit,GDELT" is handy for quick local runs.
  const skip = (process.env.SKIP_SOURCES ?? "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  const active = SOURCES.filter((s) => !skip.some((k) => s.name.toLowerCase().startsWith(k)));
  const results = await Promise.all(active.map((s) => runSource(s, ctx)));
  const reports = [
    ...results.map((r) => r.report),
    ...SOURCES.filter((s) => !active.includes(s)).map((s) => ({ name: s.name, ok: true, fetched: 0, ms: 0, skipped: "skipped for this run" })),
  ];
  const candidates = dedupeCandidates(results.flatMap((r) => r.candidates));

  // Syndicated headlines: the same story under different URLs.
  // Same headline from the same source = same item, even if its URL format changed.
  const seenTitles = new Map<string, string>();
  const seenSourceTitles = new Set<string>();
  for (const it of existing) {
    seenTitles.set(titleKey(it.title), it.id);
    seenSourceTitles.add(`${it.source.name}|${titleKey(it.title)}`);
  }

  const fresh: { id: string; c: Candidate; score: ReturnType<typeof scoreCandidate> }[] = [];
  let updated = 0;
  for (const [id, c] of candidates) {
    const prev = byId.get(id);
    if (prev) {
      prev.metrics = { ...prev.metrics, ...c.metrics };
      prev.tags = uniq([...prev.tags, ...(c.tags ?? [])]);
      if (c.event) prev.event = c.event;
      updated++;
      continue;
    }
    if (state.rejected[id]) continue;
    const tk = titleKey(c.title);
    if ((c.category === "news" || c.category === "funding") && seenTitles.has(tk)) continue;
    if (seenSourceTitles.has(`${c.source.name}|${tk}`)) continue;
    seenTitles.set(tk, id);
    seenSourceTitles.add(`${c.source.name}|${tk}`);
    fresh.push({ id, c, score: scoreCandidate(c) });
  }

  // Relevance gate --------------------------------------------------------
  const keep: Item[] = [];
  const reject = (id: string, c: Candidate, by: "rules" | "llm") =>
    (state.rejected[id] = { at: nowIso, by, title: c.title.slice(0, 120) });

  let verdicts = new Map<string, LlmVerdict>();
  if (llmEnabled()) {
    const queue = fresh
      .filter((f) => f.c.trusted || f.score.score >= LLM_THRESHOLD)
      .sort((a, b) => Number(b.c.trusted ?? 0) - Number(a.c.trusted ?? 0) || b.score.score - a.score.score);
    log(`LLM: classifying ${queue.length} candidates…`);
    verdicts = await classify(
      queue.map(({ id, c }) => ({
        id,
        title: c.title,
        snippet: [c.snippet, c.authors?.length ? `Authors: ${c.authors.slice(0, 8).join(", ")}` : ""].filter(Boolean).join("\n"),
        source: c.source.name,
        date: c.publishedAt,
        hint: c.category,
      })),
      log,
    );
  }

  for (const { id, c, score } of fresh) {
    const v = verdicts.get(id);
    const base = { score: score.score, people: score.people, orgs: score.orgs };
    let item: Item | null = null;
    if (c.trusted) {
      item = buildItem(id, c, nowIso, { ...base, verdict: { by: "trusted", reason: v?.reason } });
    } else if (v) {
      if (v.relevant && v.confidence !== "low") {
        item = buildItem(id, c, nowIso, { ...base, verdict: { by: "llm", reason: v.reason } });
      } else {
        reject(id, c, "llm");
        continue;
      }
    } else if (score.score >= KEEP_THRESHOLD && score.topical) {
      item = buildItem(id, c, nowIso, { ...base, verdict: { by: "rules", reason: score.reasons.join(", ") } });
    } else {
      // Only cache confident rule rejections, so enabling the LLM later can still rescue borderline items.
      if (score.score < LLM_THRESHOLD) reject(id, c, "rules");
      continue;
    }
    if (v) {
      if (v.summary) item.aiSummary = v.summary;
      if (v.category && v.category !== item.category && !(item.category === "voices" || item.category === "code")) {
        item.category = v.category;
      }
      if (v.event && !item.event) item.event = v.event;
    }
    applyDeal(item, v?.deal);
    keep.push(item);
  }

  // Swap Google News redirect links for the publisher's own URL (kept items only, bounded per run).
  const gnQueue = [...keep, ...existing].filter((i) => isGoogleNews(i.url)).slice(0, Number(process.env.GN_RESOLVE_MAX ?? 40));
  let resolved = 0;
  for (const it of gnQueue) {
    try {
      const real = await resolveGoogleNews(it.url);
      if (real) {
        it.url = canonicalUrl(real);
        resolved++;
      }
    } catch (err) {
      if (err instanceof RateLimited) {
        log("Google News: rate limited — remaining links will be resolved on later runs");
        break;
      }
    }
  }
  if (gnQueue.length) log(`Google News links resolved to publishers: ${resolved}/${gnQueue.length}`);

  // Rule-based deal extraction is deterministic, so re-apply it to stored items:
  // improvements to the rules then fix past mistakes too. LLM-extracted deals are left alone.
  for (const it of existing) {
    if (it.verdict.by === "llm") continue;
    if (it.category === "funding" || it.category === "news") {
      delete it.deal;
      it.category = "news";
      applyDeal(it, undefined);
    }
  }

  // Merge, prune, persist --------------------------------------------------
  const cutoff = daysAgo(RETENTION_DAYS, now).toISOString();
  const today = nowIso.slice(0, 10);
  // Final guard: one item per (source, headline), keeping the one we saw first.
  const firstSeen = new Map<string, Item>();
  for (const it of [...existing, ...keep].sort((a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt))) {
    const k = `${it.source.name}|${titleKey(it.title)}`;
    if (!firstSeen.has(k)) firstSeen.set(k, it);
  }
  const items = [...firstSeen.values()]
    .filter((i) => i.publishedAt >= cutoff || (i.event?.end ?? "") >= today)
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));

  for (const [id, r] of Object.entries(state.rejected)) {
    if (r.at < daysAgo(90, now).toISOString()) delete state.rejected[id];
  }

  const countBy = (arr: Item[]) =>
    arr.reduce<Record<string, number>>((acc, i) => ((acc[i.category] = (acc[i.category] ?? 0) + 1), acc), {});

  const nextRun = new Date(now.getTime() + site.crawlIntervalHours * 3_600_000);
  writeData("items.json", items);
  writeData("deals.json", buildDeals(items));
  writeData("events.json", buildEvents(items, today));
  writeData(
    "repos.json",
    watchlist.repos.map((r) => state.repos[r.repo]).filter(Boolean),
  );
  writeData("state.json", state);
  writeData("meta.json", {
    lastRunAt: nowIso,
    nextRunAt: nextRun.toISOString(),
    durationMs: Date.now() - started,
    mode: firstRun ? "backfill" : "incremental",
    since: since.toISOString(),
    relevanceGate: llmEnabled() ? "llm" : "rules",
    llm: llmEnabled() ? llmUsage : null,
    counts: {
      total: items.length,
      added: keep.length,
      updated,
      candidates: candidates.size,
      rejectedThisRun: fresh.length - keep.length,
      addedByCategory: countBy(keep),
      totalByCategory: countBy(items),
    },
    sources: reports,
  });

  log(
    `\nDone in ${((Date.now() - started) / 1000).toFixed(0)}s · ${candidates.size} candidates · ${keep.length} new · ${updated} updated · ${items.length} total`,
  );
  if (llmEnabled()) log(`LLM usage: ${JSON.stringify(llmUsage)}`);
  if (reports.every((r) => !r.ok || r.skipped)) process.exitCode = 1;
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
