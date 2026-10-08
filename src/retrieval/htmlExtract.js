/**
 * Dependency-free HTML → text extraction. It is intentionally simple: it drops scripts,
 * styles, navigation and other chrome, prefers <article>/<main>, and pulls out the title,
 * author and publication/update dates when the page declares them.
 */
import { normalizeWhitespace } from '../utils/text.js';

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–',
  rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', hellip: '…', copy: '©', reg: '®',
  trade: '™', euro: '€', pound: '£', yen: '¥', bull: '•',
};

const BOILERPLATE_LINE = /^(cookies?\b|accept (all )?cookies|subscribe\b|sign (in|up)\b|log in\b|share this|skip to (main )?content|menu$|advertisement$|related (articles|posts)\b)/i;

export function decodeEntities(input) {
  return String(input ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === '#') {
      const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

function parseAttrs(tag) {
  const attrs = {};
  for (const m of tag.matchAll(/([a-zA-Z_:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    attrs[m[1].toLowerCase()] = decodeEntities(m[3] ?? m[4] ?? m[5] ?? '');
  }
  return attrs;
}

function collectMeta(html) {
  const map = {};
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const a = parseAttrs(tag);
    const key = (a.property || a.name || a.itemprop || '').toLowerCase();
    if (key && a.content !== undefined && !(key in map)) map[key] = a.content.trim();
  }
  return map;
}

function toIso(value) {
  if (!value) return null;
  const t = Date.parse(String(value).trim());
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** Walk JSON-LD blobs and collect the first headline / dates / author found. */
function collectJsonLd(html) {
  const found = {};
  const visit = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 6) return;
    if (Array.isArray(node)) return node.forEach((n) => visit(n, depth + 1));
    if (node.datePublished && !found.datePublished) found.datePublished = node.datePublished;
    if (node.dateModified && !found.dateModified) found.dateModified = node.dateModified;
    if (node.headline && !found.headline) found.headline = String(node.headline);
    if (node.author && !found.author) {
      const a = Array.isArray(node.author) ? node.author[0] : node.author;
      const name = typeof a === 'string' ? a : a?.name;
      if (name) found.author = String(name);
    }
    for (const value of Object.values(node)) if (typeof value === 'object') visit(value, depth + 1);
  };
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      visit(JSON.parse(m[1]), 0);
    } catch {
      // malformed JSON-LD is common; ignore it
    }
  }
  return found;
}

function selectMainHtml(html) {
  const body = html.match(/<body\b[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? html;
  const main = body.match(/<(article|main)\b[^>]*>([\s\S]*?)<\/\1>/i);
  return main && main[2].length > 400 ? main[2] : body;
}

function htmlToText(fragment) {
  const text = fragment
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|iframe|form|nav|footer|header|aside|button|select|object|embed)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<t[dh]\b[^>]*>/gi, ' | ')
    .replace(/<\/(p|div|section|article|h[1-6]|li|tr|blockquote|pre|table|ul|ol|figure|figcaption)\s*>/gi, '\n')
    .replace(/<(h[1-6]|p|div|tr|section|article|blockquote|table|ul|ol)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(text);
}

/**
 * @param {string} html
 * @returns {{title: string, description: string, author: string|null, publishedAt: string|null, updatedAt: string|null, text: string}}
 */
export function extractHtml(html) {
  const source = String(html ?? '');
  const meta = collectMeta(source);
  const jsonLd = collectJsonLd(source);

  const titleTag = source.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const h1 = source.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
  const title = normalizeWhitespace(decodeEntities((meta['og:title'] || jsonLd.headline || h1 || titleTag || '').replace(/<[^>]+>/g, ' ')));

  const timeTag = source.match(/<time\b[^>]*datetime=["']([^"']+)["']/i)?.[1];
  const publishedAt =
    toIso(meta['article:published_time']) ||
    toIso(meta['og:published_time']) ||
    toIso(jsonLd.datePublished) ||
    toIso(meta['date'] || meta['pubdate'] || meta['publishdate'] || meta['dc.date'] || meta['dc.date.issued']) ||
    toIso(timeTag);
  const updatedAt =
    toIso(meta['article:modified_time']) ||
    toIso(meta['og:updated_time']) ||
    toIso(meta['last-modified']) ||
    toIso(jsonLd.dateModified);

  const author = normalizeWhitespace(meta['author'] || meta['article:author'] || jsonLd.author || '') || null;

  const lines = htmlToText(selectMainHtml(source))
    .split('\n')
    .map((l) => normalizeWhitespace(l))
    .filter((l) => l.length >= 2)
    .filter((l) => !/^[-|•]+$/.test(l))
    .filter((l) => !(l.length < 60 && BOILERPLATE_LINE.test(l)));

  // Drop consecutive duplicate lines that come from repeated widgets.
  const deduped = lines.filter((l, i) => i === 0 || l !== lines[i - 1]);

  return {
    title,
    description: normalizeWhitespace(decodeEntities(meta['description'] || meta['og:description'] || '')),
    author,
    publishedAt,
    updatedAt,
    text: deduped.join('\n'),
  };
}
