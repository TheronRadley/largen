import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifySourceHost } from '../src/sources/domains.js';
import { scoreSource } from '../src/sources/score.js';
import { canonicalUrl, dedupeResults, markSyndicated } from '../src/sources/dedupe.js';

test('source types follow the domain, with primary sources ranked above community posts', () => {
  assert.equal(classifySourceHost('www.cdc.gov').type, 'government');
  assert.equal(classifySourceHost('mit.edu').type, 'academic');
  assert.equal(classifySourceHost('nature.com').type, 'primary_research');
  assert.equal(classifySourceHost('pubmed.ncbi.nlm.nih.gov').type, 'government');
  assert.equal(classifySourceHost('docs.python.org').type, 'official');
  assert.equal(classifySourceHost('apple.com').type, 'vendor');
  assert.equal(classifySourceHost('apple.com').isPrimary, true);
  assert.equal(classifySourceHost('reddit.com').type, 'community');
  assert.equal(classifySourceHost('random-site.example').type, 'unknown');

  const gov = classifySourceHost('cdc.gov').authority;
  const community = classifySourceHost('reddit.com').authority;
  assert.ok(gov > community, 'government should outrank community');
});

test('scores stay within 0–100 and the breakdown adds up to the total', () => {
  const r = scoreSource({
    url: 'https://www.example.gov/report',
    title: 'Creatine trial results',
    text: 'A randomized controlled trial with 120 participants measured strength gains of 12% over 8 weeks. Methodology is described. Sources are listed.',
    authority: 25,
    publishedAt: '2026-05-01T00:00:00Z',
    author: 'Dr. Rivera',
    queryTerms: ['creatine', 'strength', 'trial'],
    needsRecency: true,
    now: Date.parse('2026-10-08T00:00:00Z'),
  });
  assert.ok(r.total >= 0 && r.total <= 100);
  const sum = Object.values(r.breakdown).reduce((a, b) => a + b, 0);
  assert.equal(sum, r.total);
});

test('evergreen topics are not penalized for old dates', () => {
  const base = {
    url: 'https://example.org/a',
    text: 'Water boils at 100 degrees Celsius at sea level.',
    authority: 15,
    queryTerms: ['water', 'boils'],
    publishedAt: '2011-01-01T00:00:00Z',
    now: Date.parse('2026-10-08T00:00:00Z'),
  };
  assert.equal(scoreSource({ ...base, needsRecency: false }).breakdown.recency, 12);
  assert.equal(scoreSource({ ...base, needsRecency: true }).breakdown.recency, 4);
});

test('recent sources score higher on recency than undated ones for current questions', () => {
  const now = Date.parse('2026-10-08T00:00:00Z');
  const recent = scoreSource({ url: 'https://a.com', text: 'x', authority: 10, publishedAt: '2026-06-01T00:00:00Z', now, needsRecency: true });
  const undated = scoreSource({ url: 'https://a.com', text: 'x', authority: 10, publishedAt: null, now, needsRecency: true });
  assert.ok(recent.breakdown.recency > undated.breakdown.recency);
});

test('quantitative, methodological pages score higher on evidence than thin snippets', () => {
  const rich = scoreSource({
    url: 'https://a.com',
    text: 'The systematic review pooled 14 randomized trials with 2,300 participants. The effect was 4.2% and p < 0.01. Methodology and dataset details are provided.',
    authority: 20,
    queryTerms: ['review'],
    needsRecency: false,
  });
  const thin = scoreSource({ url: 'http://a.com', text: '', snippet: 'A quick take on the topic.', authority: 20, queryTerms: ['review'], needsRecency: false });
  assert.ok(rich.breakdown.evidence > thin.breakdown.evidence);
  assert.ok(rich.breakdown.transparency > thin.breakdown.transparency);
});

test('canonicalUrl removes tracking parameters, fragments, www and trailing slashes', () => {
  const a = canonicalUrl('http://www.Example.com/review/?utm_source=x&id=2#top');
  const b = canonicalUrl('https://example.com/review?id=2');
  assert.equal(a, b);
  assert.equal(canonicalUrl('https://example.com/index.html'), 'https://example.com/');
});

test('dedupeResults keeps one entry per page and records every query that found it', () => {
  const merged = dedupeResults([
    { title: 'A', url: 'https://example.com/a?utm_medium=email', snippet: '', query: 'q1' },
    { title: 'A', url: 'https://www.example.com/a', snippet: 'better snippet', query: 'q2' },
    { title: 'B', url: 'https://example.com/b', snippet: '', query: 'q1' },
  ]);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged[0].foundBy, ['q1', 'q2']);
  assert.equal(merged[0].snippet, 'better snippet');
});

test('syndicated copies are marked and not counted as independent sources', () => {
  const body = Array.from({ length: 40 }, (_, i) => `word${i} shared sentence about battery life and tests`).join(' ');
  const sources = [
    { id: 'S1', title: 'Original review of the laptop', text: body },
    { id: 'S2', title: 'Totally different title here', text: body },
    { id: 'S3', title: 'Unrelated article about cooking pasta', text: 'Boil water, add salt, cook pasta for ten minutes until tender. Drain and serve with sauce.' },
  ];
  markSyndicated(sources);
  assert.equal(sources[0].syndicatedFrom, null);
  assert.equal(sources[1].syndicatedFrom, 'S1');
  assert.equal(sources[2].syndicatedFrom, null);
});
