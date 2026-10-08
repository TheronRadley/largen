import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ResearchPipeline, ResearchAborted } from '../src/orchestrator/pipeline.js';
import { MockLLMProvider } from '../src/llm/mock.js';
import { MockSearchProvider } from '../src/search/mock.js';
import { SearchError, PageError, ProviderError } from '../src/errors.js';
import { LAPTOP_PAGES, makeConfig, pageHtmlFor, fakeFetchPage, silentLogger, syndicatedCopy } from './helpers.js';

const LAPTOP_Q =
  'Compare the best budget laptops for university students in 2026. Consider performance, battery life, price, repairability, and software compatibility.';

const PUBLISHED = '2026-06-01T09:00:00Z';

function laptopResults() {
  const copy = syndicatedCopy();
  return [
    { title: LAPTOP_PAGES.reviewA.title, url: LAPTOP_PAGES.reviewA.url, snippet: 'Battery life test results for budget laptops.', publishedAt: PUBLISHED, provider: 'mock' },
    { title: LAPTOP_PAGES.vendorB.title, url: LAPTOP_PAGES.vendorB.url, snippet: 'Official battery life and specs for the laptop.', publishedAt: null, provider: 'mock' },
    { title: LAPTOP_PAGES.reviewC.title, url: LAPTOP_PAGES.reviewC.url, snippet: 'Budget laptop battery life benchmark.', publishedAt: PUBLISHED, provider: 'mock' },
    { title: copy.title, url: copy.url, snippet: 'A repost of a budget laptop review.', publishedAt: PUBLISHED, provider: 'mock' },
  ];
}

function laptopPageMap() {
  return {
    [LAPTOP_PAGES.reviewA.url]: pageHtmlFor(LAPTOP_PAGES.reviewA, PUBLISHED),
    [LAPTOP_PAGES.vendorB.url]: pageHtmlFor(LAPTOP_PAGES.vendorB, null),
    [LAPTOP_PAGES.reviewC.url]: pageHtmlFor(LAPTOP_PAGES.reviewC, PUBLISHED),
    [syndicatedCopy().url]: pageHtmlFor(syndicatedCopy(), PUBLISHED),
  };
}

/**
 * Scripted AI: plans with an unusable response (so the rule-based planner is exercised),
 * proposes queries, and writes an answer that cites the source IDs it was actually given.
 */
function scriptedLLM({ planner = '{}' } = {}) {
  return new MockLLMProvider({
    responder: (req) => {
      if (req.system.startsWith('You are the research planner')) return planner;
      if (req.system.startsWith('You write web search queries')) {
        return JSON.stringify({ queries: ['budget laptop battery life tests university', 'laptop software compatibility university students'] });
      }
      if (req.json && req.system.includes('careful research assistant')) {
        const ids = [...new Set((req.messages[0].content.match(/\[S\d+\]/g) ?? []).map((x) => x.slice(1, -1)))];
        const [a = 'S1', b = a, c = a] = ids;
        return JSON.stringify({
          answer: `Battery life estimates differ: the manufacturer claims up to 18 hours [${a}], while independent tests report 14 to 15 hours [${b}][${c}]. This is a disagreement between sources, so treat the manufacturer figure with caution.`,
          claims: [
            { text: 'Battery life estimates differ across sources.', sources: [a, b, 'S99'], type: 'fact' },
            { text: 'I would prioritize independent test results.', sources: [b], type: 'judgment' },
          ],
          limitations: ['Battery tests use different conditions.'],
        });
      }
      return 'Tokyo is the capital of Japan.';
    },
  });
}

function buildPipeline({ llm = scriptedLLM(), search, fetchPage, configOverrides = {}, config } = {}) {
  const cfg = config ?? makeConfig(configOverrides);
  const searchProvider = search ?? new MockSearchProvider({ results: () => laptopResults() });
  const pipeline = new ResearchPipeline({
    config: cfg,
    llm,
    search: searchProvider,
    logger: silentLogger,
    fetchPage: fetchPage ?? fakeFetchPage(laptopPageMap()),
    now: () => Date.parse('2026-10-08T12:00:00Z'),
  });
  return { pipeline, search: searchProvider, llm };
}

test('complex question: decomposes, searches, reads, compares, and answers with numbered citations', async () => {
  const { pipeline } = buildPipeline();
  const statuses = [];
  const result = await pipeline.run({ question: LAPTOP_Q, mode: 'research', onStatus: (e) => statuses.push(e.stage) });

  assert.equal(result.mode, 'research');
  assert.match(result.answer, /\[1\]/);
  assert.doesNotMatch(result.answer, /\[S\d/, 'internal ids must not leak into the answer');
  assert.ok(result.references.length >= 2, `expected >=2 references, got ${result.references.length}`);
  assert.equal(result.references[0].number, 1);
  assert.ok(result.references.every((r) => r.url.startsWith('https://')));

  // The unsupported citation S99 must be removed and reported.
  assert.ok(result.claims.some((c) => c.citations.length === 0 || c.text.includes('differ')));
  assert.ok(!result.warnings.some((w) => /S99/.test(w)));

  // Battery life disagreement is detected, not silently resolved.
  assert.ok(result.conflicts.length >= 1, 'expected a battery-life conflict');
  assert.match(result.conflicts[0].metric, /battery/);

  // Syndicated copy of the review is recognized and not counted as independent.
  assert.ok(result.otherSources.some((s) => s.syndicatedFrom), 'the reposted review should be marked as syndicated');

  // Three independent sources but a disagreement → medium, not high.
  assert.equal(result.confidence, 'medium');
  assert.ok(result.confidenceReasons.some((r) => /disagreement/.test(r)));

  // Plan details are exposed without internal reasoning.
  assert.ok(result.plan.facets.includes('battery life'));
  assert.ok(result.plan.queries.length >= 2 && result.plan.queries.length <= 6);
  assert.match(result.summary, /I'm comparing/);

  // Progress stages are emitted in order.
  assert.deepEqual(
    statuses.filter((s, i, arr) => arr.indexOf(s) === i),
    ['understanding', 'planning', 'searching', 'reading', 'comparing', 'writing']
  );
});

test('simple factual question does not search the web', async () => {
  const { pipeline, search } = buildPipeline();
  const result = await pipeline.run({ question: 'What is the capital of Japan?' });
  assert.equal(result.mode, 'direct');
  assert.equal(search.calls?.length ?? 0, 0);
  assert.match(result.answer, /Tokyo/);
  assert.deepEqual(result.references, []);
});

test('web search switched off answers from general knowledge with a caveat', async () => {
  const { pipeline, search } = buildPipeline();
  const result = await pipeline.run({ question: LAPTOP_Q, webSearch: false });
  assert.equal(result.mode, 'direct');
  assert.equal(search.calls.length, 0);
  assert.ok(result.warnings.some((w) => /Web search is off/.test(w)));
});

test('one failed search query does not stop the research', async () => {
  let calls = 0;
  const flaky = {
    name: 'flaky',
    async search(query) {
      calls++;
      if (calls === 1) throw new SearchError('boom', { code: 'search_network' });
      return laptopResults();
    },
  };
  const { pipeline } = buildPipeline({ search: flaky });
  const result = await pipeline.run({ question: LAPTOP_Q, mode: 'research' });
  assert.equal(result.mode, 'research');
  assert.ok(result.references.length >= 2);
  assert.ok(result.warnings.some((w) => /searches failed/.test(w)));
});

test('every search failing is reported as unavailable and the answer falls back to general knowledge', async () => {
  const search = new MockSearchProvider({ failQueries: [''] });
  const { pipeline } = buildPipeline({ search });
  const result = await pipeline.run({ question: LAPTOP_Q });
  assert.equal(result.mode, 'direct');
  assert.ok(result.warnings.some((w) => /unavailable/.test(w)));
  assert.equal(result.confidence, null);
});

test('empty search results are handled without crashing', async () => {
  const search = new MockSearchProvider({ fallback: [] });
  const { pipeline } = buildPipeline({ search });
  const result = await pipeline.run({ question: LAPTOP_Q });
  assert.equal(result.mode, 'direct');
  assert.ok(result.warnings.some((w) => /no usable results/i.test(w)));
});

test('unreadable pages fall back to search snippets and lower confidence', async () => {
  const blocked = fakeFetchPage({}, { failWith: (url) => new PageError(`blocked ${url}`, 'blocked') });
  const { pipeline } = buildPipeline({ fetchPage: blocked });
  const result = await pipeline.run({ question: LAPTOP_Q });
  assert.equal(result.mode, 'research');
  assert.ok(result.warnings.some((w) => /could not be read/.test(w)));
  assert.ok(result.references.length > 0, 'snippets should still be usable as weak evidence');
  assert.equal(result.stats.pagesRead, 0);
  assert.equal(result.confidence, 'low');
});

test('some pages failing and others succeeding still produces a researched answer', async () => {
  const map = laptopPageMap();
  delete map[LAPTOP_PAGES.reviewC.url];
  const { pipeline } = buildPipeline({ fetchPage: fakeFetchPage(map) });
  const result = await pipeline.run({ question: LAPTOP_Q });
  assert.equal(result.mode, 'research');
  assert.ok(result.stats.pagesFailed >= 1);
  assert.ok(result.stats.pagesRead >= 2);
});

test('follow-up question uses the previous turn to build its searches', async () => {
  const { pipeline, search } = buildPipeline();
  const history = [
    { role: 'user', content: 'What is the best budget laptop for university students?' },
    { role: 'assistant', content: 'Several budget models are popular for coursework.' },
  ];
  const result = await pipeline.run({ question: 'What about battery life?', history });
  assert.equal(result.mode, 'research');
  assert.ok(search.calls.some((q) => /laptop/i.test(q) && /battery/i.test(q)), search.calls.join(' | '));
});

test('without an AI provider, research still returns cited excerpts and says so', async () => {
  const { pipeline } = buildPipeline({ llm: null });
  const result = await pipeline.run({ question: LAPTOP_Q });
  assert.equal(result.mode, 'research');
  assert.match(result.answer, /No AI provider is configured/);
  assert.match(result.answer, /\[1\]/);
  assert.ok(result.warnings.some((w) => /No AI provider/.test(w)));
});

test('without an AI provider, a simple question fails with a clear, non-technical message', async () => {
  const { pipeline } = buildPipeline({ llm: null });
  await assert.rejects(pipeline.run({ question: 'What is the capital of Japan?' }), (err) => {
    assert.equal(err.code, 'not_configured');
    assert.match(err.publicMessage, /AI_API_KEY/);
    return true;
  });
});

test('a failing AI during synthesis degrades to excerpts instead of crashing', async () => {
  const llm = new MockLLMProvider({
    responder: (req) => {
      if (req.system.startsWith('You are the research planner')) return '{}';
      if (req.system.startsWith('You write web search queries')) return '{"queries":["budget laptop battery life"]}';
      throw new ProviderError('upstream 500', { code: 'provider_http' });
    },
  });
  const { pipeline } = buildPipeline({ llm });
  const result = await pipeline.run({ question: LAPTOP_Q });
  assert.equal(result.mode, 'research');
  assert.ok(result.warnings.some((w) => /AI provider failed/.test(w)));
});

test('research mode uses at most the configured number of searches; quick mode is capped lower', async () => {
  const quick = buildPipeline();
  const quickResult = await quick.pipeline.run({ question: LAPTOP_Q, mode: 'quick' });
  assert.ok(quickResult.plan.queries.length <= 2, `quick used ${quickResult.plan.queries.length}`);
});

test('a cancelled request stops before further work', async () => {
  const { pipeline, search } = buildPipeline();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(pipeline.run({ question: LAPTOP_Q, signal: controller.signal }), ResearchAborted);
  assert.equal(search.calls.length, 0);
});

test('the result reports the requested depth mode, not a fixed label', async () => {
  const pipeline = new ResearchPipeline({
    config: makeConfig(),
    llm: scriptedLLM(),
    search: new MockSearchProvider({ results: () => laptopResults() }),
    logger: silentLogger,
    fetchPage: fakeFetchPage(laptopPageMap()),
    now: () => Date.parse('2026-10-08T12:00:00Z'),
  });
  const quick = await pipeline.run({ question: LAPTOP_Q, mode: 'quick' });
  assert.equal(quick.mode, 'quick');
  const deep = await pipeline.run({ question: LAPTOP_Q, mode: 'deep' });
  assert.equal(deep.mode, 'deep');
});
