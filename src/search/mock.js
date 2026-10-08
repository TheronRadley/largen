/**
 * Fake search provider for tests and offline development.
 *
 * results: object mapping a substring of the query to an array of results,
 *          or a function (query) => results[]
 * failQueries: substrings of queries that should throw a SearchError
 */
import { SearchError } from '../errors.js';

export class MockSearchProvider {
  constructor({ results = {}, fallback = [], failQueries = [] } = {}) {
    this.name = 'mock';
    this.results = results;
    this.fallback = fallback;
    this.failQueries = failQueries;
    this.calls = [];
  }

  async search(query) {
    this.calls.push(query);
    const lower = query.toLowerCase();
    if (this.failQueries.some((f) => lower.includes(f.toLowerCase()))) {
      throw new SearchError(`mock search failure for "${query}"`, {
        code: 'search_network',
        publicMessage: 'Web search failed for part of this question.',
      });
    }
    if (typeof this.results === 'function') return this.results(query);
    for (const [needle, value] of Object.entries(this.results)) {
      if (lower.includes(needle.toLowerCase())) return value;
    }
    return this.fallback;
  }
}
