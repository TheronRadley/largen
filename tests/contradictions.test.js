import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectConflicts, extractNumericClaims, parseNumber } from '../src/evidence/contradictions.js';

test('numeric claims with units are extracted', () => {
  const claims = extractNumericClaims(
    'Battery life lasted 18 hours in one test. Discount was 14% this year. The laptop costs $899 new.'
  );
  const units = claims.map((c) => c.unit);
  assert.ok(units.includes('hours'));
  assert.ok(units.includes('percent'));
  assert.ok(units.includes('usd'));
  assert.equal(claims.find((c) => c.unit === 'hours').value, 18);
});

test('numbers with thousands and decimal commas are parsed', () => {
  assert.equal(parseNumber('2,300'), 2300);
  assert.equal(parseNumber('3,5'), 3.5);
  assert.equal(parseNumber('4.2'), 4.2);
});

test('disagreeing battery-life figures are flagged as a conflict and explained', () => {
  const conflicts = detectConflicts({
    queryTerms: ['battery', 'life', 'laptop'],
    sources: [
      {
        id: 'S1',
        type: 'vendor',
        publishedAt: '2026-06-01T00:00:00Z',
        text: 'Battery life on this laptop is up to 18 hours according to the manufacturer.',
      },
      {
        id: 'S2',
        type: 'review',
        publishedAt: '2026-06-01T00:00:00Z',
        text: 'Battery life on this laptop measured 14 hours in our independent tested video loop.',
      },
    ],
  });
  assert.equal(conflicts.length, 1);
  const [c] = conflicts;
  assert.equal(c.unit, 'hours');
  assert.match(c.metric, /battery/);
  assert.deepEqual(c.values.map((v) => v.sourceId).sort(), ['S1', 'S2']);
  assert.ok(c.ratio >= 1.25);
  assert.match(c.explanation, /manufacturer/);
  assert.match(c.explanation, /Likely reasons/);
});

test('close figures are not treated as a conflict', () => {
  const conflicts = detectConflicts({
    queryTerms: ['battery', 'life'],
    sources: [
      { id: 'S1', type: 'review', text: 'Battery life on this laptop is 18 hours in our test.' },
      { id: 'S2', type: 'review', text: 'Battery life on this laptop is 17 hours in our test.' },
    ],
  });
  assert.equal(conflicts.length, 0);
});

test('unrelated numbers in different sources are not compared', () => {
  const conflicts = detectConflicts({
    queryTerms: ['laptop', 'battery'],
    sources: [
      { id: 'S1', type: 'news', text: 'The laptop costs $899 at launch.' },
      { id: 'S2', type: 'news', text: 'The phone battery lasts 14 hours on standby.' },
    ],
  });
  assert.equal(conflicts.length, 0);
});

test('small percentage differences are noise, not conflicts', () => {
  const conflicts = detectConflicts({
    queryTerms: ['students'],
    sources: [
      { id: 'S1', type: 'news', text: 'Survey data show 3% of students own a tablet for coursework.' },
      { id: 'S2', type: 'news', text: 'Survey data show 2% of students own a tablet for coursework.' },
    ],
  });
  assert.equal(conflicts.length, 0);
});

test('the same source never conflicts with itself', () => {
  const conflicts = detectConflicts({
    queryTerms: ['battery'],
    sources: [
      { id: 'S1', type: 'review', text: 'Battery life was 18 hours in the first test. Battery life was 9 hours in the second test.' },
    ],
  });
  assert.equal(conflicts.length, 0);
});
