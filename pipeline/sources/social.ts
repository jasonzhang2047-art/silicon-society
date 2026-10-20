import { fetchJson, fetchText } from "../lib/http.ts";
import { topics, watchlist } from "../lib/config.ts";
import { cleanText, lookbackDays, toIso } from "../lib/util.ts";
import type { Candidate, Source } from "../types.ts";

// ---------------------------------------------------------------------------
// Bluesky — open AppView API, no key needed for author feeds.

interface BskyPost {
  uri: string;
  author: { handle: string; displayName?: string; avatar?: string };
  record: { text: string; createdAt: string };
  embed?: { external?: { uri: string; title: string; description: string }; $type?: string };
  likeCount?: number;
  repostCount?: number;
  replyCount?: number;
}
interface BskyFeed {
  feed: { post: BskyPost; reason?: { $type: string } }[];
}

const accounts = () => [
  ...watchlist.people.filter((p) => p.links.bluesky).map((p) => ({ handle: p.links.bluesky!, person: p.id, org: undefined as string | undefined, name: p.name })),
  ...watchlist.orgs.filter((o) => o.links?.bluesky).map((o) => ({ handle: o.links!.bluesky!, person: undefined as string | undefined, org: o.id, name: o.name })),
];

function bskyCandidate(post: BskyPost, who: { person?: string; org?: string }): Candidate {
  const rkey = post.uri.split("/").pop();
  const ext = post.embed?.external;
  const text = cleanText(post.record.text, 500);
  return {
    url: `https://bsky.app/profile/${post.author.handle}/post/${rkey}`,
    title: text.length > 280 ? `${text.slice(0, 277)}…` : text,
    snippet: ext ? cleanText(`${ext.title}. ${ext.description}`, 300) : undefined,
    link: ext?.uri,
    category: "voices",
    source: { kind: "bluesky", name: "Bluesky", url: "https://bsky.app" },
    author: {
      name: post.author.displayName || post.author.handle,
      handle: `@${post.author.handle}`,
      url: `https://bsky.app/profile/${post.author.handle}`,
      avatar: post.author.avatar,
    },
    publishedAt: toIso(post.record.createdAt)!,
    metrics: { likes: post.likeCount ?? 0, reposts: post.repostCount ?? 0, replies: post.replyCount ?? 0 },
    people: who.person ? [who.person] : [],
    orgs: who.org ? [who.org] : [],
    // Posts from tracked accounts still need an on-topic signal, but need less of one.
    boost: 2,
  };
}

export const blueskyAccounts: Source = {
  name: "Bluesky · tracked accounts",
  async run(ctx) {
    const out: Candidate[] = [];
    for (const a of accounts()) {
      try {
        const res = await fetchJson<BskyFeed>(
          `https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(a.handle)}&limit=${lookbackDays(ctx.since, ctx.now) > 7 ? 100 : 40}&filter=posts_no_replies`,
        );
        for (const { post, reason } of res.feed) {
          if (reason) continue; // reposts of other people's content
          if (new Date(post.record.createdAt) < ctx.since) continue;
          out.push(bskyCandidate(post, { person: a.person, org: a.org }));
        }
      } catch (err) {
        ctx.log(`  bluesky ${a.handle}: ${(err as Error).message.slice(0, 100)}`);
      }
    }
    return out;
  },
};

/** Keyword search across all of Bluesky. Requires a (free) app password since searchPosts needs auth. */
export const blueskySearch: Source = {
  name: "Bluesky · search",
  disabled: () =>
    process.env.BSKY_HANDLE && process.env.BSKY_APP_PASSWORD ? undefined : "set BSKY_HANDLE + BSKY_APP_PASSWORD",
  async run(ctx) {
    const session = JSON.parse(
      await fetchText("https://bsky.social/xrpc/com.atproto.server.createSession", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: process.env.BSKY_HANDLE, password: process.env.BSKY_APP_PASSWORD }),
      }),
    ) as { accessJwt: string };
    const out: Candidate[] = [];
    for (const q of topics.discussionQueries) {
      const res = await fetchJson<{ posts: BskyPost[] }>(
        `https://bsky.social/xrpc/app.bsky.feed.searchPosts?q=${encodeURIComponent(q)}&limit=50&sort=latest&since=${ctx.since.toISOString()}`,
        { headers: { Authorization: `Bearer ${session.accessJwt}` } },
      );
      for (const post of res.posts) {
        const c = bskyCandidate(post, {});
        c.boost = 0;
        out.push(c);
      }
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// X (Twitter) — paid API only. Enabled when X_BEARER_TOKEN is set.

interface XSearch {
  data?: { id: string; text: string; created_at: string; author_id: string; public_metrics?: { like_count: number; retweet_count: number; reply_count: number } }[];
  includes?: { users?: { id: string; username: string; name: string; profile_image_url?: string }[] };
}

export const xPosts: Source = {
  name: "X · tracked accounts & keywords",
  disabled: () => (process.env.X_BEARER_TOKEN ? undefined : "set X_BEARER_TOKEN (paid X API access)"),
  async run(ctx) {
    const handles = [
      ...watchlist.people.filter((p) => p.links.x).map((p) => ({ h: p.links.x!, person: p.id })),
      ...watchlist.orgs.filter((o) => o.links?.x).map((o) => ({ h: o.links!.x!, org: o.id })),
    ];
    const byHandle = new Map(handles.map((x) => [x.h.toLowerCase(), x]));
    // Recent search allows 512-char queries; chunk the account list accordingly.
    const queries: string[] = [];
    let chunk: string[] = [];
    for (const { h } of handles) {
      chunk.push(`from:${h}`);
      if (chunk.join(" OR ").length > 420) {
        queries.push(`(${chunk.join(" OR ")}) -is:retweet -is:reply`);
        chunk = [];
      }
    }
    if (chunk.length) queries.push(`(${chunk.join(" OR ")}) -is:retweet -is:reply`);
    queries.push(
      '("generative agents" OR "synthetic respondents" OR "silicon sampling" OR "social simulation" OR MiroFish OR "human digital twin") -is:retweet lang:en',
    );

    const out: Candidate[] = [];
    const start = new Date(Math.max(ctx.since.getTime(), ctx.now.getTime() - 6.9 * 86_400_000)).toISOString();
    for (const q of queries) {
      const url =
        `https://api.x.com/2/tweets/search/recent?query=${encodeURIComponent(q)}&max_results=100&start_time=${start}` +
        "&tweet.fields=created_at,author_id,public_metrics&expansions=author_id&user.fields=username,name,profile_image_url";
      const res = await fetchJson<XSearch>(url, { headers: { Authorization: `Bearer ${process.env.X_BEARER_TOKEN}` } });
      const users = new Map((res.includes?.users ?? []).map((u) => [u.id, u]));
      for (const t of res.data ?? []) {
        const u = users.get(t.author_id);
        if (!u) continue;
        const tracked = byHandle.get(u.username.toLowerCase());
        const text = cleanText(t.text, 500);
        out.push({
          url: `https://x.com/${u.username}/status/${t.id}`,
          title: text.length > 280 ? `${text.slice(0, 277)}…` : text,
          category: "voices",
          source: { kind: "x", name: "X", url: "https://x.com" },
          author: { name: u.name, handle: `@${u.username}`, url: `https://x.com/${u.username}`, avatar: u.profile_image_url },
          publishedAt: t.created_at,
          metrics: {
            likes: t.public_metrics?.like_count ?? 0,
            reposts: t.public_metrics?.retweet_count ?? 0,
            replies: t.public_metrics?.reply_count ?? 0,
          },
          people: tracked && "person" in tracked && tracked.person ? [tracked.person] : [],
          orgs: tracked && "org" in tracked && tracked.org ? [tracked.org] : [],
          boost: tracked ? 2 : 0,
        });
      }
    }
    return out;
  },
};
