import { fetchJson, fetchText } from "../lib/http.ts";
import { parseFeed } from "../lib/feed.ts";
import { watchlist } from "../lib/config.ts";
import { cleanText, toIso, ymd } from "../lib/util.ts";
import type { Candidate, Source } from "../types.ts";

interface ComsesEvent {
  title: string;
  absoluteUrl: string;
  externalUrl: string | null;
  startDate: string | null;
  endDate: string | null;
  submissionDeadline: string | null;
  location: string | null;
  isExpired: boolean;
  isMarkedSpam: boolean;
  lastModified: string;
  dateCreated: string;
  description?: string;
}

/** CoMSES Net — the computational modelling (agent-based) community's event board. */
export const comses: Source = {
  name: "CoMSES Net events",
  async run(ctx) {
    const out: Candidate[] = [];
    const today = ymd(ctx.now);
    for (let page = 1; page <= 3; page++) {
      const res = await fetchJson<{ results: ComsesEvent[] }>(`https://www.comses.net/events/?format=json&page=${page}`);
      for (const e of res.results) {
        if (e.isMarkedSpam || e.isExpired) continue;
        const end = e.endDate ?? e.startDate;
        if (!end || end < today) continue;
        out.push({
          url: `https://www.comses.net${e.absoluteUrl}`,
          title: cleanText(e.title, 300),
          snippet: cleanText(e.description, 400) || undefined,
          link: e.externalUrl ?? undefined,
          category: "events",
          source: { kind: "comses", name: "CoMSES Net", url: "https://www.comses.net/events/" },
          publishedAt: toIso(e.lastModified) ?? ctx.now.toISOString(),
          tags: ["abm-community", ...(e.submissionDeadline && e.submissionDeadline >= today ? ["cfp-open"] : [])],
          event: {
            name: cleanText(e.title, 300),
            start: e.startDate,
            end: e.endDate,
            location: e.location && e.location.trim() ? cleanText(e.location, 120) : null,
            url: e.externalUrl ?? `https://www.comses.net${e.absoluteUrl}`,
          },
          // The modelling community's own calendar: adjacent by construction.
          trusted: true,
        });
      }
    }
    return out;
  },
};

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};
function parseCfpDate(s: string): string | null {
  const m = s.trim().match(/^([A-Za-z]{3})\w*\s+(\d{1,2}),\s*(\d{4})$/);
  if (!m) return null;
  const mm = MONTHS[m[1].toLowerCase()];
  return mm ? `${m[3]}-${mm}-${m[2].padStart(2, "0")}` : null;
}

/** WikiCFP category feeds: calls for papers for upcoming conferences and workshops. */
export const wikicfp: Source = {
  name: "WikiCFP",
  async run(ctx) {
    const out: Candidate[] = [];
    const today = ymd(ctx.now);
    for (const feed of watchlist.feeds.filter((f) => f.type === "wikicfp")) {
      const xml = await fetchText(feed.url!).catch(() => "");
      for (const e of parseFeed(xml)) {
        // "Full Name [Location] [Dec 14, 2026 - Dec 17, 2026]"
        const desc = cleanText(e.summary, 500);
        const parts = [...desc.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]);
        const name = desc.replace(/\s*\[[^\]]*\]/g, "").trim() || e.title;
        const dates = parts.find((p) => /\d{4}/.test(p));
        const location = parts.find((p) => p !== dates) ?? null;
        const [startRaw, endRaw] = (dates ?? "").split(/\s+-\s+/);
        const start = startRaw ? parseCfpDate(startRaw) : null;
        const end = endRaw ? parseCfpDate(endRaw) : start;
        if (!start || (end ?? start) < today) continue;
        const acronym = e.title.split(" : ")[0];
        out.push({
          url: e.link.replace(/&copyownerid=\d+/, ""),
          title: `${acronym}: ${name}`,
          snippet: `Call for papers · ${location ?? "Location TBA"}`,
          category: "events",
          source: { kind: "wikicfp", name: "WikiCFP", url: "http://www.wikicfp.com" },
          publishedAt: ctx.now.toISOString(),
          tags: ["cfp"],
          event: { name: `${acronym} — ${name}`, start, end, location, url: e.link.replace(/&copyownerid=\d+/, "") },
          trusted: feed.trusted,
          boost: feed.trusted ? 0 : 1,
        });
      }
    }
    return out;
  },
};
