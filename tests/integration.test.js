/**
 * End-to-end over real HTTP, with no external network access:
 *   Largen server → SearXNG-compatible search → article pages → OpenAI-compatible model.
 * All "external" services are local fakes started in this file.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/app.js';
import { parseEventBlock } from '../frontend/sse.js';
import { LAPTOP_PAGES, makeConfig, pageHtmlFor, silentLogger } from './helpers.js';

const API_KEY = 'test-key-never-logged';
const PAGES = { '/page/a': LAPTOP_PAGES.reviewA, '/page/b': LAPTOP_PAGES.vendorB, '/page/c': LAPTOP_PAGES.reviewC };

let fake;
let fakeBase;
let fakeRequests;

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function startFake() {
  fakeRequests = [];
  fake = http.createServer(async (req, res) => {
    const url = new URL(req.url, fakeBase);
    fakeRequests.push({ method: req.method, path: url.pathname, auth: req.headers.authorization });

    if (url.pathname === '/search') {
      const results = Object.keys(PAGES).map((p) => ({
        title: PAGES[p].title,
        url: `${fakeBase}${p}`,
        content: 'Battery life and performance of budget laptops for students.',
        publishedDate: '2026-06-01',
      }));
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ query: url.searchParams.get('q'), results }));
    }

    if (PAGES[url.pathname]) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(pageHtmlFor(PAGES[url.pathname], '2026-06-01T09:00:00Z'));
    }

    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const system = body.messages[0].content;
      const user = body.messages.at(-1).content;
      let content;
      if (system.startsWith('You are the research planner')) {
        content = '{}';
      } else if (system.startsWith('You write web search queries')) {
        content = JSON.stringify({ queries: ['budget laptop battery life tests', 'laptop software compatibility students'] });
      } else if (body.response_format && system.includes('careful research assistant')) {
        const ids = [...new Set(user.match(/\[S\d+\]/g) ?? [])].map((x) => x.slice(1, -1));
        content = JSON.stringify({
          answer: `Battery life varies by test. The manufacturer cites up to 18 hours [${ids[0]}], while independent testing finds 14 to 15 hours [${ids[1]}][${ids[2] ?? ids[1]}].`,
          claims: [{ text: 'Battery life varies by test method.', sources: [ids[0], ids[1]], type: 'fact' }],
          limitations: [],
        });
      } else {
        content = 'Tokyo is the capital of Japan.';
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ choices: [{ message: { content } }], usage: {} }));
    }

    res.writeHead(404);
    res.end('not found');
  });
  return new Promise((resolve) => {
    fake.listen(0, '127.0.0.1', () => {
      fakeBase = `http://127.0.0.1:${fake.address().port}`;
      resolve();
    });
  });
}

async function startLargen(overrides) {
  const config = makeConfig({
    ai: { provider: 'openai-compatible', apiKey: API_KEY, baseUrl: `${fakeBase}/v1`, model: 'fake-model', timeoutMs: 5000 },
    search: { provider: 'searxng', apiKey: '', searxngUrl: fakeBase, cacheTtlMs: 0, timeoutMs: 5000 },
    retrieval: { allowPrivateHosts: true, pageTimeoutMs: 3000 },
    ...overrides,
  });
  const app = await createApp({ config, logger: silentLogger });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  return { app, base: `http://127.0.0.1:${app.server.address().port}`, config };
}

async function streamChat(base, message, mode = 'research') {
  const res = await fetch(`${base}/api/chat/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({ message, mode }),
  });
  const text = await res.text();
  const events = text.split('\n\n').map(parseEventBlock).filter(Boolean);
  return { status: res.status, events, text };
}

before(() => startFake());
after(() => new Promise((resolve) => fake.close(resolve)));

test('full research over HTTP: search, read pages, compare, and answer with citations', async () => {
  const { app, base } = await startLargen();
  try {
    const { status, events, text } = await streamChat(
      base,
      'Compare the best budget laptops for university students in 2026. Consider performance, battery life, price, repairability, and software compatibility.'
    );
    assert.equal(status, 200);
    assert.ok(events.some((e) => e.event === 'status' && e.data.stage === 'reading'), 'reading stage should stream');
    const result = events.find((e) => e.event === 'result');
    assert.ok(result, 'expected a result event');
    const msg = result.data.message;
    assert.equal(msg.mode, 'research');
    assert.match(msg.answer, /\[1\]/);
    assert.doesNotMatch(msg.answer, /\[S\d/);
    assert.ok(msg.references.length >= 2);
    assert.ok(msg.references.every((r) => r.url.startsWith(fakeBase)));
    assert.ok(msg.conflicts.length >= 1, 'battery-life disagreement should be detected');
    assert.ok(msg.stats.pagesRead >= 2);

    // The key is sent to the model provider, and never echoed back to the client.
    assert.ok(fakeRequests.some((r) => r.path === '/v1/chat/completions' && r.auth === `Bearer ${API_KEY}`));
    assert.ok(!text.includes(API_KEY));
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
  }
});

test('SSRF guard: with private fetching disabled, local article pages are not read', async () => {
  const { app, base } = await startLargen({ retrieval: { allowPrivateHosts: false, pageTimeoutMs: 3000 } });
  try {
    const pageRequestsBefore = fakeRequests.filter((r) => r.path.startsWith('/page/')).length;
    const { events } = await streamChat(base, 'Is creatine useful for strength training?');
    const result = events.find((e) => e.event === 'result');
    assert.ok(result, 'research should still complete');
    assert.equal(result.data.message.stats.pagesRead, 0);
    assert.ok(result.data.message.warnings.some((w) => /could not be read/.test(w)));
    const pageRequestsAfter = fakeRequests.filter((r) => r.path.startsWith('/page/')).length;
    assert.equal(pageRequestsAfter, pageRequestsBefore, 'no request should reach a blocked local host');
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
  }
});

test('a simple question makes one model call and no search request over HTTP', async () => {
  const { app, base } = await startLargen();
  try {
    const searchesBefore = fakeRequests.filter((r) => r.path === '/search').length;
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'What is the capital of Japan?' }),
    });
    const body = await res.json();
    assert.equal(body.message.mode, 'direct');
    assert.match(body.message.content ?? body.message.answer, /Tokyo/);
    assert.equal(fakeRequests.filter((r) => r.path === '/search').length, searchesBefore);
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
  }
});
