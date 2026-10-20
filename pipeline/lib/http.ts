const UA =
  process.env.CRAWLER_USER_AGENT ??
  "SiliconSocietyBot/0.1 (+https://github.com/jasonzhang2047-art/silicon-society; public research dashboard)";

/** Minimum gap between requests to the same host, in ms. Respects each API's published limits. */
const HOST_GAP: Record<string, number> = {
  "export.arxiv.org": 3100,
  "api.gdeltproject.org": 6500,
  "www.reddit.com": 6500,
  "news.google.com": 2000,
  "public.api.bsky.app": 250,
  "api.github.com": 250,
  "huggingface.co": 400,
};
const lastHit = new Map<string, number>();

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function throttle(url: string) {
  const host = new URL(url).host;
  const gap = HOST_GAP[host] ?? 300;
  const last = lastHit.get(host) ?? 0;
  const wait = last + gap - Date.now();
  if (wait > 0) await sleep(wait);
  lastHit.set(host, Date.now());
}

export class HttpError extends Error {
  constructor(
    public status: number,
    public url: string,
    body: string,
  ) {
    super(`HTTP ${status} for ${url}: ${body.slice(0, 160)}`);
  }
}

export interface FetchOpts {
  headers?: Record<string, string>;
  timeoutMs?: number;
  retries?: number;
  method?: string;
  body?: string;
}

export async function fetchText(url: string, opts: FetchOpts = {}): Promise<string> {
  const { retries = 2, timeoutMs = 25_000 } = opts;
  let attempt = 0;
  for (;;) {
    await throttle(url);
    try {
      const res = await fetch(url, {
        method: opts.method ?? "GET",
        body: opts.body,
        headers: { "User-Agent": UA, Accept: "*/*", ...opts.headers },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "follow",
      });
      const text = await res.text();
      if (res.ok) return text;
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= retries) throw new HttpError(res.status, url, text);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      if (attempt >= retries) throw err;
    }
    attempt++;
    await sleep(1500 * 2 ** attempt);
  }
}

export async function fetchJson<T>(url: string, opts: FetchOpts = {}): Promise<T> {
  const text = await fetchText(url, {
    ...opts,
    headers: { Accept: "application/json", ...opts.headers },
  });
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Invalid JSON from ${url}: ${text.slice(0, 160)}`);
  }
}
