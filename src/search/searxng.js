/**
 * SearXNG adapter (self-hosted metasearch, no API key). Set SEARCH_PROVIDER=searxng and
 * SEARXNG_URL=http://host:port. The instance must allow `format=json` in settings.yml.
 */
import { SearchError } from '../errors.js';
import { normalizeResult } from './normalize.js';

export class SearxngSearchProvider {
  constructor({ baseUrl = 'http://localhost:8080', timeoutMs = 15_000, fetchImpl = globalThis.fetch }) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    this.name = 'searxng';
  }

  async search(query, { count = 6 } = {}) {
    const url = new URL(`${this.baseUrl}/search`);
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'json');
    url.searchParams.set('safesearch', '1');

    let res;
    try {
      res = await this.fetchImpl(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      throw new SearchError(`SearXNG request failed: ${err?.name ?? 'network'}`, {
        code: timedOut ? 'search_timeout' : 'search_network',
        publicMessage: 'Web search timed out or was unreachable.',
      });
    }
    if (!res.ok) throw new SearchError(`SearXNG HTTP ${res.status}`);

    let data;
    try {
      data = await res.json();
    } catch {
      throw new SearchError('SearXNG returned invalid JSON (is format=json enabled?)', {
        code: 'search_malformed',
      });
    }
    const items = Array.isArray(data?.results) ? data.results.slice(0, Math.max(count, 1)) : [];
    return items
      .map((r) =>
        normalizeResult({
          title: r.title,
          url: r.url,
          snippet: r.content,
          publishedAt: r.publishedDate ?? null,
          provider: 'searxng',
        })
      )
      .filter(Boolean);
  }
}
