/**
 * Source deduplication:
 *  - canonicalUrl / dedupeResults: the same page reached through different URLs
 *  - markSyndicated: different URLs that carry the same article text (wire copy, reposts)
 *    so that they count as one independent voice, not several.
 */
import { jaccard, normalizeQueryKey, shingles } from '../utils/text.js';

const TRACKING_PARAM = /^(utm_[a-z]+|fbclid|gclid|mc_cid|mc_eid|igshid|ref|ref_src|source|campaign)$/i;

export function canonicalUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return String(raw ?? '');
  }
  u.hash = '';
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
  for (const key of [...u.searchParams.keys()]) {
    if (TRACKING_PARAM.test(key)) u.searchParams.delete(key);
  }
  u.searchParams.sort();
  let path = u.pathname.replace(/\/index\.(html?|php|aspx?)$/i, '/').replace(/\/+$/, '');
  if (!path) path = '/';
  const port = u.port && !['80', '443'].includes(u.port) ? `:${u.port}` : '';
  const query = u.searchParams.toString() ? `?${u.searchParams.toString()}` : '';
  return `https://${u.hostname}${port}${path}${query}`;
}

/**
 * Merge results that point to the same canonical URL. Keeps the first occurrence and records
 * every query that found it in `foundBy`.
 */
export function dedupeResults(results) {
  const byKey = new Map();
  for (const r of results) {
    const key = canonicalUrl(r.url);
    const existing = byKey.get(key);
    if (existing) {
      if (r.query && !existing.foundBy.includes(r.query)) existing.foundBy.push(r.query);
      if (!existing.snippet && r.snippet) existing.snippet = r.snippet;
      continue;
    }
    byKey.set(key, { ...r, canonical: key, foundBy: r.query ? [r.query] : [] });
  }
  return [...byKey.values()];
}

/**
 * Walks sources in priority order (best first). A source whose text (or title) matches an
 * earlier, higher-priority source is marked `syndicatedFrom` = that source's id.
 * Sources must have { id, title, text }.
 */
export function markSyndicated(sources, { threshold = 0.6 } = {}) {
  const originals = [];
  for (const s of sources) {
    s.syndicatedFrom = null;
    const normTitle = normalizeQueryKey(s.title ?? '');
    const sig = s.text ? shingles(s.text) : null;
    for (const o of originals) {
      const sameTitle = normTitle.length > 20 && normTitle === o.normTitle;
      const similar = sig && o.sig && jaccard(sig, o.sig) >= threshold;
      if (sameTitle || similar) {
        s.syndicatedFrom = o.id;
        break;
      }
    }
    if (!s.syndicatedFrom) originals.push({ id: s.id, normTitle, sig });
  }
  return sources;
}
