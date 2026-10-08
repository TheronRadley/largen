/**
 * Search provider interface and factory.
 *
 * Any provider must expose:
 *   name: string
 *   search(query, { count }) -> Promise<Array<{ title, url, snippet, publishedAt, provider }>>
 *
 * Failures must throw SearchError. The research pipeline treats a failed query as
 * "one fewer source", never as a crash.
 */
import { ConfigError } from '../errors.js';
import { TTLCache } from '../utils/cache.js';
import { normalizeQueryKey } from '../utils/text.js';
import { BraveSearchProvider } from './brave.js';
import { SearxngSearchProvider } from './searxng.js';
import { MockSearchProvider } from './mock.js';

export function createSearchProvider(config, { logger, fetchImpl } = {}) {
  let inner;
  switch (config.search.provider) {
    case 'none':
      return null;
    case 'brave':
      if (!config.search.apiKey) return null;
      inner = new BraveSearchProvider({
        apiKey: config.search.apiKey,
        timeoutMs: config.search.timeoutMs,
        fetchImpl,
      });
      break;
    case 'searxng':
      inner = new SearxngSearchProvider({
        baseUrl: config.search.searxngUrl,
        timeoutMs: config.search.timeoutMs,
        fetchImpl,
      });
      break;
    case 'mock':
      inner = new MockSearchProvider();
      break;
    default:
      throw new ConfigError(`Unknown search provider: ${config.search.provider}`);
  }
  return new CachedSearchProvider(inner, {
    ttlMs: config.search.cacheTtlMs,
    logger,
  });
}

/** Caches successful searches so repeated questions do not cost another API call. */
export class CachedSearchProvider {
  constructor(inner, { ttlMs, maxEntries = 300, logger } = {}) {
    this.inner = inner;
    this.name = inner.name;
    this.cache = new TTLCache({ ttlMs, maxEntries });
    this.logger = logger;
  }

  async search(query, options = {}) {
    const count = options.count ?? 6;
    const key = `${this.inner.name}|${count}|${normalizeQueryKey(query)}`;
    const cached = this.cache.get(key);
    if (cached) {
      this.logger?.debug('Search cache hit', { query });
      return cached;
    }
    const results = await this.inner.search(query, options);
    this.cache.set(key, results);
    return results;
  }
}
