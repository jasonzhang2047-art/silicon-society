import { fetchText, HttpError } from "./http.ts";

/**
 * Google News RSS links point at news.google.com, which forwards to the publisher
 * with JavaScript. Readers deserve the publisher's own URL, so we resolve it the way
 * the Google News page does: read the article's signature, then ask the same endpoint
 * the page calls. Best-effort - on any failure the Google News link is kept.
 */
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";

export const isGoogleNews = (url: string) => /^https:\/\/news\.google\.com\/(?:rss\/)?articles\//.test(url);

export class RateLimited extends Error {}

/** Returns the publisher URL, null if it can't be resolved, or throws RateLimited so callers can back off. */
export async function resolveGoogleNews(url: string): Promise<string | null> {
  const id = url.split("?")[0].replace(/\/$/, "").split("/").pop();
  if (!id) return null;
  try {
    const html = await fetchText(`https://news.google.com/articles/${id}`, {
      headers: { "User-Agent": BROWSER_UA },
      retries: 0,
      timeoutMs: 15_000,
    });
    const sig = html.match(/data-n-a-sg="([^"]+)"/)?.[1];
    const ts = html.match(/data-n-a-ts="([^"]+)"/)?.[1];
    if (!sig || !ts) return null;
    const inner = `["garturlreq",[["X","X",["X","X"],null,null,1,1,"US:en",null,1,null,null,null,null,null,0,1],"X","X",1,[1,1,1],1,1,null,0,0,null,0],"${id}",${ts},"${sig}"]`;
    const body = `f.req=${encodeURIComponent(JSON.stringify([[["Fbv4je", inner]]]))}`;
    const res = await fetchText("https://news.google.com/_/DotsSplashUi/data/batchexecute", {
      method: "POST",
      body,
      headers: { "User-Agent": BROWSER_UA, "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      retries: 0,
      timeoutMs: 15_000,
    });
    const real = res.match(/\[\\"garturlres\\",\\"(.*?)\\"/)?.[1];
    if (!real) return null;
    const decoded = JSON.parse(`"${real}"`) as string;
    return /^https?:\/\//.test(decoded) && !decoded.includes("news.google.com") ? decoded : null;
  } catch (err) {
    if (err instanceof HttpError && err.status === 429) throw new RateLimited("Google News rate limit");
    return null;
  }
}
