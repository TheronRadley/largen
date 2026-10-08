/**
 * Chat handling shared by the streaming (SSE) and JSON endpoints.
 * Validates input, loads conversation history, runs the pipeline, and stores both messages.
 */
import { LargenError, NotConfiguredError, ValidationError, toPublicError } from '../errors.js';
import { stripControlChars, truncate } from '../utils/text.js';
import { ResearchAborted } from '../orchestrator/pipeline.js';

export const MODES = new Set(['quick', 'research', 'deep']);
export const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** @returns {{message: string, mode: string, webSearch: boolean, conversationId: string|null}} */
export function validateChatBody(body, { maxQuestionChars }) {
  const raw = body?.message;
  if (typeof raw !== 'string') throw new ValidationError('Please type a question.');
  const message = stripControlChars(raw).trim();
  if (!message) throw new ValidationError('Please type a question.');
  if (message.length > maxQuestionChars) {
    throw new ValidationError(`Questions can be up to ${maxQuestionChars} characters. Yours is ${message.length}.`);
  }
  const mode = typeof body.mode === 'string' ? body.mode.toLowerCase() : 'research';
  if (!MODES.has(mode)) throw new ValidationError('Mode must be quick, research, or deep.');
  if (body.webSearch !== undefined && typeof body.webSearch !== 'boolean') {
    throw new ValidationError('webSearch must be true or false.');
  }
  let conversationId = null;
  if (body.conversationId !== undefined && body.conversationId !== null && body.conversationId !== '') {
    if (typeof body.conversationId !== 'string' || !ID_RE.test(body.conversationId)) {
      throw new ValidationError('Invalid conversation id.');
    }
    conversationId = body.conversationId;
  }
  return { message, mode, webSearch: body.webSearch !== false, conversationId };
}

/**
 * Runs one chat turn end to end.
 * @param {object} deps {pipeline, store, logger, config}
 * @param {object} input validated input
 * @param {(event: string, data: object) => void} emit
 * @param {AbortSignal} [signal]
 */
export async function runChatTurn({ pipeline, store, logger, config }, input, emit = () => {}, signal) {
  let conv = input.conversationId ? store.get(input.conversationId) : null;
  if (input.conversationId && !conv) {
    throw new LargenError('Conversation not found', { code: 'not_found', status: 404, publicMessage: 'That conversation no longer exists.' });
  }
  if (!conv) conv = await store.create(truncate(input.message, 60));

  const history = conv.messages
    .slice(-config.limits.maxHistoryTurns * 2)
    .map((m) => ({ role: m.role, content: truncate(m.content, 1200) }));

  const createdAt = new Date().toISOString();
  const userMessage = { role: 'user', content: input.message, createdAt, mode: input.mode, webSearch: input.webSearch };

  try {
    const result = await pipeline.run({
      question: input.message,
      mode: input.mode,
      webSearch: input.webSearch,
      history,
      signal,
      onStatus: (event) => emit('status', event),
    });
    const assistant = { role: 'assistant', createdAt: new Date().toISOString(), ...result };
    await store.appendMessages(conv.id, [userMessage, assistant]);
    logger.info('Turn complete', { mode: input.mode, confidence: result.confidence, references: result.references.length });
    return { conversationId: conv.id, message: assistant };
  } catch (err) {
    if (err instanceof ResearchAborted) {
      logger.info('Research cancelled by client');
      throw err;
    }
    const pub = toPublicError(err);
    if (err instanceof NotConfiguredError) logger.warn('Not configured', { reason: err.message });
    else if (!(err instanceof LargenError)) logger.error('Unexpected failure', { error: err?.stack ?? String(err) });
    else logger.warn('Turn failed', { code: err.code });
    const assistant = { role: 'assistant', content: pub.message, error: true, errorCode: pub.code, createdAt: new Date().toISOString() };
    await store.appendMessages(conv.id, [userMessage, assistant]);
    throw Object.assign(new LargenError(err?.message ?? 'failed', { code: pub.code, status: pub.status, publicMessage: pub.message }), {
      conversationId: conv.id,
    });
  }
}
