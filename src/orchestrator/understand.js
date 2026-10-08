/**
 * Step 1 of the pipeline: understand the question.
 * Decides whether research is needed, how complex it is, what facets to cover, and which
 * assumptions to state. Uses the LLM when available and falls back to deterministic rules.
 */
import { parseJsonLoose } from '../utils/json.js';
import { normalizeWhitespace, truncate, wordCount } from '../utils/text.js';

const CURRENT_RE = /\b(current(ly)?|latest|today|tonight|this (week|month|year)|right now|recent(ly)?|news|prices?|pricing|costs?|available|availability|releases?|released|versions?|ceo|president|prime minister|laws?|regulations?|rules?|schedule|202[4-9]|2030)\b/i;
const COMPARE_RE = /\b(compare|comparison|vs\.?|versus|better|best|worst|which (one|is|should)|recommend\w*|should i|top \d+|cheapest|safer|safest|worth it|pros and cons)\b/i;
const EVIDENCE_RE = /\b(safe|safety|effective|effectiveness|useful|help\w*|benefits?|good for|bad for|evidence|studies|study|research|proven|causes?|caus\w+|health|side effects?|dose|scientific|true|claims?|statistics?|how many|percent|risks?)\b/i;
const LEGAL_RE = /\b(law|legal|legally|regulation|tax|visa|rights|lawsuit|contract|compliance)\b/i;
const PRODUCT_RE = /\b(laptops?|phones?|cameras?|cars?|tablets?|headphones?|software|apps?|products?|routers?|tvs?|gpus?|cpus?|batter(y|ies)|specs?|models?|computers?)\b/i;
const SCIENCE_RE = /\b(health|medical|drug|supplements?|creatine|vitamins?|nutrition|vaccines?|energy|climate|nuclear|disease|therapy|study|studies)\b/i;
const SIMPLE_RE = /^(what|who|when|where) (is|are|was|were) (the )?[\w\s'-]{1,40}\??$|^(define|what does .{1,30} mean)/i;
const SIMPLE_EXPLAIN_RE = /^(how (does|do|is)|why (does|do|is)|what (causes|is the purpose of))\b/i;
const FOLLOWUP_START_RE = /^(and|also|what about|how about|what else|why|which)\b/i;
const FOLLOWUP_REF_RE = /\b(it|its|they|them|those|these|that|this|about|else|instead|too|also|more|another|other|there)\b/i;

export const UNDERSTAND_SYSTEM = `You are the research planner for Largen, a careful research assistant.
Decide how much research the user's question needs and produce a plan. Return ONLY a JSON object:
{
  "needsResearch": boolean,
  "complexity": "simple" | "moderate" | "complex" | "very_complex",
  "requiresCurrent": boolean,
  "domain": "scientific" | "product" | "legal" | "news" | "general",
  "topic": "short noun phrase naming the subject",
  "standaloneQuestion": "the question rewritten so it makes sense alone, using the conversation for context",
  "facets": ["up to 8 aspects that a good answer must cover"],
  "assumptions": ["assumptions the answer must state, e.g. what 'best' means; empty if none"]
}
Rules:
- Stable, well-known facts (definitions, basic math, established science basics) do not need research.
- Current events, prices, versions, laws, comparisons, recommendations, statistics, health or scientific claims need research.
- Never invent facts in this plan. Keep facets concrete (e.g. "battery life", "repairability").`;

export function isLikelyFollowUp(question, history) {
  if (!history?.length) return false;
  const words = wordCount(question);
  if (words > 12) return false;
  return FOLLOWUP_START_RE.test(question.trim()) || (words <= 8 && FOLLOWUP_REF_RE.test(question));
}

/** Without an LLM, a follow-up is merged with the previous user question so search still has context. */
export function resolveFollowUpHeuristic(question, history) {
  if (!isLikelyFollowUp(question, history)) return question;
  const lastUser = [...history].reverse().find((m) => m.role === 'user')?.content;
  if (!lastUser) return question;
  return `${truncate(lastUser, 300)} (follow-up: ${question.trim()})`;
}

/**
 * Short subject phrase for search: drops the facet clause ("Consider ..."), instruction verbs,
 * and punctuation, then caps the length in words so facet queries still differ from it.
 */
export function topicPhrase(text, maxWords = 8) {
  const firstSentence = String(text ?? '')
    .split(/(?<=[.!?])\s+/)
    .filter((s) => !/^\s*(consider|include|including|focus on|look at|factors?|criteria)\b/i.test(s))[0] ?? String(text ?? '');
  const cleaned = normalizeWhitespace(
    firstSentence
      .replace(/[?!.:]+$/g, '')
      .replace(/^(please\s+)?(compare|explain|tell me|list|give me|find|check|research|summari[sz]e|what are|what is|which is|is|are|can you|could you|how do|how does)\s+/i, '')
  );
  const dangling = new Set(['in', 'for', 'of', 'the', 'a', 'an', 'and', 'or', 'with', 'to', 'on', 'at', 'by', 'from']);
  const words = cleaned.split(' ').slice(0, maxWords);
  while (words.length > 1 && dangling.has(words[words.length - 1].toLowerCase())) words.pop();
  return words.join(' ');
}

function extractFacets(question) {
  const m = question.match(/\b(?:consider|considering|including|factors?|criteria|focus on|look at)\s*:?\s+([^.?!]+)/i);
  if (!m) return [];
  return m[1]
    .split(/,\s*|\s+and\s+|\s+&\s+|\s+or\s+/i)
    .map((s) => normalizeWhitespace(s.replace(/^and\s+/i, '')))
    .filter((s) => s.length >= 3 && s.length <= 60 && wordCount(s) <= 5)
    .slice(0, 8);
}

/**
 * "What about their repairability?" → "repairability". Used when no LLM is available so a
 * follow-up still gets its own facet instead of the generic defaults.
 */
export function followUpFacet(question) {
  const m = String(question ?? '').trim().match(
    /\b(?:what|how) about\s+(?:(?:their|its|the|his|her|this|that|these|those|it)\s+)?([a-z][a-z' -]{2,40}?)\s*[?.!]*$/i
  );
  if (!m) return null;
  const facet = normalizeWhitespace(m[1]).toLowerCase();
  return wordCount(facet) <= 4 ? facet : null;
}

/**
 * Deterministic planner. Conservative: when unsure it chooses research, because the
 * product's main job is to avoid answering current or contested questions from memory.
 */
export function heuristicUnderstand(question, { history = [] } = {}) {
  const q = normalizeWhitespace(question);
  const standalone = resolveFollowUpHeuristic(q, history);
  const words = wordCount(standalone);

  const signals = {
    current: CURRENT_RE.test(standalone),
    compare: COMPARE_RE.test(standalone),
    evidence: EVIDENCE_RE.test(standalone),
    multipart: (standalone.match(/\?/g) ?? []).length > 1 || /\b(consider|including|factors?|criteria|dimensions|aspects)\b/i.test(standalone),
    long: words > 25,
  };
  const score = Object.values(signals).filter(Boolean).length;
  const anySignal = score > 0;

  let needsResearch;
  if (!anySignal && (SIMPLE_RE.test(standalone) || SIMPLE_EXPLAIN_RE.test(standalone) || words <= 8)) {
    needsResearch = false;
  } else if (!anySignal && SIMPLE_EXPLAIN_RE.test(standalone)) {
    needsResearch = false;
  } else {
    needsResearch = true;
  }

  let complexity;
  if (!needsResearch) complexity = 'simple';
  else if (score >= 4 || (signals.multipart && score >= 3)) complexity = 'very_complex';
  else if (score >= 3 || signals.multipart) complexity = 'complex';
  else if (score <= 1 && !signals.compare) complexity = 'simple';
  else complexity = 'moderate';

  const domain = LEGAL_RE.test(standalone)
    ? 'legal'
    : SCIENCE_RE.test(standalone)
      ? 'scientific'
      : PRODUCT_RE.test(standalone)
        ? 'product'
        : signals.current && /\bnews|happened|today|latest\b/i.test(standalone)
          ? 'news'
          : 'general';

  // A follow-up that names an aspect ("What about their repairability?") asks about that aspect,
  // not about the earlier question's list of facets.
  const followUp = isLikelyFollowUp(q, history) ? followUpFacet(q) : null;
  let facets = followUp ? [followUp] : extractFacets(standalone);
  if (!facets.length && signals.compare) {
    facets = domain === 'product'
      ? ['performance', 'price and value', 'independent reviews and tests']
      : ['key differences', 'independent evidence', 'official or primary sources'];
  } else if (!facets.length && domain === 'scientific') {
    facets = ['evidence from systematic reviews or trials', 'safety and side effects', 'limitations and disagreements'];
  } else if (!facets.length && signals.current) {
    facets = ['latest information', 'official announcements'];
  }

  const assumptions = [];
  if (/\b(best|better|suitable|right for me|for me)\b/i.test(standalone) && !/\b(for (a|my|our) |because|budget of|under \$?\d)/i.test(standalone)) {
    assumptions.push('"Best" depends on your priorities. I\'m assuming a general-purpose recommendation unless you say otherwise.');
  }
  if (/\b(safer|safest|safety)\b/i.test(standalone)) {
    assumptions.push('"Safer" depends on the metric (deaths per unit of energy, accidents, pollution, long-term risk), so the answer compares several.');
  }

  return {
    needsResearch,
    complexity,
    requiresCurrent: signals.current,
    domain,
    topic: topicPhrase(standalone) || truncate(standalone, 80),
    standaloneQuestion: standalone,
    facets,
    assumptions,
    signals,
    source: 'heuristic',
  };
}

const COMPLEXITIES = new Set(['simple', 'moderate', 'complex', 'very_complex']);
const DOMAINS = new Set(['scientific', 'product', 'legal', 'news', 'general']);

/** Validate and sanitize a model-produced plan. Returns null if unusable. */
export function normalizePlan(raw, fallbackQuestion) {
  if (!raw || typeof raw !== 'object') return null;
  const strings = (xs, max, maxLen) =>
    (Array.isArray(xs) ? xs : [])
      .filter((x) => typeof x === 'string')
      .map((x) => truncate(x, maxLen))
      .filter(Boolean)
      .slice(0, max);
  const plan = {
    needsResearch: typeof raw.needsResearch === 'boolean' ? raw.needsResearch : undefined,
    complexity: COMPLEXITIES.has(raw.complexity) ? raw.complexity : undefined,
    requiresCurrent: typeof raw.requiresCurrent === 'boolean' ? raw.requiresCurrent : undefined,
    domain: DOMAINS.has(raw.domain) ? raw.domain : undefined,
    topic: typeof raw.topic === 'string' ? truncate(raw.topic, 120) : undefined,
    standaloneQuestion:
      typeof raw.standaloneQuestion === 'string' && raw.standaloneQuestion.trim()
        ? truncate(raw.standaloneQuestion, 600)
        : fallbackQuestion,
    facets: strings(raw.facets, 8, 60),
    assumptions: strings(raw.assumptions, 4, 240),
  };
  if (plan.needsResearch === undefined && plan.complexity === undefined && !plan.facets.length) return null;
  for (const k of Object.keys(plan)) if (plan[k] === undefined) delete plan[k];
  return plan;
}

function buildUnderstandPrompt(question, history) {
  const context = history
    .slice(-4)
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${truncate(m.content, 300)}`)
    .join('\n');
  return [
    context ? `Conversation so far:\n${context}` : 'Conversation so far: (none)',
    `Current user message:\n${question}`,
  ].join('\n\n');
}

/**
 * @returns {Promise<object>} plan (see heuristicUnderstand for the shape)
 */
export async function understandQuestion({ llm, question, history = [], logger }) {
  const heuristic = heuristicUnderstand(question, { history });
  if (!llm) return heuristic;
  try {
    const res = await llm.complete({
      system: UNDERSTAND_SYSTEM,
      messages: [{ role: 'user', content: buildUnderstandPrompt(question, history) }],
      json: true,
      maxTokens: 600,
      temperature: 0,
    });
    const normalized = normalizePlan(parseJsonLoose(res.text), heuristic.standaloneQuestion);
    if (!normalized) throw new Error('planner returned an unusable plan');
    const merged = { ...heuristic, ...normalized, source: 'llm' };
    if (!merged.facets.length) merged.facets = heuristic.facets;
    if (!merged.assumptions.length) merged.assumptions = heuristic.assumptions;
    merged.topic = merged.topic || heuristic.topic;
    return merged;
  } catch (err) {
    logger?.warn('Planner fell back to rules', { reason: err.message });
    return heuristic;
  }
}
