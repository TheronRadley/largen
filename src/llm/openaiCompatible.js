/**
 * Provider for any service that speaks the OpenAI Chat Completions API
 * (OpenAI, OpenRouter, Groq, Together, Mistral, LM Studio, Ollama's /v1, etc.).
 * Set AI_BASE_URL and AI_MODEL to switch vendors. No SDK is needed.
 */
import { ProviderError } from '../errors.js';
import { sleep } from '../utils/concurrency.js';

export class OpenAICompatibleProvider {
  constructor({
    apiKey,
    baseUrl = 'https://api.openai.com/v1',
    model = 'gpt-4o-mini',
    timeoutMs = 60_000,
    jsonMode = true,
    maxRetries = 2,
    fetchImpl = globalThis.fetch,
    logger,
  }) {
    if (!apiKey) throw new Error('OpenAICompatibleProvider requires an API key');
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.jsonMode = jsonMode;
    this.maxRetries = maxRetries;
    this.fetchImpl = fetchImpl;
    this.logger = logger;
    this.name = `openai-compatible:${model}`;
  }

  async complete({ system, messages = [], json = false, maxTokens = 1200, temperature = 0.2 }) {
    const body = {
      model: this.model,
      temperature,
      max_tokens: maxTokens,
      messages: [{ role: 'system', content: system }, ...messages],
    };
    if (json && this.jsonMode) body.response_format = { type: 'json_object' };

    let lastError;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      let res;
      try {
        res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
          throw new ProviderError('AI request timed out', {
            code: 'provider_timeout',
            publicMessage: 'The AI provider took too long to respond. Please try again.',
          });
        }
        lastError = new ProviderError(`AI network error: ${err?.code ?? err?.name ?? 'unknown'}`, {
          code: 'provider_network',
        });
        this.logger?.debug('AI request network error, retrying', { attempt });
        await sleep(500 * 2 ** attempt);
        continue;
      }

      if (res.status === 429 || res.status >= 500) {
        lastError = new ProviderError(`AI provider HTTP ${res.status}`, {
          code: res.status === 429 ? 'provider_rate_limited' : 'provider_unavailable',
          publicMessage:
            res.status === 429
              ? 'The AI provider is rate limiting requests. Please wait a moment and try again.'
              : undefined,
        });
        await res.body?.cancel?.().catch(() => {});
        await sleep(500 * 2 ** attempt);
        continue;
      }

      if (!res.ok) {
        await res.body?.cancel?.().catch(() => {});
        const authFailed = res.status === 401 || res.status === 403;
        throw new ProviderError(`AI provider HTTP ${res.status}`, {
          code: authFailed ? 'provider_auth' : 'provider_http',
          publicMessage: authFailed
            ? 'The AI provider rejected the API key. Check AI_API_KEY and AI_BASE_URL.'
            : undefined,
        });
      }

      let data;
      try {
        data = await res.json();
      } catch {
        throw new ProviderError('AI provider returned invalid JSON', { code: 'provider_malformed' });
      }
      const text = data?.choices?.[0]?.message?.content;
      if (typeof text !== 'string' || !text.trim()) {
        throw new ProviderError('AI provider returned no content', { code: 'provider_malformed' });
      }
      return { text, usage: data.usage ?? null };
    }
    throw lastError ?? new ProviderError('AI request failed');
  }
}
