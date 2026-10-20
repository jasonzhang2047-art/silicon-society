import Anthropic from "@anthropic-ai/sdk";
import { site } from "./config.ts";
import type { Category, DealInfo, EventInfo } from "../types.ts";

/**
 * Optional LLM gate. The LLM never creates items - it only decides whether a
 * crawled item is on-topic, picks its section, writes a one-line summary from
 * the supplied text, and extracts deal/event fields that are explicitly stated.
 */

const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5"; // CI passes unset vars as ""
const BATCH_SIZE = 20;
export const LLM_MAX_ITEMS = Number(process.env.LLM_MAX_ITEMS || 400);

export const llmEnabled = () =>
  Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) && process.env.DISABLE_LLM !== "1";

export interface LlmInput {
  id: string;
  title: string;
  snippet?: string;
  source: string;
  date: string;
  hint: Category;
}

export interface LlmVerdict {
  relevant: boolean;
  confidence: "high" | "medium" | "low";
  category: Category;
  summary: string;
  reason: string;
  deal: Omit<DealInfo, "auto"> | null;
  event: EventInfo | null;
}

export const llmUsage = { requests: 0, inputTokens: 0, outputTokens: 0, refusals: 0, errors: 0, model: MODEL };

const nullable = (schema: object) => ({ anyOf: [schema, { type: "null" }] });
const stringList = { type: "array", items: { type: "string" } };

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["results"],
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "relevant", "confidence", "category", "summary", "reason", "deal", "event"],
        properties: {
          id: { type: "string" },
          relevant: { type: "boolean" },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
          category: {
            type: "string",
            enum: ["research", "funding", "news", "voices", "code", "events", "discussion"],
          },
          summary: { type: "string" },
          reason: { type: "string" },
          deal: nullable({
            type: "object",
            additionalProperties: false,
            required: ["company", "round", "amountText", "amountUsd", "lead", "participants"],
            properties: {
              company: { type: "string" },
              round: nullable({ type: "string" }),
              amountText: nullable({ type: "string" }),
              amountUsd: nullable({ type: "number" }),
              lead: stringList,
              participants: stringList,
            },
          }),
          event: nullable({
            type: "object",
            additionalProperties: false,
            required: ["name", "start", "end", "location", "url"],
            properties: {
              name: { type: "string" },
              start: nullable({ type: "string", format: "date" }),
              end: nullable({ type: "string", format: "date" }),
              location: nullable({ type: "string" }),
              url: nullable({ type: "string" }),
            },
          }),
        },
      },
    },
  },
};

const SYSTEM = `You are the relevance editor for "${site.name}", a public dashboard that tracks one field:

SCOPE: ${site.scope}
In scope: using AI (especially LLM-based agents) to simulate people, populations, markets or societies — generative agents, social/society simulation, synthetic respondents and personas, human or consumer digital twins, silicon sampling, AI focus groups, swarm/crowd prediction engines, agent-based models driven by LLMs, validation of such simulations, and the companies, researchers, investors, tools and events in this space.
Out of scope: physical/engineering simulation, robotics and self-driving sim, industrial or network digital twins, generic AI agents that do not simulate humans, generic LLM news, crypto, games unless they are research platforms for human-behavior simulation.

For each item decide:
- relevant: true only if the item is substantively about the scope (not a passing mention).
- category: research (papers, preprints, technical reports), funding (a specific financing, acquisition or valuation event), news (press coverage, company/product announcements, official blog posts), voices (social-media posts by people/orgs), code (repositories, releases), events (conferences, workshops, meetups, calls for papers, webinars), discussion (forum threads). Keep the hint unless the content clearly says otherwise.
- summary: one plain sentence (max 30 words) restating what the item says, using ONLY facts present in the supplied text. No hype, no speculation, no facts from memory. Empty string if not relevant.
- reason: 3-10 words on why it is or isn't in scope.
- deal: only when the text explicitly reports a financing/acquisition; copy amounts, round and investors exactly as stated; amountUsd is your USD conversion of the stated amount or null if none is stated. Otherwise null.
- event: only when the text announces a specific event with a date; dates as YYYY-MM-DD; null fields when not stated. Otherwise null.
Return one result per input id.`;

let client: Anthropic | null = null;

async function classifyBatch(batch: LlmInput[]): Promise<Map<string, LlmVerdict>> {
  client ??= new Anthropic();
  const payload = batch.map((b) => ({
    id: b.id,
    hint: b.hint,
    source: b.source,
    date: b.date.slice(0, 10),
    title: b.title,
    text: (b.snippet ?? "").slice(0, 900),
  }));

  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
    output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
    messages: [{ role: "user", content: `Classify these ${payload.length} items:\n${JSON.stringify(payload)}` }],
  });

  llmUsage.requests++;
  llmUsage.inputTokens += response.usage.input_tokens + (response.usage.cache_read_input_tokens ?? 0);
  llmUsage.outputTokens += response.usage.output_tokens;

  const out = new Map<string, LlmVerdict>();
  if (response.stop_reason === "refusal") {
    llmUsage.refusals++;
    return out;
  }
  const textBlock = response.content.find((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text");
  if (!textBlock) return out;
  const parsed = JSON.parse(textBlock.text) as { results: (LlmVerdict & { id: string })[] };
  for (const r of parsed.results) {
    if (batch.some((b) => b.id === r.id)) out.set(r.id, r);
  }
  return out;
}

export async function classify(inputs: LlmInput[], log: (m: string) => void): Promise<Map<string, LlmVerdict>> {
  const results = new Map<string, LlmVerdict>();
  const todo = inputs.slice(0, LLM_MAX_ITEMS);
  for (let i = 0; i < todo.length; i += BATCH_SIZE) {
    const batch = todo.slice(i, i + BATCH_SIZE);
    try {
      const res = await classifyBatch(batch);
      for (const [k, v] of res) results.set(k, v);
    } catch (err) {
      llmUsage.errors++;
      if (err instanceof Anthropic.AuthenticationError) {
        log(`LLM: authentication failed — falling back to rules for the rest of this run`);
        break;
      } else if (err instanceof Anthropic.RateLimitError) {
        log(`LLM: rate limited — stopping LLM pass, rules will decide remaining items`);
        break;
      } else if (err instanceof Anthropic.APIError) {
        log(`LLM: API error ${err.status}: ${err.message.slice(0, 160)}`);
      } else {
        log(`LLM: ${(err as Error).message.slice(0, 160)}`);
      }
    }
  }
  return results;
}
