/**
 * Shared normalization for search results from any provider.
 */
import { parseHttpUrl } from '../retrieval/safeUrl.js';
import { normalizeWhitespace, truncate } from '../utils/text.js';

export function stripTags(html) {
  return normalizeWhitespace(String(html ?? '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'"));
}

export function parseDate(value) {
  if (!value) return null;
  const t = Date.parse(String(value));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/**
 * Returns a clean result or null if it is unusable (bad URL, no title).
 */
export function normalizeResult({ title, url, snippet, publishedAt, provider }) {
  const parsed = parseHttpUrl(url);
  const cleanTitle = truncate(stripTags(title), 200);
  if (!parsed || !cleanTitle) return null;
  return {
    title: cleanTitle,
    url: parsed.href,
    snippet: truncate(stripTags(snippet), 600),
    publishedAt: parseDate(publishedAt),
    provider,
  };
}
