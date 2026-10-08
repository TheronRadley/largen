import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { OpenAICompatibleProvider } from '../src/llm/openaiCompatible.js';
import { createLLMProvider } from '../src/llm/provider.js';
import { BraveSearchProvider } from '../src/search/brave.js';
import { SearxngSearchProvider } from '../src/search/searxng.js';
import { CachedSearchProvider, createSearchProvider } from '../src/search/provider.js';
import { MockSearchProvider } from '../src/search/mock.js';
import { ConversationStore } from '../src/store/conversations.js';
import { ProviderError, SearchError } from '../src/errors.js';
import { loadConfig, configWarnings, publicStatus } from '../src/config.js';
import { createLogger, redact } from '../src/logger.js';
import { makeConfig, silentLogger } from './helpers.js';

const jsonResponse = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// ── LLM provider ──────────────────────────────────────────────────────────────

test('OpenAI-compatible provider sends the request and returns the message text', async () => {
  let seen;
  const provider = new OpenAICompatibleProvider({
    apiKey: 'k',
    baseUrl: 'https://llm.example.com/v1/',
    model: 'm1',
    fetchImpl: async (url, init) => {
      seen = { url, init, body: JSON.parse(init.body) };
      return jsonResponse(200, { choices: [{ message: { content: 'hello' } }] });
    },
  });
  const out = await provider.complete({ system: 'sys', messages: [{ role: 'user', content: 'hi' }], json: true });
  assert.equal(out.text, 'hello');
  assert.equal(seen.url, 'https://llm.example.com/v1/chat/completions');
  assert.equal(seen.init.headers.authorization, 'Bearer k');
  assert.deepEqual(seen.body.response_format, { type: 'json_object' });
  assert.equal(seen.body.messages[0].role, 'system');
});

test('OpenAI-compatible provider retries once on rate limiting, then succeeds', async () => {
  let n = 0;
  const provider = new OpenAICompatibleProvider({
    apiKey: 'k',
    fetchImpl: async () => (++n === 1 ? new Response('slow down', { status: 429 }) : jsonResponse(200, { choices: [{ message: { content: 'ok' } }] })),
  });
  const out = await provider.complete({ system: 's', messages: [] });
  assert.equal(out.text, 'ok');
  assert.equal(n, 2);
});

test('OpenAI-compatible provider maps auth failures to a helpful message', async () => {
  const provider = new OpenAICompatibleProvider({ apiKey: 'k', fetchImpl: async () => new Response('no', { status: 401 }) });
  await assert.rejects(provider.complete({ system: 's', messages: [] }), (e) => {
    assert.ok(e instanceof ProviderError);
    assert.equal(e.code, 'provider_auth');
    assert.match(e.publicMessage, /AI_API_KEY/);
    return true;
  });
});

test('OpenAI-compatible provider maps timeouts and empty content', async () => {
  const timeout = new OpenAICompatibleProvider({
    apiKey: 'k',
    fetchImpl: async () => {
      throw Object.assign(new Error('t'), { name: 'TimeoutError' });
    },
  });
  await assert.rejects(timeout.complete({ system: 's', messages: [] }), (e) => e.code === 'provider_timeout');

  const empty = new OpenAICompatibleProvider({ apiKey: 'k', fetchImpl: async () => jsonResponse(200, { choices: [{ message: { content: '  ' } }] }) });
  await assert.rejects(empty.complete({ system: 's', messages: [] }), (e) => e.code === 'provider_malformed');
});

test('provider factory returns null without a key and respects AI_PROVIDER', () => {
  assert.equal(createLLMProvider(loadConfig({}), { logger: silentLogger }), null);
  assert.equal(createLLMProvider(loadConfig({ AI_PROVIDER: 'openai-compatible' }), { logger: silentLogger }), null);
  const p = createLLMProvider(loadConfig({ AI_API_KEY: 'abc', AI_MODEL: 'x-1' }), { logger: silentLogger });
  assert.equal(p.name, 'openai-compatible:x-1');
  assert.throws(() => loadConfig({ AI_PROVIDER: 'carrier-pigeon' }), /AI_PROVIDER/);
  assert.throws(() => loadConfig({ SEARCH_PROVIDER: 'carrier-pigeon' }), /SEARCH_PROVIDER/);
});

// ── Search providers ─────────────────────────────────────────────────────────

test('Brave adapter normalizes results and sends the subscription header', async () => {
  let headers;
  let requested;
  const provider = new BraveSearchProvider({
    apiKey: 'brave-key',
    fetchImpl: async (url, init) => {
      headers = init.headers;
      requested = new URL(url);
      return jsonResponse(200, {
        web: {
          results: [
            { title: 'Good <strong>result</strong>', url: 'https://example.com/a', description: 'About <b>things</b>', page_age: '2026-05-01T00:00:00Z' },
            { title: 'Bad url', url: 'javascript:alert(1)', description: 'x' },
            { title: '', url: 'https://example.com/no-title', description: 'x' },
          ],
        },
      });
    },
  });
  const results = await provider.search('laptop battery', { count: 5 });
  assert.equal(results.length, 1);
  assert.equal(results[0].title, 'Good result');
  assert.equal(results[0].snippet, 'About things');
  assert.equal(results[0].publishedAt, '2026-05-01T00:00:00.000Z');
  assert.equal(headers['X-Subscription-Token'], 'brave-key');
  assert.equal(requested.searchParams.get('q'), 'laptop battery');
  assert.equal(requested.searchParams.get('count'), '5');
});

test('Brave adapter reports rate limits and bad keys as search errors', async () => {
  const limited = new BraveSearchProvider({ apiKey: 'k', fetchImpl: async () => new Response('', { status: 429 }) });
  await assert.rejects(limited.search('x'), (e) => e instanceof SearchError && e.code === 'search_rate_limited');
  const badKey = new BraveSearchProvider({ apiKey: 'k', fetchImpl: async () => new Response('', { status: 401 }) });
  await assert.rejects(badKey.search('x'), (e) => e.code === 'search_auth' && /SEARCH_API_KEY/.test(e.publicMessage));
  const broken = new BraveSearchProvider({ apiKey: 'k', fetchImpl: async () => new Response('<html>', { status: 200 }) });
  await assert.rejects(broken.search('x'), (e) => e.code === 'search_malformed');
});

test('SearXNG adapter normalizes results from the JSON endpoint', async () => {
  const provider = new SearxngSearchProvider({
    baseUrl: 'http://search.internal:8080/',
    fetchImpl: async (url) => {
      assert.equal(new URL(url).searchParams.get('format'), 'json');
      return jsonResponse(200, { results: [{ title: 'Doc', url: 'https://docs.example.org/x', content: 'snippet text', publishedDate: null }] });
    },
  });
  const results = await provider.search('query', { count: 3 });
  assert.equal(results[0].provider, 'searxng');
  assert.equal(results[0].snippet, 'snippet text');
});

test('search results are cached so repeated queries cost nothing extra', async () => {
  const inner = new MockSearchProvider({ fallback: [{ title: 'T', url: 'https://a.com/x', snippet: '', publishedAt: null, provider: 'mock' }] });
  let count = 0;
  const original = inner.search.bind(inner);
  inner.search = async (q, o) => {
    count++;
    return original(q, o);
  };
  const cached = new CachedSearchProvider(inner, { ttlMs: 60_000 });
  await cached.search('Same  Query?', { count: 3 });
  await cached.search('same query', { count: 3 });
  assert.equal(count, 1);
});

test('search factory returns null when no search provider is configured', () => {
  assert.equal(createSearchProvider(loadConfig({}), {}), null);
  assert.ok(createSearchProvider(loadConfig({ SEARCH_API_KEY: 'k' }), {}));
});

// ── Conversation store ───────────────────────────────────────────────────────

function tempFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'largen-store-')), 'conversations.json');
}

test('conversations persist across store instances', async () => {
  const file = tempFile();
  const a = await new ConversationStore({ filePath: file, logger: silentLogger }).load();
  const conv = await a.create('Laptops');
  await a.appendMessages(conv.id, [
    { role: 'user', content: 'Which laptop?' },
    { role: 'assistant', content: 'Here is an answer.' },
  ]);
  const b = await new ConversationStore({ filePath: file, logger: silentLogger }).load();
  const loaded = b.get(conv.id);
  assert.equal(loaded.title, 'Laptops');
  assert.equal(loaded.messages.length, 2);
  assert.equal(b.list()[0].messageCount, 2);
});

test('a corrupt conversation file is moved aside instead of crashing the app', async () => {
  const file = tempFile();
  fs.writeFileSync(file, '{ not valid json');
  const store = await new ConversationStore({ filePath: file, logger: silentLogger }).load();
  assert.equal(store.list().length, 0);
  const siblings = fs.readdirSync(path.dirname(file));
  assert.ok(siblings.some((f) => f.includes('corrupt-')), siblings.join(','));
});

test('deleting a conversation removes it from disk', async () => {
  const file = tempFile();
  const store = await new ConversationStore({ filePath: file, logger: silentLogger }).load();
  const conv = await store.create('Temp');
  assert.equal(await store.delete(conv.id), true);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(raw.conversations.length, 0);
});

// ── Config & logging hygiene ─────────────────────────────────────────────────

test('configuration warnings name what is missing but never reveal key values', () => {
  const cfg = loadConfig({ AI_API_KEY: 'sk-super-secret-value' });
  const status = publicStatus(cfg);
  assert.equal(status.ai.configured, true);
  assert.equal(JSON.stringify(status).includes('sk-super-secret-value'), false);
  const warnings = configWarnings(loadConfig({}));
  assert.ok(warnings.some((w) => /AI_API_KEY/.test(w)));
  assert.ok(warnings.some((w) => /SEARCH_API_KEY/.test(w)));
  assert.equal(warnings.join(' ').includes('sk-'), false);
});

test('logger redacts secret-looking fields and hides debug lines unless enabled', () => {
  assert.deepEqual(redact({ apiKey: 'abc', query: 'hello', authorization: 'Bearer x' }), {
    apiKey: '[redacted]',
    query: 'hello',
    authorization: '[redacted]',
  });
  const lines = [];
  const sink = { log: (l) => lines.push(l), error: (l) => lines.push(l) };
  const quiet = createLogger({ debug: false, sink });
  quiet.debug('hidden', { a: 1 });
  quiet.info('visible', { AI_API_KEY: 'shh' });
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0], /shh/);
  assert.match(lines[0], /\[redacted\]/);
});

test('makeConfig gives every test an isolated data directory', () => {
  const a = makeConfig();
  const b = makeConfig();
  assert.notEqual(a.dataDir, b.dataDir);
});
