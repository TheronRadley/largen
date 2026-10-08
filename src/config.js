/**
 * Central configuration. Everything comes from environment variables.
 * Secrets (AI_API_KEY, SEARCH_API_KEY) are read here and never exposed to the frontend
 * or written to logs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError } from './errors.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const AI_PROVIDERS = new Set(['none', 'openai-compatible', 'openai', 'mock']);
const SEARCH_PROVIDERS = new Set(['none', 'brave', 'searxng', 'mock']);

function int(value, fallback) {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

function bool(value, fallback = false) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function str(value, fallback = '') {
  const s = (value ?? '').toString().trim();
  return s === '' ? fallback : s;
}

/**
 * Build the configuration object from an env-like object.
 * @param {Record<string, string | undefined>} env
 */
export function loadConfig(env = process.env) {
  const aiKey = str(env.AI_API_KEY);
  const searchKey = str(env.SEARCH_API_KEY);

  // Sensible defaults: if a key is present, use the matching cloud provider; otherwise run
  // in "no provider" mode so the app still starts (and says what is missing).
  const aiProvider = str(env.AI_PROVIDER, aiKey ? 'openai-compatible' : 'none').toLowerCase();
  const searchProvider = str(env.SEARCH_PROVIDER, searchKey ? 'brave' : 'none').toLowerCase();

  if (!AI_PROVIDERS.has(aiProvider)) {
    throw new ConfigError(`AI_PROVIDER must be one of: ${[...AI_PROVIDERS].join(', ')}`);
  }
  if (!SEARCH_PROVIDERS.has(searchProvider)) {
    throw new ConfigError(`SEARCH_PROVIDER must be one of: ${[...SEARCH_PROVIDERS].join(', ')}`);
  }

  return {
    rootDir: ROOT,
    frontendDir: path.join(ROOT, 'frontend'),
    dataDir: path.resolve(ROOT, str(env.LARGEN_DATA_DIR, 'data')),
    host: str(env.HOST, '0.0.0.0'),
    port: int(env.PORT, 8787),
    debug: bool(env.LARGEN_DEBUG, false),
    trustProxy: bool(env.TRUST_PROXY, false),

    ai: {
      provider: aiProvider,
      apiKey: aiKey,
      baseUrl: str(env.AI_BASE_URL, 'https://api.openai.com/v1').replace(/\/+$/, ''),
      model: str(env.AI_MODEL, 'gpt-4o-mini'),
      jsonMode: bool(env.AI_JSON_MODE, true),
      timeoutMs: int(env.AI_TIMEOUT_MS, 60_000),
      maxOutputTokens: int(env.AI_MAX_OUTPUT_TOKENS, 1500),
    },

    search: {
      provider: searchProvider,
      apiKey: searchKey,
      searxngUrl: str(env.SEARXNG_URL, 'http://localhost:8080').replace(/\/+$/, ''),
      resultsPerQuery: int(env.SEARCH_RESULTS_PER_QUERY, 6),
      timeoutMs: int(env.SEARCH_TIMEOUT_MS, 15_000),
      cacheTtlMs: int(env.SEARCH_CACHE_TTL_MS, 60 * 60 * 1000),
      concurrency: int(env.SEARCH_CONCURRENCY, 3),
    },

    retrieval: {
      pageTimeoutMs: int(env.PAGE_TIMEOUT_MS, 12_000),
      maxPageBytes: int(env.MAX_PAGE_BYTES, 1_500_000),
      pageCacheTtlMs: int(env.PAGE_CACHE_TTL_MS, 6 * 60 * 60 * 1000),
      allowPrivateHosts: bool(env.ALLOW_PRIVATE_FETCH, false),
      concurrency: int(env.FETCH_CONCURRENCY, 4),
    },

    research: {
      maxResearchMs: int(env.MAX_RESEARCH_MS, 120_000),
      // Hard caps per depth mode. Complexity can lower these, never raise them.
      maxSearchesByMode: {
        quick: int(env.QUICK_MAX_SEARCHES, 2),
        research: int(env.RESEARCH_MAX_SEARCHES, 6),
        deep: int(env.DEEP_MAX_SEARCHES, 10),
      },
      pagesByMode: {
        quick: int(env.QUICK_MAX_PAGES, 3),
        research: int(env.RESEARCH_MAX_PAGES, 6),
        deep: int(env.DEEP_MAX_PAGES, 10),
      },
      maxEvidenceChars: int(env.MAX_EVIDENCE_CHARS, 12_000),
      maxPassageChars: int(env.MAX_PASSAGE_CHARS, 1_200),
      maxConcurrentRuns: int(env.MAX_CONCURRENT_RUNS, 2),
    },

    limits: {
      maxQuestionChars: int(env.MAX_QUESTION_CHARS, 2000),
      maxHistoryTurns: int(env.MAX_HISTORY_TURNS, 6),
      rateLimitPerMinute: int(env.RATE_LIMIT_PER_MINUTE, 20),
      maxBodyBytes: 64 * 1024,
    },
  };
}

/**
 * Human-readable warnings about missing or risky configuration. Never includes secret values.
 */
export function configWarnings(config) {
  const warnings = [];
  if (config.ai.provider === 'none') {
    warnings.push('No AI provider configured (set AI_API_KEY). Largen will show source excerpts instead of a written answer.');
  } else if (config.ai.provider === 'openai-compatible' && !config.ai.apiKey) {
    warnings.push('AI_PROVIDER is openai-compatible but AI_API_KEY is empty. AI features are disabled.');
  }
  if (config.search.provider === 'none') {
    warnings.push('No search provider configured (set SEARCH_API_KEY, or SEARCH_PROVIDER=searxng). Answers cannot cite web sources.');
  } else if (config.search.provider === 'brave' && !config.search.apiKey) {
    warnings.push('SEARCH_PROVIDER is brave but SEARCH_API_KEY is empty. Web search is disabled.');
  }
  if (config.retrieval.allowPrivateHosts) {
    warnings.push('ALLOW_PRIVATE_FETCH is on: pages on private networks may be fetched. Only use this for local development.');
  }
  return warnings;
}

/** Public, non-secret summary used by /api/health and the UI. */
export function publicStatus(config) {
  return {
    ai: {
      configured: config.ai.provider !== 'none' && (config.ai.provider !== 'openai-compatible' || Boolean(config.ai.apiKey)),
      provider: config.ai.provider,
      model: config.ai.provider === 'none' ? null : config.ai.model,
    },
    search: {
      configured: config.search.provider !== 'none' && (config.search.provider !== 'brave' || Boolean(config.search.apiKey)),
      provider: config.search.provider,
    },
    debug: config.debug,
  };
}
