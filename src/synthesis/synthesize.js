/**
 * Step 3: answer synthesis. Builds a compact, budgeted evidence block and asks the AI to
 * write an answer that cites only those sources. Also includes an extractive fallback that
 * works without any AI provider.
 */
import { ProviderError } from '../errors.js';
import { parseJsonLoose } from '../utils/json.js';
import { truncate } from '../utils/text.js';
import { DIRECT_SYSTEM, SYNTHESIS_SYSTEM } from './prompts.js';

/** Recent turns, trimmed. Used only to resolve references like "it" or "that laptop". */
export function formatHistory(history = [], { turns = 4, maxChars = 300 } = {}) {
  const recent = history.slice(-turns * 2);
  if (!recent.length) return '';
  return recent
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${truncate(m.content, maxChars)}`)
    .join('\n');
}

/**
 * Builds the sources section of the prompt, stopping at the character budget.
 * Returns the block and the IDs that were actually included.
 */
export function buildEvidenceBlock(sources, { maxChars = 12_000, maxPassageChars = 1200 } = {}) {
  const parts = [];
  const included = [];
  let used = 0;
  for (const s of sources) {
    const excerpt = truncate(s.passage || s.snippet || '', maxPassageChars);
    if (!excerpt) continue;
    const meta = [
      s.domain,
      s.type.replace('_', ' '),
      s.publishedAt ? `published ${s.publishedAt.slice(0, 10)}` : 'date unknown',
      s.evidenceLevel === 'snippet' ? 'search snippet only' : 'full page read',
      s.syndicatedFrom ? `repeats ${s.syndicatedFrom}` : null,
    ]
      .filter(Boolean)
      .join(', ');
    const block = `[${s.id}] ${s.title}\n(${meta})\nURL: ${s.url}\nExcerpt: ${excerpt}`;
    if (used + block.length > maxChars && included.length > 0) break;
    parts.push(block);
    included.push(s.id);
    used += block.length;
  }
  return { block: parts.join('\n\n'), included };
}

function buildSynthesisPrompt({ question, plan, assessment, conflicts, evidenceBlock, history }) {
  const lines = [];
  const historyText = formatHistory(history);
  if (historyText) lines.push(`Conversation context (for resolving references only; not sources):\n${historyText}`);
  lines.push(`User question:\n${question}`);
  if (plan?.standaloneQuestion && plan.standaloneQuestion !== question) {
    lines.push(`Standalone version of the question:\n${plan.standaloneQuestion}`);
  }
  if (plan?.facets?.length) lines.push(`Aspects to cover where the sources allow: ${plan.facets.join('; ')}`);
  if (plan?.assumptions?.length) lines.push(`Assumptions to state:\n- ${plan.assumptions.join('\n- ')}`);
  lines.push(`Evidence confidence (computed from source counts and quality): ${assessment.confidence}\n- ${assessment.confidenceReasons.join('\n- ')}`);
  if (conflicts.length) {
    lines.push(`Detected disagreements between sources (explain these; do not hide them):\n${conflicts.map((c) => `- ${c.explanation}`).join('\n')}`);
  }
  lines.push(`Sources:\n\n${evidenceBlock}`);
  return lines.join('\n\n');
}

/**
 * Writes the answer from the evidence. Returns { answer, claims, limitations, structured }.
 */
export async function synthesizeWithSources({ llm, question, plan, assessment, conflicts = [], sources, history = [], config, logger }) {
  // Syndicated copies repeat an original source; the model should only see the original.
  const independent = sources.filter((s) => !s.syndicatedFrom);
  const { block, included } = buildEvidenceBlock(independent, {
    maxChars: config.research.maxEvidenceChars,
    maxPassageChars: config.research.maxPassageChars,
  });
  const prompt = buildSynthesisPrompt({ question, plan, assessment, conflicts, evidenceBlock: block, history });
  logger?.debug('Synthesis prompt built', { sources: included.length, promptChars: prompt.length });

  const res = await llm.complete({
    system: SYNTHESIS_SYSTEM,
    messages: [{ role: 'user', content: prompt }],
    json: true,
    maxTokens: config.ai.maxOutputTokens,
    temperature: 0.2,
  });

  const parsed = parseJsonLoose(res.text);
  if (parsed && typeof parsed.answer === 'string' && parsed.answer.trim()) {
    return {
      answer: parsed.answer.trim(),
      claims: Array.isArray(parsed.claims)
        ? parsed.claims
            .filter((c) => c && typeof c.text === 'string')
            .map((c) => ({
              text: truncate(c.text, 300),
              sources: Array.isArray(c.sources) ? c.sources.filter((x) => typeof x === 'string') : [],
              type: c.type === 'judgment' ? 'judgment' : 'fact',
            }))
        : [],
      limitations: Array.isArray(parsed.limitations)
        ? parsed.limitations.filter((x) => typeof x === 'string').map((x) => truncate(x, 240)).slice(0, 5)
        : [],
      structured: true,
    };
  }

  // The model ignored the JSON format. Use its text as the answer but do not pretend
  // there is a structured claim list.
  const text = res.text.replace(/```(json)?/gi, '').trim();
  if (!text) throw new ProviderError('AI returned an empty answer', { code: 'provider_malformed' });
  logger?.warn('Synthesis returned non-JSON; using raw text');
  return { answer: text, claims: [], limitations: [], structured: false };
}

/** Plain answer for questions that do not need web research. */
export async function answerDirectly({ llm, question, history = [], config }) {
  const context = formatHistory(history);
  const content = context ? `Conversation context:\n${context}\n\nQuestion:\n${question}` : question;
  const res = await llm.complete({
    system: DIRECT_SYSTEM,
    messages: [{ role: 'user', content }],
    json: false,
    maxTokens: config.ai.maxOutputTokens,
    temperature: 0.3,
  });
  const text = res.text.trim();
  if (!text) throw new ProviderError('AI returned an empty answer', { code: 'provider_malformed' });
  return text;
}

/**
 * Works without an AI provider: shows the most relevant excerpts with citations and says so.
 */
export function extractiveAnswer({ sources, plan }) {
  const usable = sources.filter((s) => s.passage && !s.syndicatedFrom).slice(0, 5);
  if (!usable.length) return { answer: '', claims: [], limitations: [] };
  const lines = [
    'No AI provider is configured, so this is not a synthesized answer. These are the most relevant excerpts from the sources I read:',
    '',
  ];
  const claims = [];
  for (const s of usable) {
    const excerpt = truncate(s.passage, 360);
    lines.push(`- **${s.title}** [${s.id}]: ${excerpt}`);
    claims.push({ text: excerpt, sources: [s.id], type: 'fact' });
  }
  if (plan?.assumptions?.length) lines.push('', `Assumptions: ${plan.assumptions.join(' ')}`);
  return { answer: lines.join('\n'), claims, limitations: ['Excerpts were not synthesized by an AI model.'] };
}
