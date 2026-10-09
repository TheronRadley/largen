import test from 'node:test';
import assert from 'node:assert/strict';
import { claimInputs, normalizeClaimGraph, verifyClaims, claimConflicts } from '../src/evidence/claims.js';
import { assessEvidence } from '../src/evidence/matrix.js';
import { synthesizeWithSources } from '../src/synthesis/synthesize.js';
import { makeConfig } from './helpers.js';

const sources = [
  { id: 'S1', domain: 'agency.gov', passage: 'The policy permits remote work for all employees.', evidenceLevel: 'page', quality: 90 },
  { id: 'S2', domain: 'review.org', passage: 'The policy prohibits remote work for all employees.', evidenceLevel: 'page', quality: 80 },
].map((s) => ({ title: s.id, type: 'general', url: `https://${s.domain}`, ...s }));
const text = 'The policy permits remote work for all employees.';
const edge = (i, relation) => ({ sourceId: sources[i].id, relation, quote: sources[i].passage, reason: 'Same policy and employee scope.' });
const raw = { claims: [{ text, edges: [edge(0, 'supports'), edge(1, 'contradicts')] }] };
const graph = () => normalizeClaimGraph(raw, claimInputs(sources), sources);

test('grounded nonnumeric disagreement becomes a contested graph node and conflict', () => {
  const g = graph();
  assert.equal(g.claims[0].status, 'contested');
  assert.equal(claimConflicts(g)[0].values[1].raw, 'contradicts');
  assert.equal(claimConflicts(g)[0].metric, text);
});

test('fabricated quotes, unknown IDs, invalid relations, and duplicate edges cannot add support', () => {
  const g = normalizeClaimGraph({ claims: [{ text, edges: [
    edge(0, 'supports'), edge(0, 'supports'),
    { ...edge(1, 'supports'), quote: 'This quotation does not exist anywhere.' },
    { ...edge(1, 'supports'), sourceId: 'S99' }, edge(1, 'true'),
  ] }] }, claimInputs(sources), sources);
  assert.equal(g.rejectedEdges, 3);
  assert.equal(g.claims[0].edges.length, 1);
  assert.equal(g.claims[0].status, 'single_source');
});

test('same-domain reports do not count as independent corroboration', () => {
  const same = sources.map((s) => ({ ...s, domain: 'agency.gov' }));
  const g = normalizeClaimGraph({ claims: [{ text, edges: [edge(0, 'supports'), edge(1, 'supports')] }] }, claimInputs(same), same);
  assert.equal(g.claims[0].status, 'single_source');
});

test('only readable originals enter the bounded verification input', () => {
  const inputs = claimInputs([...sources, { ...sources[0], id: 'S3', syndicatedFrom: 'S1' },
    { ...sources[0], id: 'S4', evidenceLevel: 'snippet' }], { maxChars: 120, maxPassageChars: 60 });
  assert.equal(inputs.length, 1);
  assert.ok(JSON.stringify(inputs[0]).length <= 120);
});

test('irrelevance or missing valid quotes never creates support', () => {
  for (const edges of [[edge(0, 'irrelevant')], [{ ...edge(0, 'supports'), quote: 'fake quotation text' }]]) {
    const g = normalizeClaimGraph({ claims: [{ text, edges }] }, claimInputs(sources), sources);
    assert.equal(g.claims[0].status, 'unverified');
  }
});

test('provider errors, malformed output, missing AI, and snippets degrade explicitly', async () => {
  const base = { question: text, plan: { facets: [] }, sources, config: makeConfig() };
  for (const llm of [null, { complete: async () => { throw new Error('offline'); } },
    { complete: async () => ({ text: '{"answer":"not a graph"}' }) }]) {
    assert.equal((await verifyClaims({ ...base, llm })).status, 'unavailable');
  }
  assert.equal((await verifyClaims({ ...base, sources: [], llm: {} })).reason, 'no_readable_evidence');
});

test('citation existence does not verify a new or opposing writer claim', () => {
  const result = assessEvidence({ sources, evidenceGraph: graph(), claims: [
    { text, sources: ['S1'], type: 'fact' },
    { text, sources: ['S2'], type: 'fact' },
    { text: 'A different unsupported assertion.', sources: ['S1'], type: 'fact' },
  ] });
  assert.equal(result.claims[0].conflicted, true);
  assert.equal(result.claims[0].confidence, 'low');
  assert.equal(result.claims[1].supported, false);
  assert.equal(result.claims[2].verification, 'unverified');
});

test('verifier output reaches the writer with explicit semantic evidence', async () => {
  const config = makeConfig();
  const g = await verifyClaims({ llm: { complete: async () => ({ text: JSON.stringify(raw) }) },
    question: text, plan: { facets: [] }, sources, config });
  let prompt;
  await synthesizeWithSources({ llm: { complete: async (req) => {
    prompt = req.messages[0].content;
    return { text: '{"answer":"Sources disagree.","claims":[]}' };
  } }, question: text, plan: {}, assessment: assessEvidence({ sources, evidenceGraph: g }),
    evidenceGraph: g, conflicts: claimConflicts(g), sources, config });
  assert.match(prompt, /model-assessed, not proof of truth/);
  assert.match(prompt, /"relation":"contradicts"/);
  assert.match(prompt, /"status":"contested"/);
});
