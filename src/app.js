/**
 * Wires config, providers, pipeline, storage and HTTP routes into one server.
 * `createApp` takes injectable dependencies so tests can run the real HTTP stack with mocks.
 */
import http from 'node:http';
import path from 'node:path';
import { createLLMProvider } from './llm/provider.js';
import { createSearchProvider } from './search/provider.js';
import { ResearchPipeline, ResearchAborted } from './orchestrator/pipeline.js';
import { ConversationStore } from './store/conversations.js';
import { RateLimiter } from './utils/rateLimit.js';
import { publicStatus } from './config.js';
import { toPublicError } from './errors.js';
import { applySecurityHeaders, openSse, readJsonBody, sendError, sendJson, serveStatic } from './api/http.js';
import { ID_RE, runChatTurn, validateChatBody } from './api/chat.js';

export async function createApp({ config, logger, llm, search, fetchPage, fetchImpl, now, store: storeOverride } = {}) {
  const resolvedLlm = llm !== undefined ? llm : createLLMProvider(config, { logger, fetchImpl });
  const resolvedSearch = search !== undefined ? search : createSearchProvider(config, { logger, fetchImpl });
  const store = storeOverride ?? (await new ConversationStore({
    filePath: path.join(config.dataDir, 'conversations.json'),
    logger,
  }).load());
  const pipeline = new ResearchPipeline({
    config,
    llm: resolvedLlm,
    search: resolvedSearch,
    logger,
    fetchPage,
    now,
  });
  const limiter = new RateLimiter({ limit: config.limits.rateLimitPerMinute });
  const ctx = { config, logger, store, pipeline, limiter, activeRuns: { count: 0 } };

  const server = http.createServer((req, res) => {
    handle(ctx, req, res).catch((err) => {
      logger.error('Unhandled request error', { error: err?.stack ?? String(err) });
      if (!res.headersSent) sendError(res, 500, 'internal_error', 'Something went wrong. Please try again.');
      else res.end();
    });
  });
  server.requestTimeout = 0; // research can take minutes; the pipeline has its own deadline
  server.keepAliveTimeout = 65_000;

  return { server, pipeline, store, llm: resolvedLlm, search: resolvedSearch };
}

function clientKey(req, config) {
  if (config.trustProxy) {
    const fwd = req.headers['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd.trim()) return fwd.split(',')[0].trim();
  }
  return req.socket.remoteAddress ?? 'unknown';
}

async function handle(ctx, req, res) {
  applySecurityHeaders(res);
  const url = new URL(req.url ?? '/', 'http://localhost');
  const { pathname } = url;
  const method = req.method ?? 'GET';

  if (!pathname.startsWith('/api/')) {
    if (method !== 'GET' && method !== 'HEAD') return sendError(res, 405, 'method_not_allowed', 'Method not allowed.');
    return serveStatic(req, res, ctx.config.frontendDir, pathname);
  }

  // ── Health and config ──────────────────────────────────────────────────────
  if (pathname === '/api/health' && method === 'GET') {
    return sendJson(res, 200, { ok: true, ...publicStatus(ctx.config) });
  }

  // ── Conversations ──────────────────────────────────────────────────────────
  if (pathname === '/api/conversations' && method === 'GET') {
    return sendJson(res, 200, { conversations: ctx.store.list() });
  }
  if (pathname === '/api/conversations' && method === 'POST') {
    const body = await readJsonBody(req, ctx.config.limits.maxBodyBytes).catch((e) => e);
    if (body instanceof Error) return sendPublicError(res, body);
    const conv = await ctx.store.create(typeof body.title === 'string' ? body.title : undefined);
    return sendJson(res, 201, { conversation: summarize(conv) });
  }

  const convMatch = pathname.match(/^\/api\/conversations\/([^/]+)$/);
  if (convMatch) {
    const id = convMatch[1];
    if (!ID_RE.test(id)) return sendError(res, 400, 'invalid_input', 'Invalid conversation id.');
    const conv = ctx.store.get(id);
    if (method === 'GET') {
      if (!conv) return sendError(res, 404, 'not_found', 'That conversation no longer exists.');
      return sendJson(res, 200, { conversation: conv });
    }
    if (method === 'DELETE') {
      if (!conv) return sendError(res, 404, 'not_found', 'That conversation no longer exists.');
      await ctx.store.delete(id);
      return sendJson(res, 200, { ok: true });
    }
    if (method === 'PATCH') {
      if (!conv) return sendError(res, 404, 'not_found', 'That conversation no longer exists.');
      const body = await readJsonBody(req, ctx.config.limits.maxBodyBytes).catch((e) => e);
      if (body instanceof Error) return sendPublicError(res, body);
      if (typeof body.title !== 'string') return sendError(res, 400, 'invalid_input', 'Title must be text.');
      const updated = await ctx.store.rename(id, body.title);
      return sendJson(res, 200, { conversation: summarize(updated) });
    }
    return sendError(res, 405, 'method_not_allowed', 'Method not allowed.');
  }

  // ── Chat ───────────────────────────────────────────────────────────────────
  if (pathname === '/api/chat/stream' && method === 'POST') {
    return handleChat(ctx, req, res, { stream: true });
  }
  if (pathname === '/api/chat' && method === 'POST') {
    return handleChat(ctx, req, res, { stream: false });
  }

  return sendError(res, 404, 'not_found', 'Not found.');
}

async function handleChat(ctx, req, res, { stream }) {
  const limit = ctx.limiter.hit(clientKey(req, ctx.config));
  if (!limit.allowed) {
    return sendError(res, 429, 'rate_limited', 'You are sending questions too quickly. Please wait a moment.', {
      'Retry-After': String(limit.retryAfterSec),
    });
  }
  if (ctx.activeRuns.count >= ctx.config.research.maxConcurrentRuns) {
    return sendError(res, 429, 'busy', 'Largen is busy with other research right now. Please try again in a moment.', {
      'Retry-After': '10',
    });
  }

  let input;
  try {
    const body = await readJsonBody(req, ctx.config.limits.maxBodyBytes);
    input = validateChatBody(body, ctx.config.limits);
  } catch (err) {
    return sendPublicError(res, err);
  }

  const abort = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) abort.abort();
  });

  ctx.activeRuns.count++;
  try {
    if (!stream) {
      const result = await runChatTurn(ctx, input, () => {}, abort.signal);
      return sendJson(res, 200, result);
    }
    const sse = openSse(res);
    try {
      const result = await runChatTurn(ctx, input, (event, data) => sse.send(event, data), abort.signal);
      sse.send('result', result);
    } catch (err) {
      if (err instanceof ResearchAborted) return undefined;
      const pub = toPublicError(err);
      sse.send('error', { code: pub.code, message: pub.message, conversationId: err?.conversationId ?? null });
    } finally {
      sse.close();
    }
    return undefined;
  } catch (err) {
    if (err instanceof ResearchAborted) return undefined;
    if (!res.headersSent) return sendPublicError(res, err);
    return res.end();
  } finally {
    ctx.activeRuns.count--;
  }
}

function sendPublicError(res, err) {
  const pub = toPublicError(err);
  return sendError(res, pub.status, pub.code, pub.message);
}

function summarize(conv) {
  return { id: conv.id, title: conv.title, createdAt: conv.createdAt, updatedAt: conv.updatedAt, messageCount: conv.messages.length };
}


