/**
 * Contradiction detection for numeric claims.
 *
 * How it works (deliberately simple and explainable):
 *  1. Pull out "number + unit" statements from each source ("18 hours", "14%", "$899").
 *  2. Two statements are about the same thing when they share at least `minShared`
 *     content words, including at least one word from the user's question.
 *  3. If statements with the same unit differ by at least `ratio` (e.g. 18 vs 14 hours),
 *     it becomes a conflict, grouped by unit and shared subject.
 *
 * This flags candidates for the answer writer to explain. It does not decide which
 * number is right.
 */
import { contentTerms, splitSentences, truncate } from '../utils/text.js';

const NUM = '(\\d[\\d,]*(?:\\.\\d+)?)';
const UNITS = [
  { unit: 'percent', re: /(-?\d+(?:[.,]\d+)?)\s?(?:%|percent\b)/gi },
  { unit: 'hours', re: /(\d+(?:[.,]\d+)?)\s?(?:hours?|hrs?)\b/gi },
  { unit: 'years', re: /(\d+(?:[.,]\d+)?)\s?years?\b/gi },
  { unit: 'gigabytes', re: /(\d+(?:[.,]\d+)?)\s?(?:GB|GiB)\b/gi },
  { unit: 'kilograms', re: /(\d+(?:[.,]\d+)?)\s?kg\b/gi },
  { unit: 'usd', re: new RegExp(`(?:US\\$|\\$)\\s?${NUM}|${NUM}\\s?(?:USD|dollars)\\b`, 'gi') },
  { unit: 'eur', re: new RegExp(`€\\s?${NUM}|${NUM}\\s?(?:EUR|euros)\\b`, 'gi') },
  { unit: 'people', re: new RegExp(`${NUM}\\s?(?:deaths|died|people|participants|cases)\\b`, 'gi') },
];

const UNIT_WORDS = new Set([
  'hours', 'hour', 'hrs', 'hr', 'percent', 'years', 'year', 'gb', 'gib', 'kg', 'usd', 'dollars',
  'eur', 'euros', 'people', 'deaths', 'died', 'participants', 'cases',
]);

export function parseNumber(s) {
  let v = String(s).replace(/\s/g, '');
  if (/^\d+,\d{1,2}$/.test(v)) v = v.replace(',', '.');
  else v = v.replace(/,/g, '');
  return Number(v);
}

/**
 * @returns {Array<{unit: string, value: number, raw: string, sentence: string, terms: string[]}>}
 */
export function extractNumericClaims(text, { maxClaims = 300 } = {}) {
  const claims = [];
  for (const sentence of splitSentences(text)) {
    if (sentence.length > 600) continue;
    for (const { unit, re } of UNITS) {
      for (const m of sentence.matchAll(re)) {
        const numStr = m.slice(1).find((g) => g !== undefined);
        if (!numStr) continue;
        const value = parseNumber(numStr);
        if (!Number.isFinite(value) || value < 0) continue;
        const terms = contentTerms(sentence).filter((t) => !UNIT_WORDS.has(t));
        claims.push({ unit, value, raw: m[0], sentence, terms });
        if (claims.length >= maxClaims) return claims;
      }
    }
  }
  return claims;
}

// Words that describe the kind of source rather than the subject, so they make poor labels.
const GENERIC_TERMS = new Set([
  'laptop', 'laptops', 'video', 'review', 'reviews', 'test', 'tests', 'tested', 'testing',
  'measured', 'results', 'model', 'device', 'product', 'playback', 'looping', 'specifications',
]);

/** Up to three words naming the subject: the user's own question terms first. */
function labelTerms(shared, queryset) {
  const useful = shared.filter((t) => !GENERIC_TERMS.has(t));
  const pool = useful.length ? useful : shared;
  const ranked = [...pool].sort((x, y) => Number(queryset.has(y)) - Number(queryset.has(x)));
  return ranked.slice(0, 3);
}

const sharedTerms = (a, b) => {
  const setB = new Set(b);
  return a.filter((t) => setB.has(t));
};

/**
 * @param {{sources: Array<{id: string, title?: string, publishedAt?: string|null, type?: string, text: string}>,
 *          queryTerms?: string[], minShared?: number, ratio?: number, maxConflicts?: number}} input
 */
export function detectConflicts({ sources, queryTerms = [], minShared = 2, ratio = 1.25, maxConflicts = 10 }) {
  const queryset = new Set(queryTerms.map((t) => t.toLowerCase()));
  const claims = [];
  for (const s of sources) {
    if (!s.text) continue;
    for (const c of extractNumericClaims(s.text)) claims.push({ ...c, sourceId: s.id });
  }

  const groups = new Map();
  for (let i = 0; i < claims.length; i++) {
    for (let j = i + 1; j < claims.length; j++) {
      const a = claims[i];
      const b = claims[j];
      if (a.sourceId === b.sourceId || a.unit !== b.unit) continue;
      const shared = sharedTerms(a.terms, b.terms);
      if (shared.length < minShared) continue;
      if (queryset.size && !shared.some((t) => queryset.has(t))) continue;
      const key = `${a.unit}|${[...shared].sort().slice(0, 3).join(',')}`;
      if (!groups.has(key)) groups.set(key, { unit: a.unit, metric: labelTerms(shared, queryset), byValue: new Map() });
      const g = groups.get(key);
      for (const c of [a, b]) {
        if (![...g.byValue.values()].some((v) => v.sourceId === c.sourceId)) {
          g.byValue.set(`${c.sourceId}:${c.value}`, c);
        }
      }
    }
  }

  const sourceById = new Map(sources.map((s) => [s.id, s]));
  const conflicts = [];
  for (const g of groups.values()) {
    const values = [...g.byValue.values()];
    if (values.length < 2) continue;
    const nums = values.map((v) => v.value);
    const hi = Math.max(...nums);
    const lo = Math.min(...nums);
    if (hi === lo) continue;
    const r = lo === 0 ? Infinity : hi / lo;
    if (r < ratio) continue;
    if (g.unit === 'percent' && hi - lo < 2) continue; // 2% vs 3% is noise, not a conflict
    conflicts.push({
      unit: g.unit,
      metric: g.metric.join(' '),
      ratio: Number.isFinite(r) ? Math.round(r * 100) / 100 : null,
      values: values.map((v) => ({
        sourceId: v.sourceId,
        value: v.value,
        raw: v.raw,
        quote: truncate(v.sentence, 240),
      })),
    });
    if (conflicts.length >= maxConflicts) break;
  }

  return conflicts.map((c, i) => ({
    id: `C${i + 1}`,
    ...c,
    explanation: explainConflict(c, sourceById),
  }));
}

/** Human-readable likely reasons. Written as hypotheses, not verdicts. */
export function explainConflict(conflict, sourceById = new Map()) {
  const reasons = [];
  const types = conflict.values.map((v) => sourceById.get(v.sourceId)?.type);
  if (types.includes('vendor') && types.some((t) => t && t !== 'vendor')) {
    reasons.push('one figure appears to come from the manufacturer while others come from independent testing');
  }
  const years = conflict.values
    .map((v) => Date.parse(sourceById.get(v.sourceId)?.publishedAt ?? ''))
    .filter(Number.isFinite)
    .map((t) => new Date(t).getUTCFullYear());
  if (years.length >= 2 && Math.max(...years) - Math.min(...years) >= 1) {
    reasons.push('the sources were published in different years, so one figure may be outdated');
  }
  if (conflict.values.some((v) => /\b(tested|measured|benchmark|test conditions?)\b/i.test(v.quote))) {
    reasons.push('the measurement or test conditions appear to differ');
  }
  if (!reasons.length) {
    reasons.push('the sources may use different configurations, sample sizes, or measurement methods');
  }
  const list = conflict.values.map((v) => `${v.raw} (${v.sourceId})`).join(', ');
  return `Sources report different values for ${conflict.metric || conflict.unit}: ${list}. Likely reasons: ${reasons.join('; ')}.`;
}
