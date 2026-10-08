/**
 * Brave Search API adapter. Requires SEARCH_API_KEY.
 * Docs: https://api-dashboard.search.brave.com/app/documentation/web-search
 */
import { SearchError } from '../errors.js';
import { normalizeResult } from './normalize.js';

const ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';

export class BraveSearchProvider {
  constructor({ apiKey, timeoutMs = 15_000, fetchImpl = globalThis.fetch }) {
    if (!apiKey) throw new Error('BraveSearchProvider requires an API key');
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    this.name = 'brave';
  }

  async search(query, { count = 6 } = {}) {
    const url = new URL(ENDPOINT);
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(Math.min(Math.max(count, 1), 20)));
    url.searchParams.set('safesearch', 'moderate');
    url.searchParams.set('text_decorations', 'false');

    let res;
    try {
      res = await this.fetchImpl(url, {
        headers: { Accept: 'application/json', 'X-Subscription-Token': this.apiKey },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      throw new SearchError(`Brave request failed: ${err?.name ?? 'network'}`, {
        code: timedOut ? 'search_timeout' : 'search_network',
        publicMessage: 'Web search timed out or was unreachable.',
      });
    }
    if (res.status === 429) {
      throw new SearchError('Brave rate limit hit', {
        code: 'search_rate_limited',
        publicMessage: 'Web search is rate limited right now. Try again shortly or use Quick mode.',
      });
    }
    if (res.status === 401 || res.status === 403) {
      throw new SearchError(`Brave auth failure HTTP ${res.status}`, {
        code: 'search_auth',
        publicMessage: 'The search provider rejected the API key. Check SEARCH_API_KEY.',
      });
    }
    if (!res.ok) throw new SearchError(`Brave HTTP ${res.status}`);

    let data;
    try {
      data = await res.json();
    } catch {
      throw new SearchError('Brave returned invalid JSON', { code: 'search_malformed' });
    }
    const items = Array.isArray(data?.web?.results) ? data.web.results : [];
    return items
      .map((r) =>
        normalizeResult({
          title: r.title,
          url: r.url,
          snippet: r.description,
          publishedAt: r.page_age ?? r.age ?? null,
          provider: 'brave',
        })
      )
      .filter(Boolean);
  }
}
