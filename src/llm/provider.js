/**
 * LLM provider interface and factory.
 *
 * Any provider must expose:
 *   name: string
 *   complete({ system, messages, json, maxTokens, temperature }) -> Promise<{ text: string }>
 *
 * Add a new vendor by writing a class with that shape and registering it in createLLMProvider.
 */
import { ConfigError } from '../errors.js';
import { OpenAICompatibleProvider } from './openaiCompatible.js';
import { MockLLMProvider } from './mock.js';

/**
 * @returns {null | {name: string, complete: Function}} null when no AI provider is configured
 */
export function createLLMProvider(config, { logger, fetchImpl } = {}) {
  switch (config.ai.provider) {
    case 'none':
      return null;
    case 'openai':
    case 'openai-compatible':
      if (!config.ai.apiKey) return null;
      return new OpenAICompatibleProvider({
        apiKey: config.ai.apiKey,
        baseUrl: config.ai.baseUrl,
        model: config.ai.model,
        timeoutMs: config.ai.timeoutMs,
        jsonMode: config.ai.jsonMode,
        fetchImpl,
        logger,
      });
    case 'mock':
      return new MockLLMProvider();
    default:
      throw new ConfigError(`Unknown AI provider: ${config.ai.provider}`);
  }
}
