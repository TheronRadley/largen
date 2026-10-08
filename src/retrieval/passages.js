/**
 * Compresses a full page into the passages most relevant to the research question.
 * Only these passages are sent to the AI, which keeps prompts small and cheap.
 */
import { splitSentences, tokenize, truncate } from '../utils/text.js';

const EVIDENCE_HINT = /\b(study|trial|found|showed|shows|according|measured|tested|data|survey|report|because|however|evidence|results?)\b/i;

/**
 * @param {string} text full extracted page text
 * @param {string[]} queryTerms content terms from the question/facets
 * @returns {{text: string, matchedTerms: string[], lead: boolean}}
 */
export function selectPassages(text, queryTerms, { maxChars = 1200 } = {}) {
  const sentences = splitSentences(text).filter((s) => s.length >= 25 && s.length <= 900);
  if (!sentences.length) return { text: '', matchedTerms: [], lead: false };

  const terms = new Set(queryTerms.map((t) => t.toLowerCase()));
  const scored = sentences.map((s, idx) => {
    const toks = new Set(tokenize(s));
    const matched = [...terms].filter((t) => toks.has(t));
    let score = matched.length * 2;
    if (/\d/.test(s)) score += 0.5;
    if (EVIDENCE_HINT.test(s)) score += 0.5;
    if (idx < 3) score += 0.2;
    return { s, idx, matched, score };
  });

  const hits = scored.filter((x) => x.matched.length > 0);
  const ranked = hits.length
    ? [...hits].sort((a, b) => b.score - a.score || a.idx - b.idx)
    : scored.slice(0, 3); // no overlap: fall back to the opening of the page

  const chosen = [];
  let used = 0;
  for (const item of ranked) {
    if (used + item.s.length > maxChars) continue;
    chosen.push(item);
    used += item.s.length + 1;
    if (used >= maxChars * 0.95) break;
  }
  if (!chosen.length) {
    return { text: truncate(ranked[0].s, maxChars), matchedTerms: ranked[0].matched, lead: hits.length === 0 };
  }

  chosen.sort((a, b) => a.idx - b.idx);
  const matchedTerms = [...new Set(chosen.flatMap((c) => c.matched))];
  return {
    text: chosen.map((c) => c.s).join(' '),
    matchedTerms,
    lead: hits.length === 0,
  };
}
