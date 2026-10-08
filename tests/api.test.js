import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { MockLLMProvider } from '../src/llm/mock.js';
import { MockSearchProvider } from '../src/search/mock.js';
import { parseEventBlock } from '../frontend/sse.js';
import { makeConfig, silentLogger, fakeFetchPage, LAPTOP_PAGES, pageHtmlFor } from './helpers.js';

const SECRET = 'sk-test-DO-NOT-LEAK-123';

let server;
let base;
let config;

async function start(overrides = {}) {
  config = makeConfig({
    ai: { provider: 'mock', apiKey: SECRET },
    search: { provider: 'mock', apiKey: 'search-secret-xyz' },
    ...overrides,
  });
  const llm = new MockLLMProvider({ responder: () => 'Tokyo is the capital of Japan.' });
  const search = new MockSearchProvider({
    results: () => [
      { title: LAPTOP_PAGES.reviewA.title, url: LAPTOP_PAGES.reviewA.url, snippet: 'battery life', publishedAt: null, provider: 'mock' },
    ],
  });
  const fetchPage = fakeFetchPage({ [LAPTOP_PAGES.reviewA.url]: pageHtmlFor(LAPTOP_PAGES.reviewA, '2026-06-01T00:00:00Z') });
  const app = await createApp({ config, logger: silentLogger, llm, search, fetchPage });
  server = app.server;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  base = `http://127.0.0.1:${port}`;
}

async function stop() {
  if (server) await new Promise((resolve) => server.close(resolve));
  server = null;
}

const json = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

before(() => start());
after(() => stop());

test('health reports configuration status without leaking secrets', async () => {
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 200);
  const text = await res.text();
  const body = JSON.parse(text);
  assert.equal(body.ok, true);
  assert.equal(body.ai.configured, true);
  assert.equal(body.search.configured, true);
  assert.ok(!text.includes(SECRET), 'API key must never appear in responses');
  assert.ok(!text.includes('search-secret-xyz'), 'search key must never appear in responses');
});

test('security headers are set on every response', async () => {
  const res = await fetch(`${base}/`);
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
});

test('the frontend is served and static paths cannot escape the frontend folder', async () => {
  const index = await fetch(`${base}/`);
  assert.equal(index.status, 200);
  assert.match(await index.text(), /Largen/);
  assert.equal((await fetch(`${base}/app.js`)).status, 200);
  assert.equal((await fetch(`${base}/missing.js`)).status, 404);
  assert.equal((await fetch(`${base}/..%2fpackage.json`)).status, 404);
  assert.equal((await fetch(`${base}/%2e%2e/package.json`)).status, 404);
  assert.equal((await fetch(`${base}/%2e%2e%2f%2e%2e%2fpackage.json`)).status, 404);
  assert.equal((await fetch(`${base}/api/unknown`)).status, 404);
});

test('an empty or missing question is rejected with a friendly message', async () => {
  const res = await fetch(`${base}/api/chat`, json({ message: '   ' }));
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error.code, 'invalid_input');
  assert.match(body.error.message, /question/i);
});

test('an overlong question is rejected', async () => {
  const res = await fetch(`${base}/api/chat`, json({ message: 'x'.repeat(2500) }));
  assert.equal(res.status, 400);
  assert.match((await res.json()).error.message, /2000/);
});

test('invalid mode, webSearch, and conversation ids are rejected', async () => {
  assert.equal((await fetch(`${base}/api/chat`, json({ message: 'hi', mode: 'turbo' }))).status, 400);
  assert.equal((await fetch(`${base}/api/chat`, json({ message: 'hi', webSearch: 'yes' }))).status, 400);
  assert.equal((await fetch(`${base}/api/chat`, json({ message: 'hi', conversationId: '../../etc' }))).status, 400);
});

test('malformed JSON is rejected', async () => {
  const res = await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' });
  assert.equal(res.status, 400);
});

test('a simple question returns a direct answer through the JSON endpoint', async () => {
  const res = await fetch(`${base}/api/chat`, json({ message: 'What is the capital of Japan?', mode: 'research' }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.conversationId);
  assert.equal(body.message.role, 'assistant');
  assert.equal(body.message.mode, 'direct');
  assert.match(body.message.content ?? body.message.answer, /Tokyo/);
});

test('the streaming endpoint sends status events followed by a result', async () => {
  const res = await fetch(`${base}/api/chat/stream`, {
    ...json({ message: 'Is creatine useful for strength training?', mode: 'quick' }),
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const text = await res.text();
  const events = text.split('\n\n').map(parseEventBlock).filter(Boolean);
  assert.ok(events.some((e) => e.event === 'status'), 'expected status events');
  const result = events.find((e) => e.event === 'result');
  assert.ok(result, `expected a result event, got ${events.map((e) => e.event).join(',')}`);
  assert.ok(result.data.conversationId);
  assert.ok(result.data.message.answer);
});

test('a question with no conversation id creates a conversation, and follow-ups reuse it', async () => {
  const first = await (await fetch(`${base}/api/chat`, json({ message: 'What is the capital of Japan?' }))).json();
  const id = first.conversationId;
  const second = await (await fetch(`${base}/api/chat`, json({ message: 'And of France?', conversationId: id }))).json();
  assert.equal(second.conversationId, id);

  const conv = await (await fetch(`${base}/api/conversations/${id}`)).json();
  assert.equal(conv.conversation.messages.length, 4);
  assert.equal(conv.conversation.messages[0].role, 'user');
});

test('conversations can be listed, renamed and deleted', async () => {
  const created = await (await fetch(`${base}/api/conversations`, json({ title: 'My research' }))).json();
  const id = created.conversation.id;
  let list = await (await fetch(`${base}/api/conversations`)).json();
  assert.ok(list.conversations.some((c) => c.id === id));

  const renamed = await fetch(`${base}/api/conversations/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Renamed' }) });
  assert.equal((await renamed.json()).conversation.title, 'Renamed');

  assert.equal((await fetch(`${base}/api/conversations/${id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await fetch(`${base}/api/conversations/${id}`)).status, 404);
  list = await (await fetch(`${base}/api/conversations`)).json();
  assert.ok(!list.conversations.some((c) => c.id === id));
});

test('a conversation id that does not exist is reported as not found on chat', async () => {
  const res = await fetch(`${base}/api/chat`, json({ message: 'hi', conversationId: '00000000-0000-4000-8000-000000000000' }));
  assert.equal(res.status, 404);
});

test('oversized request bodies are rejected', async () => {
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'x'.repeat(70_000) }),
  });
  assert.equal(res.status, 413);
});

test('per-client rate limiting returns 429 with Retry-After', async () => {
  const cfg = { ...config, limits: { ...config.limits, rateLimitPerMinute: 2 } };
  const llm = new MockLLMProvider({ responder: () => 'ok' });
  const app = await createApp({ config: cfg, logger: silentLogger, llm, search: null, fetchPage: fakeFetchPage({}) });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${app.server.address().port}/api/chat`;
  try {
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await fetch(url, json({ message: 'What is 2 plus 2?' }))).status);
    assert.deepEqual(statuses, [200, 200, 429]);
    const last = await fetch(url, json({ message: 'hi' }));
    assert.ok(last.headers.get('retry-after'));
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
  }
});

test('the server reports missing AI configuration without leaking details', async () => {
  const cfg = makeConfig({ ai: { provider: 'none', apiKey: '' }, search: { provider: 'none', apiKey: '' } });
  const app = await createApp({ config: cfg, logger: silentLogger, llm: null, search: null, fetchPage: fakeFetchPage({}) });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const b = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const health = await (await fetch(`${b}/api/health`)).json();
    assert.equal(health.ai.configured, false);
    assert.equal(health.search.configured, false);
    const res = await fetch(`${b}/api/chat`, json({ message: 'What is the capital of Japan?' }));
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.error.code, 'not_configured');
    assert.doesNotMatch(body.error.message, /stack|at |Error:/);
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
  }
});

test('data directory is respected for persistence', () => {
  assert.ok(path.isAbsolute(config.dataDir));
});
