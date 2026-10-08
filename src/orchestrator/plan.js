/**
 * Step 2: query decomposition. Produces several distinct search queries that cover
 * different facets of the question, with duplicates removed and a per-depth limit.
 */
import { parseJsonLoose } from '../utils/json.js';
import { jaccard, normalizeQueryKey, normalizeWhitespace, tokenize, truncate } from '../utils/text.js';

const TARGET_BY_COMPLEXITY = { simple: 1, moderate: 3, complex: 6, very_complex: 9 };
const DEPTH_BOOST = { quick: 0, research: 0, deep: 2 };

/**
 * How many searches to run. Complexity sets the target, the mode sets the cap, and
 * "simple" never gets more than one search.
 */
export function queryLimit({ complexity = 'moderate', mode = 'research', config }) {
  const cap = config?.research?.maxSearchesByMode?.[mode] ?? 6;
  if (complexity === 'simple') return Math.max(1, Math.min(1, cap));
  const target = (TARGET_BY_COMPLEXITY[complexity] ?? 3) + (DEPTH_BOOST[mode] ?? 0);
  return Math.max(1, Math.min(target, cap));
}

/** Drop empty queries and near-duplicates (token overlap ≥ 0.9), keep order, cap the count. */
export function dedupeQueries(queries, max = 6) {
  const kept = [];
  const keptTokens = [];
  const seenKeys = new Set();
  for (const raw of queries) {
    const q = normalizeWhitespace(raw).slice(0, 200);
    const key = normalizeQueryKey(q);
    if (!key || seenKeys.has(key)) continue;
    const tokens = new Set(tokenize(q));
    if (keptTokens.some((t) => jaccard(t, tokens) >= 0.9)) continue;
    seenKeys.add(key);
    kept.push(q);
    keptTokens.push(tokens);
    if (kept.length >= max) break;
  }
  return kept;
}

/** Deterministic query set built from the plan. Always useful even without an LLM. */
export function heuristicQueries(plan, { now = new Date() } = {}) {
  const topic = normalizeWhitespace(plan.topic || plan.standaloneQuestion);
  const year = now.getFullYear();
  const out = [topic];
  for (const facet of (plan.facets ?? []).slice(0, 6)) out.push(`${topic} ${facet}`);

  switch (plan.domain) {
    case 'scientific':
      out.push(`${topic} systematic review meta-analysis`);
      out.push(`${topic} randomized controlled trial`);
      out.push(`${topic} official health guidance`);
      out.push(`${topic} risks side effects`);
      break;
    case 'product':
      out.push(`${topic} official specifications`);
      out.push(`${topic} independent review test results`);
      out.push(`${topic} price ${year}`);
      break;
    case 'legal':
      out.push(`${topic} official government guidance`);
      out.push(`${topic} current rules ${year}`);
      break;
    case 'news':
      out.push(`${topic} latest news`);
      out.push(`${topic} ${year}`);
      break;
    default:
      if (plan.requiresCurrent) out.push(`${topic} ${year}`);
      if (plan.signals?.compare) out.push(`${topic} comparison independent tests`);
  }
  return out;
}

export const QUERY_SYSTEM = `You write web search queries for a research assistant.
Return ONLY JSON: {"queries": ["..."]}.
Each query must cover a different aspect of the question (facts, evidence, official sources, independent reviews, limitations, current data). No duplicates. Keep each query under 12 words. Do not add quotation marks or site: operators unless essential.`;

/**
 * LLM-written queries first, heuristic queries to fill any gaps.
 */
export async function generateQueries({ llm, plan, maxQueries, logger, now }) {
  const heuristic = heuristicQueries(plan, { now });
  let fromLlm = [];
  if (llm) {
    try {
      const res = await llm.complete({
        system: QUERY_SYSTEM,
        messages: [
          {
            role: 'user',
            content: JSON.stringify({
              question: plan.standaloneQuestion,
              topic: plan.topic,
              facets: plan.facets,
              domain: plan.domain,
              requiresCurrent: plan.requiresCurrent,
              count: maxQueries,
            }),
          },
        ],
        json: true,
        maxTokens: 400,
        temperature: 0.3,
      });
      const parsed = parseJsonLoose(res.text);
      if (Array.isArray(parsed?.queries)) {
        fromLlm = parsed.queries.filter((q) => typeof q === 'string').map((q) => truncate(q, 200));
      }
    } catch (err) {
      logger?.warn('Query generation fell back to rules', { reason: err.message });
    }
  }
  const queries = dedupeQueries([...fromLlm, ...heuristic], maxQueries);
  logger?.debug('Queries generated', { count: queries.length, queries });
  return queries;
}
