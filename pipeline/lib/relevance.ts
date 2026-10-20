import { topics, watchlist } from "./config.ts";
import type { Candidate, DealInfo } from "../types.ts";

const rx = (p: string) => new RegExp(p, "i");
const STRONG = topics.strong.map(rx);
const MEDIUM = topics.medium.map(rx);
const CONTEXT = topics.context.map(rx);
const AI = topics.ai.map(rx);
const NEGATIVE = topics.negative.map(rx);

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const PEOPLE = watchlist.people.map((p) => ({ id: p.id, re: rx(p.match ?? `\\b${escape(p.name)}\\b`) }));
const ORGS = watchlist.orgs.map((o) => ({ id: o.id, kind: o.kind, re: rx(o.match ?? `\\b${escape(o.name)}\\b`) }));

/** Score at or above which an item is kept when no LLM is configured. */
export const KEEP_THRESHOLD = 3;
/** Score at or above which an item is worth sending to the LLM for a decision. */
export const LLM_THRESHOLD = 1;

export interface Scored {
  score: number;
  /** Whether the text itself carries an on-topic signal (names alone never do). */
  topical: boolean;
  people: string[];
  orgs: string[];
  reasons: string[];
}

function hits(res: RegExp[], text: string, reasons: string[]): number {
  let n = 0;
  for (const re of res) {
    const m = text.match(re);
    if (m) {
      n++;
      if (reasons.length < 4) reasons.push(m[0].toLowerCase().slice(0, 40));
    }
  }
  return n;
}

export function scoreCandidate(c: Candidate): Scored {
  const text = `${c.title}\n${c.snippet ?? ""}`;
  const authorText = (c.authors ?? []).join(", ");
  const reasons: string[] = [];

  const strong = hits(STRONG, text, reasons);
  const medium = hits(MEDIUM, text, reasons);
  const hasAi = AI.some((re) => re.test(text));
  const context = hasAi ? CONTEXT.filter((re) => re.test(text)).length : 0;
  const negatives = NEGATIVE.filter((re) => re.test(text)).length;

  const people = PEOPLE.filter((p) => p.re.test(text) || p.re.test(authorText)).map((p) => p.id);
  // Investors are only tagged, never scored: "Sequoia" alone says nothing about the topic.
  const orgHits = ORGS.filter((o) => o.re.test(text));
  const topicalOrgs = orgHits.filter((o) => o.kind !== "investor").length;

  const score =
    (c.boost ?? 0) +
    Math.min(strong, 3) * 3 +
    Math.min(medium, 2) * 2 +
    Math.min(context, 3) -
    negatives * 3 +
    Math.min(people.length, 2) +
    Math.min(topicalOrgs, 2) * 2;

  // A loose phrase like "generative agents" needs corroborating social-science context.
  const topical = strong > 0 || topicalOrgs > 0 || (medium > 0 && context >= 2);

  return {
    score,
    topical,
    people: [...new Set([...(c.people ?? []), ...people])],
    orgs: [...new Set([...(c.orgs ?? []), ...orgHits.map((o) => o.id)])],
    reasons,
  };
}

// ---------------------------------------------------------------------------
// Funding detection from headlines (used when no LLM is configured, and as a
// cross-check when one is).

const MONEY =
  /(?:US\$|\$|€|£|¥|RMB\s?|CNY\s?)\s?(\d+(?:[.,]\d+)?)\s?(k|thousand|m|mn|million|b|bn|billion)?\b|(\d+(?:\.\d+)?)\s?(million|billion|万|亿)\s?(?:dollars|euros|pounds|yuan|rmb)?/i;
const RAISE_VERB = /\b(raises?|raised|secures?|secured|closes?|closed|lands?|landed|bags?|nabs?|snags?|banks?|gets?|announces?)\b/i;
const ROUND = /\b(pre-?seed|pre-series [a-h]|seed|series [a-h](?:\d)?|growth round|strategic round|angel round|bridge round)\b/i;
const FUNDING_WORDS = /\b(funding|round|valuation|investment|raise[sd]?|backed|led by)\b/i;

function toUsd(amount: number, unit: string | undefined, currencyHint: string): number | null {
  const mult: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, mn: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9 };
  const value = amount * (mult[(unit ?? "").toLowerCase()] ?? 1);
  if (value < 50_000) return null; // not a funding amount
  const fx: Record<string, number> = { "€": 1.08, "£": 1.27, "¥": 0.14, RMB: 0.14, CNY: 0.14 };
  const rate = Object.entries(fx).find(([sym]) => currencyHint.includes(sym))?.[1] ?? 1;
  return Math.round(value * rate);
}

// Entity extraction is token-based on purpose: nested regex quantifiers over
// headline text are a catastrophic-backtracking hazard.
const ACQ_VERB =
  /\b(?:signs (?:a )?definitive agreement to acquire|agrees to (?:buy|acquire)|completes (?:its )?acquisition of|to acquire|acquires|to buy|buys|snaps up)\b/i;
const JOIN_VERB = /\bis joining\b/i;
const TRACKED_ORG_NAMES = watchlist.orgs.map((o) => o.name.toLowerCase());
const DESCRIPTOR =
  /^(?:the|a|an|ai|ai-powered|startup|company|firm|platform|unicorn|lab|research|customer|consumer|market|synthetic|british|uk|us|chinese|european|london|paris|french|german|stanford|yc|[a-z][\w-]*-(?:founded|based|backed|native))$/i;
const RIGHT_STOP = /\s(?:for|in|at|amid|with|to|after|as)\s|[,:;?!]|\s[-–—]\s/i;

/** Drops leading descriptor words: "AI customer research startup Listen Labs" -> "Listen Labs". */
function stripDescriptors(phrase: string): string {
  let tokens = phrase.trim().split(/\s+/);
  // "Synthetic-user startup Simile" -> "Simile"
  const noun = tokens.findIndex((w, i) => i < tokens.length - 1 && /^(?:startup|company|firm|platform|unicorn|maker)$/i.test(w));
  if (noun >= 0) tokens = tokens.slice(noun + 1);
  while (tokens.length > 1 && (DESCRIPTOR.test(tokens[0]) || /^[a-z]/.test(tokens[0]))) tokens.shift();
  return tokens.join(" ").replace(/['’]s$/, "").trim();
}

/** Text before the verb, minus any "Headline kicker:" prefix and trailing helper verbs. */
function leftEntity(before: string): string {
  const parts = before.split(/:\s/);
  let seg = parts.pop() ?? before;
  seg = seg.split(/\s(?:with|from|that|which)\s/)[0];
  const name = stripDescriptors(seg.replace(/\s+(?:signs|agrees|has|will|is set|plans)$/i, ""));
  if (plausibleName(name)) return name;
  // "Meet Talp: AI startup with Turkish roots raised..." -> "Talp"
  const meet = parts.join(": ").match(/^Meet ([A-Z][\w.-]*(?: [A-Z][\w.-]*){0,2})$/);
  return meet ? meet[1] : name;
}

function rightEntity(after: string): string {
  const stop = after.search(RIGHT_STOP);
  return stripDescriptors(stop >= 0 ? after.slice(0, stop) : after);
}

function plausibleName(s: string) {
  return s.length >= 2 && s.split(" ").length <= 4 && /^[A-Z0-9]/.test(s);
}

const MONEY_ALL = new RegExp(MONEY.source, "gi");

function amountFrom(text: string): { amountText: string | null; amountUsd: number | null } {
  // Skip figures that are valuations ("at a $2B valuation"), not the amount raised.
  const money = [...text.matchAll(MONEY_ALL)].find(
    (m) => !/^\s*(?:post-money |pre-money |headline )?valuation/i.test(text.slice((m.index ?? 0) + m[0].length)),
  );
  if (!money) return { amountText: null, amountUsd: null };
  const num = parseFloat((money[1] ?? money[3]).replace(",", "."));
  const unit = money[2] ?? money[4];
  let amountUsd: number | null;
  if (unit === "万") amountUsd = toUsd(num * 1e4, undefined, "¥");
  else if (unit === "亿") amountUsd = toUsd(num * 1e8, undefined, "¥");
  else amountUsd = toUsd(num, unit, money[0]);
  return { amountText: money[0].trim(), amountUsd };
}

export function detectDeal(title: string, snippet = ""): DealInfo | null {
  const t = title.replace(/\s+/g, " ").trim();

  // Questions ("Is X a bargain as it buys Y?") and commentary aren't reports of a deal.
  if (/\?\s*$/.test(t)) return null;
  // Rumours aren't deals until they're announced.
  if (/\b(?:in talks|held talks|talks to|weighs|weighing|mulls|considering|explores|exploring|rumou?r|eyes)\b/i.test(t)) return null;

  const acq = t.match(ACQ_VERB);
  const join = acq ? null : t.match(JOIN_VERB);
  const verbMatch = acq ?? join;
  if (verbMatch && verbMatch.index !== undefined) {
    const before = t.slice(0, verbMatch.index);
    const after = t.slice(verbMatch.index + verbMatch[0].length);
    const acquirer = acq ? leftEntity(before) : rightEntity(after);
    const target = acq ? rightEntity(after) : leftEntity(before);
    // "X is joining Y" is only an acquisition when X is a company we track (people join companies too).
    const joinOk = !join || TRACKED_ORG_NAMES.includes(target.toLowerCase());
    if (joinOk && plausibleName(acquirer) && plausibleName(target)) {
      return { company: target, round: "Acquisition", ...amountFrom(t), lead: [acquirer], participants: [], auto: true };
    }
  }

  if (!RAISE_VERB.test(t) || !FUNDING_WORDS.test(`${t} ${snippet}`)) return null;
  const money = t.match(MONEY);
  const round = t.match(ROUND)?.[1] ?? snippet.match(ROUND)?.[1] ?? null;
  if (!money && !round) return null;

  const verb = t.match(RAISE_VERB)!;
  // "AI startup Simile raises..." -> "Simile"
  const company = leftEntity(t.slice(0, verb.index));
  if (!plausibleName(company)) return null;

  const { amountText, amountUsd } = amountFrom(t);
  const ledBy = `${t} ${snippet}`.match(/led by ([A-Z][\w&.'’ -]{2,60}?)(?:[,.;]| with| and | at |$)/);

  return {
    company,
    round: round ? round.replace(/\b\w/g, (c) => c.toUpperCase()).replace(/^Pre-?seed$/i, "Pre-seed") : null,
    amountText,
    amountUsd,
    lead: ledBy ? [ledBy[1].trim()] : [],
    participants: [],
    auto: true,
  };
}
