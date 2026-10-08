import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  followUpFacet,
  heuristicUnderstand,
  isLikelyFollowUp,
  normalizePlan,
  resolveFollowUpHeuristic,
  understandQuestion,
} from '../src/orchestrator/understand.js';
import { dedupeQueries, generateQueries, heuristicQueries, queryLimit } from '../src/orchestrator/plan.js';
import { MockLLMProvider } from '../src/llm/mock.js';
import { makeConfig, silentLogger } from './helpers.js';

const LAPTOP_Q =
  'Compare the best budget laptops for university students in 2026. Consider performance, battery life, price, repairability, and software compatibility.';

test('simple factual question needs no research', () => {
  const plan = heuristicUnderstand('What is the capital of Japan?');
  assert.equal(plan.needsResearch, false);
  assert.equal(plan.complexity, 'simple');
});

test('explanatory question is answered directly', () => {
  const plan = heuristicUnderstand('How does photosynthesis work?');
  assert.equal(plan.needsResearch, false);
});

test('current-information question requires research', () => {
  const plan = heuristicUnderstand('What is the latest version of Node.js?');
  assert.equal(plan.needsResearch, true);
  assert.equal(plan.requiresCurrent, true);
});

test('comparison question is complex and extracts the user’s named facets', () => {
  const plan = heuristicUnderstand(LAPTOP_Q);
  assert.equal(plan.needsResearch, true);
  assert.ok(['complex', 'very_complex'].includes(plan.complexity), plan.complexity);
  for (const facet of ['performance', 'battery life', 'price', 'repairability', 'software compatibility']) {
    assert.ok(plan.facets.includes(facet), `missing facet ${facet}: ${plan.facets}`);
  }
  assert.ok(plan.assumptions.some((a) => a.includes('"Best"')), 'should state the meaning of "best" as an assumption');
});

test('scientific question gets scientific domain and evidence-oriented queries', () => {
  const plan = heuristicUnderstand('Is creatine useful for strength training?');
  assert.equal(plan.needsResearch, true);
  assert.equal(plan.domain, 'scientific');
  const queries = heuristicQueries(plan);
  assert.ok(queries.some((q) => q.includes('systematic review')), queries.join(' | '));
  assert.ok(queries.some((q) => q.includes('randomized controlled trial')), queries.join(' | '));
});

test('follow-up question is merged with the previous user question', () => {
  const history = [
    { role: 'user', content: 'What is the best laptop for university?' },
    { role: 'assistant', content: 'Several budget models are popular.' },
  ];
  assert.equal(isLikelyFollowUp('What about battery life?', history), true);
  const standalone = resolveFollowUpHeuristic('What about battery life?', history);
  assert.match(standalone, /best laptop for university/);
  assert.match(standalone, /battery life/);
  const plan = heuristicUnderstand('What about battery life?', { history });
  assert.match(plan.standaloneQuestion, /laptop/);
});

test('a short question without history is not treated as a follow-up', () => {
  assert.equal(isLikelyFollowUp('What about battery life?', []), false);
  assert.equal(resolveFollowUpHeuristic('What about battery life?', []), 'What about battery life?');
});

test('queryLimit respects complexity and the depth mode cap', () => {
  const config = makeConfig();
  assert.equal(queryLimit({ complexity: 'simple', mode: 'deep', config }), 1);
  assert.equal(queryLimit({ complexity: 'moderate', mode: 'research', config }), 3);
  assert.equal(queryLimit({ complexity: 'complex', mode: 'quick', config }), 2);
  assert.equal(queryLimit({ complexity: 'very_complex', mode: 'research', config }), 6);
  assert.equal(queryLimit({ complexity: 'very_complex', mode: 'deep', config }), 10);
});

test('duplicate and near-duplicate queries are removed, but facet variants are kept', () => {
  const out = dedupeQueries([
    'creatine safety long term healthy adults',
    'Creatine Safety, long term healthy adults!',
    'healthy adults creatine safety long term',
    '   ',
    'creatine muscle strength trial randomized',
    'creatine position stand sports nutrition',
  ]);
  assert.deepEqual(out, [
    'creatine safety long term healthy adults',
    'creatine muscle strength trial randomized',
    'creatine position stand sports nutrition',
  ]);
  // Adding one facet to a short topic is a different query and must survive.
  assert.equal(dedupeQueries(['budget laptops for students', 'budget laptops for students battery life']).length, 2);
});

test('dedupeQueries enforces the maximum count', () => {
  const many = Array.from({ length: 20 }, (_, i) => `distinct topic number${i} alpha${i}`);
  assert.equal(dedupeQueries(many, 4).length, 4);
});

test('generateQueries merges LLM queries first, fills with rules, and never exceeds the limit', async () => {
  const plan = heuristicUnderstand(LAPTOP_Q);
  const llm = new MockLLMProvider({
    responder: () => JSON.stringify({ queries: ['budget laptop battery tests university', 'laptop repairability ifixit'] }),
  });
  const queries = await generateQueries({ llm, plan, maxQueries: 4, logger: silentLogger });
  assert.equal(queries.length, 4);
  assert.equal(queries[0], 'budget laptop battery tests university');
  assert.equal(queries[1], 'laptop repairability ifixit');
});

test('generateQueries falls back to rules when the LLM returns garbage', async () => {
  const plan = heuristicUnderstand(LAPTOP_Q);
  const llm = new MockLLMProvider({ responder: () => 'not json at all' });
  const queries = await generateQueries({ llm, plan, maxQueries: 3, logger: silentLogger });
  assert.equal(queries.length, 3);
  assert.ok(queries.every((q) => q.length > 0));
});

test('understandQuestion uses a valid LLM plan', async () => {
  const llm = new MockLLMProvider({
    responder: () =>
      JSON.stringify({
        needsResearch: true,
        complexity: 'moderate',
        requiresCurrent: true,
        domain: 'product',
        topic: 'budget laptops for students',
        standaloneQuestion: 'Which budget laptop is best for university students in 2026?',
        facets: ['battery life', 'price'],
        assumptions: [],
      }),
  });
  const plan = await understandQuestion({ llm, question: 'which one?', history: [], logger: silentLogger });
  assert.equal(plan.source, 'llm');
  assert.equal(plan.complexity, 'moderate');
  assert.deepEqual(plan.facets, ['battery life', 'price']);
});

test('understandQuestion falls back to heuristics on an unusable LLM response', async () => {
  const llm = new MockLLMProvider({ responder: () => '{"unrelated": true}' });
  const plan = await understandQuestion({ llm, question: 'What is the capital of Japan?', history: [], logger: silentLogger });
  assert.equal(plan.source, 'heuristic');
  assert.equal(plan.needsResearch, false);
});

test('normalizePlan drops invalid enum values and returns null for empty input', () => {
  assert.equal(normalizePlan(null, 'q'), null);
  assert.equal(normalizePlan({}, 'q'), null);
  const plan = normalizePlan({ needsResearch: true, complexity: 'huge', facets: ['a', 42, 'battery life'] }, 'q');
  assert.equal(plan.complexity, undefined);
  assert.deepEqual(plan.facets, ['a', 'battery life']);
});

test('a follow-up about one aspect gets its own facet, not the generic defaults', () => {
  const history = [
    { role: 'user', content: LAPTOP_Q },
    { role: 'assistant', content: 'Here is a comparison.' },
  ];
  assert.equal(followUpFacet('What about their repairability?'), 'repairability');
  assert.equal(followUpFacet('How about the price?'), 'price');
  assert.equal(followUpFacet('Compare budget laptops'), null);
  const plan = heuristicUnderstand('What about their repairability?', { history });
  assert.deepEqual(plan.facets, ['repairability']);
});
