import { fetchJson } from "../lib/http.ts";
import { topics, watchlist } from "../lib/config.ts";
import { cleanText, daysAgo, lookbackDays, ymd } from "../lib/util.ts";
import type { Candidate, RepoSnapshot, Source } from "../types.ts";

const token = () => process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
const gh = <T>(path: string) =>
  fetchJson<T>(`https://api.github.com${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(token() ? { Authorization: `Bearer ${token()}` } : {}),
    },
  });

interface GhRepo {
  full_name: string;
  html_url: string;
  description: string | null;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  pushed_at: string;
  created_at: string;
  language: string | null;
  owner: { login: string };
}
interface GhRelease {
  tag_name: string;
  name: string | null;
  html_url: string;
  body: string | null;
  published_at: string | null;
  draft: boolean;
  prerelease: boolean;
}

/** Tracked repositories: star history snapshots + release announcements. */
export const githubRepos: Source = {
  name: "GitHub · tracked repos",
  async run(ctx) {
    const out: Candidate[] = [];
    const today = ymd(ctx.now);
    for (const t of watchlist.repos) {
      const repo = await gh<GhRepo>(`/repos/${t.repo}`);
      const releases = await gh<GhRelease[]>(`/repos/${t.repo}/releases?per_page=5`).catch(() => []);
      const prev = ctx.state.repos[t.repo];
      const history = (prev?.history ?? []).filter((h) => h.date !== today);
      history.push({ date: today, stars: repo.stargazers_count });
      const latest = releases.find((r) => !r.draft && r.published_at);
      const snapshot: RepoSnapshot = {
        repo: repo.full_name,
        label: t.label,
        org: t.org,
        description: cleanText(repo.description, 200),
        url: repo.html_url,
        stars: repo.stargazers_count,
        forks: repo.forks_count,
        openIssues: repo.open_issues_count,
        pushedAt: repo.pushed_at,
        language: repo.language,
        latestRelease: latest
          ? { tag: latest.tag_name, name: latest.name || latest.tag_name, url: latest.html_url, publishedAt: latest.published_at! }
          : undefined,
        history: history.slice(-400),
      };
      ctx.state.repos[t.repo] = snapshot;

      for (const r of releases) {
        if (r.draft || !r.published_at || new Date(r.published_at) < ctx.since) continue;
        out.push({
          url: r.html_url,
          title: `${repo.full_name} ${r.name && r.name !== r.tag_name ? `${r.tag_name} — ${r.name}` : r.tag_name}`,
          snippet: cleanText(r.body?.replace(/[#*`>-]/g, " "), 400) || undefined,
          category: "code",
          source: { kind: "github", name: "GitHub", url: repo.html_url },
          publishedAt: r.published_at,
          tags: ["release", ...(r.prerelease ? ["pre-release"] : [])],
          metrics: { stars: repo.stargazers_count },
          orgs: t.org ? [t.org] : [],
          trusted: true,
        });
      }
    }
    return out;
  },
};

/** New repositories in the field that are gaining traction. */
export const githubDiscovery: Source = {
  name: "GitHub · discovery",
  async run(ctx) {
    const out: Candidate[] = [];
    const created = ymd(daysAgo(Math.max(30, lookbackDays(ctx.since, ctx.now)), ctx.now));
    const tracked = new Set(watchlist.repos.map((r) => r.repo.toLowerCase()));
    for (const q of topics.githubDiscovery) {
      const res = await gh<{ items: GhRepo[] }>(
        `/search/repositories?q=${encodeURIComponent(`${q} created:>${created}`)}&sort=stars&order=desc&per_page=20`,
      );
      for (const r of res.items) {
        if (r.stargazers_count < 25 || tracked.has(r.full_name.toLowerCase())) continue;
        out.push({
          url: r.html_url,
          title: `${r.full_name}${r.description ? ` — ${cleanText(r.description, 160)}` : ""}`,
          snippet: cleanText(r.description, 300) || undefined,
          category: "code",
          source: { kind: "github", name: "GitHub", url: r.html_url },
          author: { name: r.owner.login, url: `https://github.com/${r.owner.login}` },
          publishedAt: r.created_at,
          tags: ["new-repo"],
          metrics: { stars: r.stargazers_count },
        });
      }
    }
    return out;
  },
};
