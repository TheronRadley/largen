/**
 * Shared test helpers: config builder, silent logger, and HTML fixtures.
 * No network access is needed by any test.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { silentLogger } from '../src/logger.js';

export { silentLogger };

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

export function deepMerge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch ?? {})) {
    out[k] = isPlainObject(v) && isPlainObject(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

/** Config with no providers configured, a temp data dir, and optional overrides. */
export function makeConfig(overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'largen-test-'));
  return deepMerge(deepMerge(loadConfig({}), { dataDir }), overrides);
}

/** Realistic-looking article HTML with nav, scripts, metadata and JSON-LD date. */
export function articleHtml({ title, paragraphs, published = '2026-06-01T09:00:00Z', author = 'Jane Reviewer' }) {
  const body = paragraphs.map((p) => `<p>${p}</p>`).join('\n');
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<title>${title} | Example</title>
<meta name="description" content="A test page about ${title}">
<meta name="author" content="${author}">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","headline":"${title}","datePublished":"${published}"}</script>
<script>window.trackingTag = "do not read";</script>
<style>.x { color: red; }</style>
</head><body>
<header><a href="/">Home</a> <a href="/menu">Menu</a></header>
<nav><a href="/a">Cookie settings</a><a href="/b">Subscribe</a></nav>
<article>
<h1>${title}</h1>
${body}
</article>
<footer>Copyright Example &copy; 2026</footer>
</body></html>`;
}

export const LAPTOP_PAGES = {
  reviewA: {
    title: 'Budget laptop review: battery life and performance tested',
    url: 'https://www.notebookcheck.net/budget-laptop-review',
    paragraphs: [
      'We tested the budget laptop for university use over several weeks, including word processing, browsing, and spreadsheets.',
      'Battery life on this laptop measured 14 hours in our looping video test at 150 nits brightness.',
      'Performance was adequate for everyday coursework, though heavy multitasking slowed it down noticeably.',
      'Software compatibility is good because the laptop runs Windows 11 and supports most university software.',
      'Our methodology: we ran each test three times and reported the average result.',
    ],
  },
  vendorB: {
    title: 'MacBook Air technical specifications',
    url: 'https://www.apple.com/macbook-air/specs',
    paragraphs: [
      'The MacBook Air specifications list battery life for this laptop as up to 18 hours of Apple TV app video playback.',
      'Apple states these figures come from its own testing under specific conditions.',
      'The laptop is available with configurations that vary in storage and memory.',
      'Compare the models and choose the storage option that suits your coursework and budget.',
    ],
  },
  reviewC: {
    title: 'Budget laptop battery life benchmark results',
    url: 'https://www.rtings.com/laptop/reviews/budget-battery',
    paragraphs: [
      'Battery life on the laptop reached 15 hours in our standardized web browsing benchmark.',
      'We measured each laptop with the same display brightness and Wi-Fi settings to keep the comparison fair.',
      'Results were consistent across three runs, and the methodology is described in detail on this page.',
      'References and data sources are listed at the bottom of the article for transparency.',
    ],
  },
};

/** Blog post that republishes review A word for word (syndication test). */
export function syndicatedCopy() {
  return {
    title: LAPTOP_PAGES.reviewA.title,
    url: 'https://blog.example.net/reposts/budget-laptop',
    paragraphs: LAPTOP_PAGES.reviewA.paragraphs,
  };
}

export function pageHtmlFor(page, published) {
  return articleHtml({ title: page.title, paragraphs: page.paragraphs, published });
}

/** A fetchPage stub that serves the given {url: html} map, failing for unknown URLs. */
export function fakeFetchPage(map, { failWith = null } = {}) {
  return async (url) => {
    if (failWith) throw failWith(url);
    const html = map[url];
    if (html === undefined) {
      const err = new Error(`no fixture for ${url}`);
      err.code = 'not_found';
      throw Object.assign(err, { code: 'not_found' });
    }
    return { url, contentType: 'text/html; charset=utf-8', text: html };
  };
}
