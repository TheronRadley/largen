import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, renderInline, renderMarkdown } from '../frontend/markdown.js';
import { parseEventBlock, readEventStream } from '../frontend/sse.js';
import { TTLCache } from '../src/utils/cache.js';
import { mapLimit, withTimeout, TimeoutError } from '../src/utils/concurrency.js';
import { RateLimiter } from '../src/utils/rateLimit.js';
import { parseJsonLoose } from '../src/utils/json.js';
import { contentTerms, jaccard, shingles, splitSentences, stripControlChars, truncate } from '../src/utils/text.js';

// ── Markdown safety and rendering ────────────────────────────────────────────

test('model or web text cannot inject HTML or script', () => {
  const html = renderMarkdown('Hello <img src=x onerror=alert(1)> <script>alert(1)</script> [click](javascript:alert(1))');
  assert.doesNotMatch(html, /<script/);
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html, /href="javascript/);
  assert.match(html, /&lt;script&gt;/);
});

test('only http and https links become anchors', () => {
  const html = renderMarkdown('See [the report](https://example.gov/report?a=1&b=2) and [bad](ftp://x.y)');
  assert.match(html, /<a href="https:\/\/example\.gov\/report\?a=1&amp;b=2"/);
  assert.doesNotMatch(html, /<a href="ftp/);
});

test('citation markers become anchors that point at the matching source card', () => {
  const html = renderMarkdown('Battery life differs [1][2].', { refPrefix: 'm7' });
  assert.match(html, /href="#ref-m7-1"/);
  assert.match(html, /href="#ref-m7-2"/);
});

test('headings, lists, tables, code blocks and emphasis render', () => {
  const md = [
    '## Verdict',
    'Use **this** and *that*.',
    '',
    '- first',
    '- second',
    '',
    '1. one',
    '2. two',
    '',
    '| Model | Battery |',
    '| --- | --- |',
    '| A | 18 h |',
    '| B | 14 h |',
    '',
    '```js',
    'const x = "<b>";',
    '```',
  ].join('\n');
  const html = renderMarkdown(md);
  assert.match(html, /<h4>Verdict<\/h4>/);
  assert.match(html, /<strong>this<\/strong>/);
  assert.match(html, /<em>that<\/em>/);
  assert.match(html, /<ul><li>first<\/li><li>second<\/li><\/ul>/);
  assert.match(html, /<ol><li>one<\/li><li>two<\/li><\/ol>/);
  assert.match(html, /<table>/);
  assert.match(html, /<td>18 h<\/td>/);
  assert.match(html, /<pre><code class="language-js">const x = &quot;&lt;b&gt;&quot;;<\/code><\/pre>/);
});

test('inline code is not transformed by other rules', () => {
  assert.equal(renderInline('use `**not bold**` here'), 'use <code>**not bold**</code> here');
  assert.equal(escapeHtml('<a href="x">&</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
});

// ── SSE parsing ──────────────────────────────────────────────────────────────

test('SSE blocks are parsed, comments are skipped, and bad JSON is ignored', () => {
  assert.deepEqual(parseEventBlock('event: status\ndata: {"message":"hi"}'), { event: 'status', data: { message: 'hi' } });
  assert.equal(parseEventBlock(': ping'), null);
  assert.equal(parseEventBlock('event: status\ndata: {bad'), null);
});

test('SSE stream reader handles events split across chunks', async () => {
  const encoder = new TextEncoder();
  const chunks = ['event: status\ndata: {"mess', 'age":"one"}\n\nevent: result\ndata: {"ok":true}\n\n'];
  const body = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  const seen = [];
  await readEventStream(body, (evt) => seen.push(evt));
  assert.deepEqual(seen.map((e) => e.event), ['status', 'result']);
  assert.equal(seen[0].data.message, 'one');
});

// ── Utilities ────────────────────────────────────────────────────────────────

test('parseJsonLoose recovers JSON from fences and surrounding prose, and returns null otherwise', () => {
  assert.deepEqual(parseJsonLoose('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonLoose('Here you go: {"a":2} thanks'), { a: 2 });
  assert.equal(parseJsonLoose('no json here'), null);
  assert.equal(parseJsonLoose(42), null);
});

test('TTL cache expires entries and evicts the oldest when full', () => {
  let t = 0;
  const cache = new TTLCache({ ttlMs: 100, maxEntries: 2, now: () => t });
  cache.set('a', 1);
  cache.set('b', 2);
  cache.set('c', 3);
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.get('c'), 3);
  t = 200;
  assert.equal(cache.get('b'), undefined);
});

test('rate limiter allows the limit per window then blocks', () => {
  let t = 0;
  const limiter = new RateLimiter({ limit: 2, windowMs: 1000, now: () => t });
  assert.equal(limiter.hit('ip').allowed, true);
  assert.equal(limiter.hit('ip').allowed, true);
  const blocked = limiter.hit('ip');
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSec >= 1);
  t = 1001;
  assert.equal(limiter.hit('ip').allowed, true);
  assert.equal(new RateLimiter({ limit: 0 }).hit('x').allowed, true, 'limit 0 disables limiting');
});

test('mapLimit preserves order and never exceeds the concurrency limit', async () => {
  let active = 0;
  let peak = 0;
  const out = await mapLimit([1, 2, 3, 4, 5], 2, async (n) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return n * 10;
  });
  assert.deepEqual(out, [10, 20, 30, 40, 50]);
  assert.ok(peak <= 2);
});

test('withTimeout rejects slow promises', async () => {
  await assert.rejects(withTimeout(new Promise((r) => setTimeout(r, 200)), 10, 'slow'), TimeoutError);
  assert.equal(await withTimeout(Promise.resolve('fast'), 100), 'fast');
});

test('text helpers: sentence splitting, truncation, similarity, and control characters', () => {
  assert.deepEqual(splitSentences('First sentence here. Second one? Yes!\nNew line'), ['First sentence here.', 'Second one?', 'Yes!', 'New line']);
  assert.equal(truncate('one two three four five', 12), 'one two thr…');
  assert.equal(jaccard(new Set(['a', 'b']), new Set(['a', 'b'])), 1);
  assert.equal(jaccard(new Set(), new Set(['a'])), 0);
  assert.ok(shingles('the quick brown fox jumps over the lazy dog').size >= 4);
  assert.deepEqual(contentTerms('The battery life of this laptop is 18 hours'), ['battery', 'life', 'laptop', 'hours']);
  assert.equal(stripControlChars('a\u0000b\u0007c\nd'), 'abc\nd');
});
