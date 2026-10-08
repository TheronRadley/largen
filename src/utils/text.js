/**
 * Text helpers shared by query planning, extraction, scoring and contradiction checks.
 */

const STOPWORDS = new Set(
  (
    'a an the and or but if then else of to in on at by for with from as is are was were be been being am ' +
    'do does did doing have has had having it its it\'s this that these those there here what which who whom ' +
    'whose when where why how i me my we our you your he she they them their not no yes can could should would ' +
    'will shall may might must about into over under than so such very just also more most less least any all ' +
    'each both few some other another own same only too s t don\'t isn\'t aren\'t vs versus please tell give show ' +
    'list explain consider compare'
  ).split(/\s+/)
);

export function normalizeWhitespace(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/** Lowercased word tokens without stopwords. Accents are folded. */
export function tokenize(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/** Distinct content terms (no pure numbers), in first-seen order. */
export function contentTerms(text, limit = 25) {
  const seen = new Set();
  for (const t of tokenize(text)) {
    if (/^\d+$/.test(t)) continue;
    seen.add(t);
    if (seen.size >= limit) break;
  }
  return [...seen];
}

/** Key used to detect duplicate queries: lowercase, punctuation removed, whitespace collapsed. */
export function normalizeQueryKey(text) {
  return normalizeWhitespace(String(text ?? '').toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, ' '));
}

/** Split text into sentence-like units. Keeps line breaks as boundaries. */
export function splitSentences(text) {
  return String(text ?? '')
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+(?=[\p{Lu}\p{N}"“'(\[])/u))
    .map(normalizeWhitespace)
    .filter(Boolean);
}

export function truncate(text, max) {
  const t = normalizeWhitespace(text);
  if (t.length <= max) return t;
  const cut = t.slice(0, Math.max(0, max - 1));
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (large.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Word k-grams used for near-duplicate detection between documents. */
export function shingles(text, k = 5, max = 400) {
  const words = normalizeQueryKey(text).split(' ').filter(Boolean);
  const set = new Set();
  for (let i = 0; i + k <= words.length && set.size < max; i++) {
    set.add(words.slice(i, i + k).join(' '));
  }
  return set;
}

export function hostnameOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return '';
  }
}

export function wordCount(text) {
  return normalizeWhitespace(text).split(' ').filter(Boolean).length;
}

/** Remove control characters (except newline/tab) that should never reach prompts or logs. */
export function stripControlChars(text) {
  return String(text ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}
