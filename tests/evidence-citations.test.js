import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessEvidence } from '../src/evidence/matrix.js';
import { formatAnswer, referencesToText, renumberCitations } from '../src/citations/format.js';

const src = (id, extra = {}) => ({
  id,
  title: `Source ${id}`,
  url: `https://example${id}.org/page`,
  domain: `example${id}.org`,
  type: 'review',
  isPrimary: false,
  quality: 70,
  evidenceLevel: 'page',
  syndicatedFrom: null,
  publishedAt: '2026-06-01T00:00:00Z',
  ...extra,
});

test('three independent good sources with no conflicts give high confidence', () => {
  const sources = [src('S1'), src('S2'), src('S3')];
  const a = assessEvidence({ sources, conflicts: [], requiresCurrent: true, now: Date.parse('2026-10-08T00:00:00Z') });
  assert.equal(a.confidence, 'high');
  assert.equal(a.counts.independent, 3);
});

test('a single source gives low confidence and says why', () => {
  const a = assessEvidence({ sources: [src('S1')], conflicts: [], requiresCurrent: false });
  assert.equal(a.confidence, 'low');
  assert.ok(a.confidenceReasons.length > 0);
});

test('an unresolved disagreement lowers confidence one level', () => {
  const sources = [src('S1'), src('S2'), src('S3')];
  const conflicts = [{ id: 'C1', values: [{ sourceId: 'S1' }, { sourceId: 'S2' }] }];
  const a = assessEvidence({ sources, conflicts, requiresCurrent: false });
  assert.equal(a.confidence, 'medium');
  assert.ok(a.confidenceReasons.some((r) => /disagreement/.test(r)));
});

test('syndicated copies are counted once', () => {
  const sources = [src('S1'), src('S2', { syndicatedFrom: 'S1' }), src('S3', { syndicatedFrom: 'S1' })];
  const a = assessEvidence({ sources, conflicts: [], requiresCurrent: false });
  assert.equal(a.counts.independent, 1);
  assert.equal(a.counts.syndicated, 2);
  assert.notEqual(a.confidence, 'high');
});

test('snippet-only sources do not count as readable evidence', () => {
  const sources = [src('S1', { evidenceLevel: 'snippet' }), src('S2', { evidenceLevel: 'snippet' })];
  const a = assessEvidence({ sources, conflicts: [], requiresCurrent: false });
  assert.equal(a.counts.readable, 0);
  assert.equal(a.confidence, 'low');
});

test('claims citing unknown source ids are flagged as unsupported', () => {
  const sources = [src('S1'), src('S2')];
  const a = assessEvidence({
    sources,
    conflicts: [],
    requiresCurrent: false,
    claims: [
      { text: 'supported', sources: ['S1'], type: 'fact' },
      { text: 'invented', sources: ['S42'], type: 'fact' },
    ],
  });
  assert.equal(a.claims[0].supported, true);
  assert.equal(a.claims[1].supported, false);
  assert.equal(a.unsupportedClaims, 1);
});

test('citations are renumbered in order of first use', () => {
  const sources = [src('S1'), src('S2'), src('S3')];
  const out = renumberCitations('Start [S3] then [S1][S3]. Later [S2].', sources);
  assert.equal(out.markdown, 'Start [1] then [2][1]. Later [3].');
  assert.deepEqual(out.order, ['S3', 'S1', 'S2']);
  assert.equal(out.invalid, 0);
});

test('invented citation ids are removed and counted', () => {
  const sources = [src('S1')];
  const out = renumberCitations('A claim [S1] and a fake one [S9]. Mixed [S1, S7].', sources);
  assert.equal(out.markdown, 'A claim [1] and a fake one. Mixed [1].');
  assert.equal(out.invalid, 2);
});

test('formatAnswer builds references for cited sources and lists the rest as other sources', () => {
  const sources = [
    src('S1', { title: 'First', excerpt: 'x' }),
    src('S2', { title: 'Second' }),
    src('S3', { title: 'Third' }),
  ];
  const formatted = formatAnswer({
    markdown: 'Answer uses the second source first [S2]. Then the first [S1].',
    claims: [{ text: 'claim', type: 'fact', sources: ['S2', 'S1'] }],
    sources,
  });
  assert.equal(formatted.references.length, 2);
  assert.equal(formatted.references[0].number, 1);
  assert.equal(formatted.references[0].sourceId, 'S2');
  assert.equal(formatted.unreferenced.length, 1);
  assert.equal(formatted.unreferenced[0].id, 'S3');
  assert.deepEqual(formatted.claims[0].citations, [1, 2]);
  assert.match(referencesToText(formatted.references), /^\[1\] Second — https:\/\/exampleS2\.org\/page/);
});
