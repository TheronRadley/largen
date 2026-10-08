import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractHtml, decodeEntities } from '../src/retrieval/htmlExtract.js';
import { selectPassages } from '../src/retrieval/passages.js';
import { assertPublicHost, isPrivateIp, parseHttpUrl } from '../src/retrieval/safeUrl.js';
import { fetchPage } from '../src/retrieval/fetchPage.js';
import { PageError } from '../src/errors.js';
import { articleHtml } from './helpers.js';

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

test('extraction keeps article text and drops scripts, styles, navigation and footers', () => {
  const html = articleHtml({
    title: 'Creatine and strength',
    paragraphs: [
      'A systematic review of 22 randomized trials found that creatine increased strength gains in resistance training.',
      'Participants in the included studies were healthy adults who trained for eight weeks or longer.',
    ],
  });
  const doc = extractHtml(html);
  assert.equal(doc.title, 'Creatine and strength');
  assert.match(doc.text, /systematic review of 22 randomized trials/);
  assert.doesNotMatch(doc.text, /trackingTag|color: red|Cookie settings|Copyright/);
  assert.equal(doc.author, 'Jane Reviewer');
  assert.equal(doc.publishedAt, '2026-06-01T09:00:00.000Z');
});

test('dates come from meta tags or JSON-LD, and missing dates stay null', () => {
  const withMeta = extractHtml('<html><head><meta property="article:published_time" content="2025-02-03T10:00:00Z"><title>T</title></head><body><p>text</p></body></html>');
  assert.equal(withMeta.publishedAt, '2025-02-03T10:00:00.000Z');
  const none = extractHtml('<html><head><title>T</title></head><body><p>text</p></body></html>');
  assert.equal(none.publishedAt, null);
});

test('HTML entities are decoded, including numeric ones', () => {
  assert.equal(decodeEntities('Tom &amp; Jerry &#8217;s &#x41;'), 'Tom & Jerry ’s A');
  assert.equal(decodeEntities('&lt;script&gt;'), '<script>');
});

test('passage selection prefers sentences that mention the query terms and respects the budget', () => {
  const text = [
    'The page begins with a long introduction about the history of the company and its founders.',
    'Battery life on the laptop reached 15 hours in our standardized browsing benchmark.',
    'Unrelated footer text about newsletters and social media follows here for a while.',
    'Shipping costs vary by region and are calculated at checkout for each order placed online.',
  ].join('\n');
  const { text: passage, matchedTerms } = selectPassages(text, ['battery', 'life', 'laptop'], { maxChars: 200 });
  assert.match(passage, /Battery life on the laptop/);
  assert.ok(passage.length <= 200);
  assert.ok(matchedTerms.includes('battery'));
});

test('passage selection falls back to the opening text when nothing matches', () => {
  const { text, lead } = selectPassages('The opening sentence of this page is long enough to be useful. Another sentence follows.', ['quantum'], {});
  assert.equal(lead, true);
  assert.match(text, /opening sentence/);
});

test('only http and https URLs with no embedded credentials are accepted', () => {
  assert.ok(parseHttpUrl('https://example.com/a'));
  assert.equal(parseHttpUrl('javascript:alert(1)'), null);
  assert.equal(parseHttpUrl('file:///etc/passwd'), null);
  assert.equal(parseHttpUrl('ftp://example.com/file'), null);
  assert.equal(parseHttpUrl('https://user:pass@example.com/'), null);
  assert.equal(parseHttpUrl('not a url'), null);
});

test('private, loopback, link-local and metadata addresses are recognized', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.5', '172.16.9.9', '169.254.169.254', '100.64.1.1', '::1', 'fe80::1', 'fd00::5', '::ffff:10.0.0.1']) {
    assert.equal(isPrivateIp(ip), true, `${ip} should be private`);
  }
  for (const ip of ['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111']) {
    assert.equal(isPrivateIp(ip), false, `${ip} should be public`);
  }
});

test('assertPublicHost blocks localhost and hostnames that resolve to private addresses', async () => {
  await assert.rejects(assertPublicHost('localhost', { lookup: publicLookup }), PageError);
  await assert.rejects(assertPublicHost('127.0.0.1', { lookup: publicLookup }), PageError);
  await assert.rejects(
    assertPublicHost('internal.example.com', { lookup: async () => [{ address: '10.0.0.7', family: 4 }] }),
    (e) => e.code === 'blocked_host'
  );
  await assertPublicHost('news.example.com', { lookup: publicLookup });
});

test('fetchPage refuses private hosts without making a request', async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    return new Response('x');
  };
  await assert.rejects(fetchPage('http://127.0.0.1:8080/admin', { fetchImpl, lookup: publicLookup }), (e) => e.code === 'blocked_host');
  assert.equal(called, false);
});

test('fetchPage re-checks each redirect and blocks a redirect into a private network', async () => {
  const fetchImpl = async (url) => {
    if (String(url).startsWith('https://public.example.com')) {
      return new Response(null, { status: 302, headers: { location: 'http://10.0.0.5/secret' } });
    }
    throw new Error('should not be reached');
  };
  await assert.rejects(
    fetchPage('https://public.example.com/start', { fetchImpl, lookup: publicLookup }),
    (e) => e.code === 'blocked_host'
  );
});

test('fetchPage rejects unsupported content types and reports HTTP failures by code', async () => {
  const pdf = async () => new Response('%PDF', { status: 200, headers: { 'content-type': 'application/pdf' } });
  await assert.rejects(fetchPage('https://example.com/a.pdf', { fetchImpl: pdf, lookup: publicLookup }), (e) => e.code === 'unsupported_type');
  const missing = async () => new Response('nope', { status: 404, headers: { 'content-type': 'text/html' } });
  await assert.rejects(fetchPage('https://example.com/gone', { fetchImpl: missing, lookup: publicLookup }), (e) => e.code === 'not_found');
  const forbidden = async () => new Response('no', { status: 403, headers: { 'content-type': 'text/html' } });
  await assert.rejects(fetchPage('https://example.com/x', { fetchImpl: forbidden, lookup: publicLookup }), (e) => e.code === 'blocked');
});

test('fetchPage stops reading after the byte limit and marks the result truncated', async () => {
  const big = 'a'.repeat(50_000);
  const fetchImpl = async () => new Response(big, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  const page = await fetchPage('https://example.com/big', { fetchImpl, lookup: publicLookup, maxBytes: 10_000 });
  assert.equal(page.truncated, true);
  assert.ok(page.text.length <= 10_000);
});
