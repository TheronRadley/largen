/**
 * Internal source quality score (0–100). Components:
 *   authority    0–25  domain/type prior (government, academic, primary research > news > blogs)
 *   relevance    0–25  how much of the question's vocabulary the source covers
 *   recency      0–20  newer is better for time-sensitive questions; neutral for evergreen topics
 *   evidence     0–20  signs of data and methodology (numbers, trials, test setups)
 *   transparency 0–10  HTTPS, named author, dated, cites methods or sources
 * The score is used for ranking and confidence. It is never shown as a truth claim.
 */
import { tokenize } from '../utils/text.js';

const DAY_MS = 86_400_000;
const NUMERIC = /\d+(?:[.,]\d+)?\s?(?:%|percent|hours?|hrs?|kg|mg|gb|tb|ms|km|mph|°c|usd|eur|\$|€|£|years?|deaths|people|participants)/gi;
const METHOD_PATTERNS = [
  /\bsystematic review\b/i,
  /\bmeta-?analys[ie]s\b/i,
  /\brandomi[sz]ed\b/i,
  /\bcontrolled trial\b/i,
  /\bcohort\b/i,
  /\bsample size\b|\bparticipants\b|\bn\s?=\s?\d+/i,
  /\bmethodolog/i,
  /\bbenchmark/i,
  /\bmeasured\b|\btested\b|\bmeasurement/i,
  /\bdataset\b|\bdata shows\b|\bsurvey\b/i,
  /\bp\s?[<=]\s?0?\.\d+/i,
  /\bconfidence interval\b/i,
];
const TRANSPARENCY_PATTERNS = [
  /\bmethodolog|\bhow we test|\bhow we tested|\btest(?:ing)? (?:setup|conditions)\b/i,
  /\breferences\b|\bsources\b|\bbibliography\b/i,
  /\bdata (?:source|from)\b|\bcitation/i,
  /\bupdated\b|\blast (?:updated|reviewed)\b/i,
];

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/**
 * @returns {{total: number, breakdown: {authority: number, relevance: number, recency: number, evidence: number, transparency: number}}}
 */
export function scoreSource({
  url = '',
  title = '',
  text = '',
  snippet = '',
  authority = 10,
  publishedAt = null,
  updatedAt = null,
  author = null,
  queryTerms = [],
  needsRecency = true,
  now = Date.now(),
}) {
  const sample = `${text.slice(0, 12_000)}`;

  // Authority
  const authorityPts = clamp(Math.round(authority), 0, 25);

  // Relevance
  const terms = [...new Set(queryTerms)].slice(0, 12);
  let relevancePts;
  if (!terms.length) {
    relevancePts = 12;
  } else {
    const body = new Set(tokenize(`${title} ${sample} ${snippet}`));
    const titleSet = new Set(tokenize(title));
    const hits = terms.filter((t) => body.has(t)).length;
    const titleHits = terms.filter((t) => titleSet.has(t)).length;
    relevancePts = clamp(Math.round((22 * hits) / terms.length) + Math.min(3, titleHits), 0, 25);
  }

  // Recency
  let recencyPts;
  const dateStr = updatedAt || publishedAt;
  if (!needsRecency) {
    recencyPts = 12; // evergreen topic: do not reward or punish age
  } else if (!dateStr) {
    recencyPts = 6;
  } else {
    const ageDays = (now - Date.parse(dateStr)) / DAY_MS;
    if (ageDays < 0) recencyPts = 18;
    else if (ageDays <= 365) recencyPts = 20;
    else if (ageDays <= 730) recencyPts = 15;
    else if (ageDays <= 1825) recencyPts = 9;
    else recencyPts = 4;
  }

  // Evidence quality
  const numericHits = (sample.match(NUMERIC) ?? []).length;
  const numericPts = Math.min(6, numericHits);
  const methodHits = METHOD_PATTERNS.filter((re) => re.test(sample)).length;
  const methodPts = Math.min(14, Math.round(methodHits * 3.5));
  const evidencePts = clamp(numericPts + methodPts, 0, 20);

  // Transparency
  let transparencyPts = 0;
  if (String(url).startsWith('https://')) transparencyPts += 2;
  if (author) transparencyPts += 2;
  if (publishedAt || updatedAt) transparencyPts += 3;
  transparencyPts += Math.min(3, Math.round(TRANSPARENCY_PATTERNS.filter((re) => re.test(sample)).length * 1.5));
  transparencyPts = clamp(transparencyPts, 0, 10);

  const breakdown = {
    authority: authorityPts,
    relevance: relevancePts,
    recency: recencyPts,
    evidence: evidencePts,
    transparency: transparencyPts,
  };
  const total = authorityPts + relevancePts + recencyPts + evidencePts + transparencyPts;
  return { total: clamp(total, 0, 100), breakdown };
}
