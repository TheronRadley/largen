/**
 * Citation formatting. Internal source IDs (S1, S2, …) written by the model are validated
 * against the sources actually retrieved, then renumbered [1], [2], … in order of first use.
 * Invented IDs are removed, so every citation in the output points at a real retrieved source.
 */

const CITE_GROUP = /\[(S\d+(?:\s*,\s*S\d+)*)\]/g;

/**
 * @param {string} markdown answer text containing [S#] markers
 * @param {Array<{id: string}>} sources retrieved sources (validation set)
 * @returns {{markdown: string, order: string[], invalid: number, numberFor: Map<string, number>}}
 */
export function renumberCitations(markdown, sources) {
  const valid = new Set(sources.map((s) => s.id));
  const order = [];
  const numberFor = new Map();
  let invalid = 0;

  const text = String(markdown ?? '').replace(CITE_GROUP, (_match, inner) => {
    const ids = inner.split(/\s*,\s*/);
    const kept = ids.filter((id) => valid.has(id));
    invalid += ids.length - kept.length;
    if (!kept.length) return '';
    return kept
      .map((id) => {
        if (!numberFor.has(id)) {
          order.push(id);
          numberFor.set(id, order.length);
        }
        return `[${numberFor.get(id)}]`;
      })
      .join('');
  });

  return { markdown: tidy(text), order, invalid, numberFor };
}

function tidy(text) {
  return text
    .replace(/[ \t]+([.,;:!?])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Full formatting step: renumbers the answer and claims, and builds the reference list.
 * Cited sources come first (in citation order); the rest are returned as `unreferenced`.
 */
export function formatAnswer({ markdown, claims = [], sources }) {
  const { markdown: text, order, invalid, numberFor } = renumberCitations(markdown, sources);
  const byId = new Map(sources.map((s) => [s.id, s]));

  const references = order.map((id) => ({ number: numberFor.get(id), sourceId: id, ...publicSource(byId.get(id)) }));
  const unreferenced = sources.filter((s) => !numberFor.has(s.id)).map((s) => publicSource(s));

  const formattedClaims = claims.map((c) => ({
    text: c.text,
    type: c.type,
    citations: c.sources.filter((id) => numberFor.has(id)).map((id) => numberFor.get(id)),
  }));

  return { markdown: text, references, unreferenced, claims: formattedClaims, invalidCitations: invalid };
}

function publicSource(s) {
  if (!s) return null;
  return {
    id: s.id,
    title: s.title,
    url: s.url,
    domain: s.domain,
    type: s.type,
    publishedAt: s.publishedAt ?? null,
    updatedAt: s.updatedAt ?? null,
    quality: s.quality,
    evidenceLevel: s.evidenceLevel,
    syndicatedFrom: s.syndicatedFrom ?? null,
    excerpt: s.excerpt ?? '',
  };
}

/** Plain-text reference list in the form "[1] Title — URL". Useful for copy/paste or export. */
export function referencesToText(references) {
  return references.map((r) => `[${r.number}] ${r.title} — ${r.url}`).join('\n');
}
