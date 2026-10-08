/**
 * The research orchestrator. One call to `run()` executes:
 *
 *   Understand → Plan queries → Search (parallel, cached) → Select & read pages (parallel, cached)
 *   → Extract relevant passages → Score sources → Deduplicate syndicated copies
 *   → Detect contradictions → Evidence matrix → Synthesize → Format citations
 *
 * Every external dependency (LLM, search, page fetch) is injected, so the whole flow can be
 * tested with mocks and no API calls. Failures in one search or one page never abort the run.
 */
import { fetchPage as defaultFetchPage } from '../retrieval/fetchPage.js';
import { extractHtml } from '../retrieval/htmlExtract.js';
import { selectPassages } from '../retrieval/passages.js';
import { classifySourceHost } from '../sources/domains.js';
import { scoreSource } from '../sources/score.js';
import { dedupeResults, markSyndicated } from '../sources/dedupe.js';
import { detectConflicts } from '../evidence/contradictions.js';
import { assessEvidence } from '../evidence/matrix.js';
import { understandQuestion } from './understand.js';
import { generateQueries, queryLimit } from './plan.js';
import { answerDirectly, extractiveAnswer, synthesizeWithSources } from '../synthesis/synthesize.js';
import { formatAnswer } from '../citations/format.js';
import { LargenError, NotConfiguredError, PageError } from '../errors.js';
import { mapLimit } from '../utils/concurrency.js';
import { TTLCache } from '../utils/cache.js';
import { contentTerms, hostnameOf, normalizeWhitespace, tokenize, truncate } from '../utils/text.js';

export const STAGE_MESSAGES = {
  understanding: 'Understanding your question…',
  planning: 'Planning research…',
  searching: 'Searching multiple sources…',
  reading: 'Reading the most relevant sources…',
  comparing: 'Comparing evidence…',
  writing: 'Writing answer…',
};

export class ResearchAborted extends Error {
  constructor() {
    super('Research was cancelled');
    this.name = 'ResearchAborted';
  }
}

export class ResearchPipeline {
  /**
   * @param {object} deps
   * @param {object} deps.config
   * @param {object|null} deps.llm  object with complete(); null means no AI provider
   * @param {object|null} deps.search object with search(); null means no search provider
   * @param {object} deps.logger
   * @param {Function} [deps.fetchPage] (url) => Promise<{url, contentType, text}>
   * @param {Function} [deps.now] returns epoch ms
   */
  constructor({ config, llm = null, search = null, logger, fetchPage, now = () => Date.now() }) {
    this.config = config;
    this.llm = llm;
    this.search = search;
    this.logger = logger;
    this.now = now;
    this.fetchPage =
      fetchPage ??
      ((url) =>
        defaultFetchPage(url, {
          timeoutMs: config.retrieval.pageTimeoutMs,
          maxBytes: config.retrieval.maxPageBytes,
          allowPrivate: config.retrieval.allowPrivateHosts,
        }));
    // Caches extracted text (not raw HTML) to keep memory small on a low-end machine.
    this.pageCache = new TTLCache({ ttlMs: config.retrieval.pageCacheTtlMs, maxEntries: 60, now });
  }

  /**
   * @returns {Promise<object>} result (see README "Response shape")
   */
  async run({ question, mode = 'research', webSearch = true, history = [], onStatus = () => {}, signal } = {}) {
    const log = this.logger;
    const started = this.now();
    const deadline = started + this.config.research.maxResearchMs;
    const warnings = [];
    const checkAbort = () => {
      if (signal?.aborted) throw new ResearchAborted();
    };
    const status = (stage, message) => onStatus({ type: 'status', stage, message: message ?? STAGE_MESSAGES[stage] });

    log.info('Research started', { mode, webSearch, historyTurns: history.length, questionChars: question.length });

    status('understanding');
    const plan = await understandQuestion({ llm: this.llm, question, history, logger: log });
    log.info('Plan ready', {
      needsResearch: plan.needsResearch,
      complexity: plan.complexity,
      domain: plan.domain,
      planner: plan.source,
      facets: plan.facets,
    });
    checkAbort();

    if (!plan.needsResearch) {
      return this.answerWithoutSources({ question, plan, history, mode, warnings, started, status });
    }
    if (!webSearch) {
      warnings.push('Web search is off, so this answer comes from general knowledge and may be out of date.');
      return this.answerWithoutSources({ question, plan, history, mode, warnings, started, status });
    }
    if (!this.search) {
      warnings.push('Web search is not configured, so this answer comes from general knowledge and could not be checked against sources.');
      return this.answerWithoutSources({ question, plan, history, mode, warnings, started, status });
    }

    // ── Plan ─────────────────────────────────────────────────────────────────
    const maxQueries = queryLimit({ complexity: plan.complexity, mode, config: this.config });
    const terms = contentTerms([plan.standaloneQuestion, ...plan.facets].join(' '), 30);
    status('planning', planSummary(plan));
    const queries = await generateQueries({ llm: this.llm, plan, maxQueries, logger: log, now: new Date(this.now()) });
    checkAbort();

    // ── Search ───────────────────────────────────────────────────────────────
    status('searching', `Searching ${queries.length} ${queries.length === 1 ? 'query' : 'queries'} across multiple sources…`);
    const { results, failures } = await this.runSearches(queries, { deadline, signal });
    if (failures.length) {
      const unavailable = failures.length === queries.length;
      warnings.push(
        unavailable
          ? 'Web search was unavailable for this question. The answer may rely on general knowledge.'
          : `${failures.length} of ${queries.length} searches failed, so coverage may be incomplete.`
      );
    }
    checkAbort();

    const candidates = dedupeResults(results);
    log.info('Search complete', { queries: queries.length, failedQueries: failures.length, results: results.length, unique: candidates.length });
    if (!candidates.length) {
      warnings.push('Web search returned no usable results for this question.');
      return this.answerWithoutSources({ question, plan, history, mode, warnings, started, status, queries });
    }

    // ── Select and read ──────────────────────────────────────────────────────
    const pagesWanted = this.config.research.pagesByMode[mode] ?? 6;
    const ranked = candidates
      .map((c) => ({ ...c, pre: preScore(c, terms) }))
      .sort((a, b) => b.pre - a.pre);
    const toRead = pickDiverse(ranked, pagesWanted);
    const extraSnippets = ranked.filter((c) => !toRead.includes(c)).slice(0, 3);

    status('reading');
    const reads = await mapLimit(toRead, this.config.retrieval.concurrency, async (candidate) => {
      if (this.now() > deadline || signal?.aborted) {
        return { candidate, error: new PageError('Research time limit reached', 'deadline') };
      }
      try {
        return { candidate, doc: await this.readCandidate(candidate.url) };
      } catch (err) {
        return { candidate, error: err };
      }
    });
    checkAbort();

    const sources = [];
    const readFailures = [];
    for (const { candidate, doc, error } of reads) {
      if (doc) {
        sources.push(buildSource({ candidate, doc, level: 'page', terms, plan, config: this.config, now: this.now() }));
        continue;
      }
      const code = error?.code ?? 'unknown';
      readFailures.push(code);
      log.info('Source extraction failed', { url: candidate.url, reason: code });
      if (candidate.snippet) sources.push(buildSource({ candidate, doc: null, level: 'snippet', terms, plan, config: this.config, now: this.now() }));
    }
    for (const candidate of extraSnippets) {
      sources.push(buildSource({ candidate, doc: null, level: 'snippet', terms, plan, config: this.config, now: this.now() }));
    }

    if (readFailures.length) {
      warnings.push(`${readFailures.length} of ${toRead.length} pages could not be read (${summarizeCodes(readFailures)}). Their search snippets were used where available.`);
    }
    if (this.now() > deadline) {
      warnings.push('The research time limit was reached, so the answer uses the sources read so far.');
    }

    // ── Evaluate ─────────────────────────────────────────────────────────────
    status('comparing');
    sources.sort((a, b) => b.quality - a.quality);
    sources.forEach((s, i) => {
      s.id = `S${i + 1}`;
    });
    markSyndicated(sources);
    const pageSources = sources.filter((s) => s.evidenceLevel === 'page' && !s.syndicatedFrom);
    const conflicts = detectConflicts({ sources: pageSources, queryTerms: terms });
    const assessment = assessEvidence({ sources, conflicts, requiresCurrent: plan.requiresCurrent, now: this.now() });
    log.info('Evidence assessed', { sources: sources.length, readable: assessment.counts.readable, independent: assessment.counts.independent, conflicts: conflicts.length, confidence: assessment.confidence });
    checkAbort();

    if (!sources.some((s) => s.passage)) {
      warnings.push('No usable text was found in the sources, so I could not verify this question.');
      return this.answerWithoutSources({ question, plan, history, mode, warnings, started, status, queries });
    }

    // ── Synthesize ───────────────────────────────────────────────────────────
    status('writing');
    let written;
    try {
      written = this.llm
        ? await synthesizeWithSources({
            llm: this.llm,
            question,
            plan,
            assessment,
            conflicts,
            sources,
            history,
            config: this.config,
            logger: log,
          })
        : extractiveAnswer({ sources, plan });
    } catch (err) {
      if (!(err instanceof LargenError)) throw err;
      log.warn('Synthesis failed; showing excerpts', { code: err.code });
      warnings.push('The AI provider failed while writing the answer, so source excerpts are shown instead.');
      written = extractiveAnswer({ sources, plan });
    }
    if (!this.llm) warnings.push('No AI provider is configured, so excerpts are shown instead of a written answer.');

    const finalAssessment = assessEvidence({
      sources,
      conflicts,
      requiresCurrent: plan.requiresCurrent,
      claims: written.claims,
      now: this.now(),
    });
    if (finalAssessment.unsupportedClaims > 0) {
      warnings.push(`${finalAssessment.unsupportedClaims} statement${finalAssessment.unsupportedClaims === 1 ? '' : 's'} in the answer could not be linked to a retrieved source.`);
    }

    const formatted = formatAnswer({ markdown: written.answer, claims: finalAssessment.claims, sources });
    if (formatted.invalidCitations) log.warn('Removed invalid citations', { count: formatted.invalidCitations });
    if (!formatted.markdown) throw new LargenError('Empty synthesized answer', { code: 'provider_malformed', publicMessage: 'The AI provider returned an empty answer. Please try again.' });

    const numberOf = new Map(formatted.references.map((r) => [r.sourceId, r.number]));
    const latencyMs = this.now() - started;
    log.info('Synthesis complete', { citations: formatted.references.length, latencyMs });

    return {
      mode,
      answer: formatted.markdown,
      summary: planSummary(plan),
      references: formatted.references,
      otherSources: formatted.unreferenced,
      claims: formatted.claims,
      confidence: finalAssessment.confidence,
      confidenceReasons: finalAssessment.confidenceReasons,
      conflicts: conflicts.map((c) => ({
        id: c.id,
        metric: c.metric,
        explanation: c.explanation,
        values: c.values.map((v) => ({
          citation: numberOf.get(v.sourceId) ?? null,
          sourceId: v.sourceId,
          value: v.raw,
          quote: v.quote,
        })),
      })),
      limitations: written.limitations ?? [],
      plan: {
        needsResearch: plan.needsResearch,
        complexity: plan.complexity,
        domain: plan.domain,
        requiresCurrent: plan.requiresCurrent,
        facets: plan.facets,
        assumptions: plan.assumptions,
        queries,
      },
      warnings,
      stats: {
        queries: queries.length,
        failedQueries: failures.length,
        resultsFound: candidates.length,
        pagesAttempted: toRead.length,
        pagesRead: assessment.counts.readable,
        pagesFailed: readFailures.length,
        sourcesIncluded: sources.length,
        latencyMs,
      },
    };
  }

  async runSearches(queries, { deadline, signal }) {
    const perQuery = new Array(queries.length);
    const failures = [];
    await mapLimit(queries, this.config.search.concurrency, async (query, index) => {
      if (this.now() > deadline || signal?.aborted) {
        failures.push({ query, code: 'deadline' });
        perQuery[index] = [];
        return;
      }
      try {
        const items = await this.search.search(query, { count: this.config.search.resultsPerQuery });
        const list = Array.isArray(items) ? items : [];
        this.logger.debug('Search results', { query, count: list.length });
        perQuery[index] = list.map((r) => ({ ...r, query }));
      } catch (err) {
        perQuery[index] = [];
        failures.push({ query, code: err?.code ?? 'search_failed' });
        this.logger.warn('Search failed', { query, reason: err?.code ?? err?.message });
      }
    });
    return { results: perQuery.flat(), failures };
  }

  /** Fetch and extract one page. Cached by URL. Throws PageError when unreadable. */
  async readCandidate(url) {
    const cached = this.pageCache.get(url);
    if (cached) return cached;
    const page = await this.fetchPage(url);
    const isPlain = /text\/plain/i.test(page.contentType ?? '');
    const doc = isPlain
      ? { title: '', description: '', author: null, publishedAt: null, updatedAt: null, text: normalizeWhitespace(page.text) }
      : extractHtml(page.text);
    if (doc.text.length < 200) throw new PageError('Too little readable text', 'too_little_text');
    const stored = { ...doc, text: doc.text.slice(0, 80_000) };
    this.pageCache.set(url, stored);
    return stored;
  }

  async answerWithoutSources({ question, plan, history, mode, warnings, started, status, queries = [] }) {
    if (!this.llm) {
      throw new NotConfiguredError(
        'No AI provider configured',
        'Largen needs an AI provider to write answers. Set AI_API_KEY (see the README) and restart the server.'
      );
    }
    status('writing');
    const answer = await answerDirectly({
      llm: this.llm,
      question: plan.standaloneQuestion || question,
      history,
      config: this.config,
    });
    return {
      mode: 'direct',
      answer,
      summary: plan.needsResearch ? 'I could not check live sources for this answer.' : '',
      references: [],
      otherSources: [],
      claims: [],
      confidence: null,
      confidenceReasons: plan.needsResearch
        ? ['Answered from general knowledge. No web sources were checked.']
        : [],
      conflicts: [],
      limitations: [],
      plan: {
        needsResearch: plan.needsResearch,
        complexity: plan.complexity,
        domain: plan.domain,
        requiresCurrent: plan.requiresCurrent,
        facets: plan.facets,
        assumptions: plan.assumptions,
        queries,
      },
      warnings,
      stats: { queries: 0, resultsFound: 0, pagesRead: 0, latencyMs: this.now() - started },
    };
  }
}

/** Short, user-safe description of what is being checked. Never reveals internal reasoning. */
export function planSummary(plan) {
  if (plan.facets?.length) {
    return `To answer this, I'm comparing ${joinList(plan.facets.slice(0, 5))}.`;
  }
  return `To answer this, I'm checking current sources on ${truncate(plan.topic || 'this topic', 80)}.`;
}

function joinList(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** Score-based pre-ranking before pages are read: authority plus overlap with the question. */
export function preScore(candidate, terms) {
  const cls = classifySourceHost(hostnameOf(candidate.url));
  const hay = new Set(tokenize(`${candidate.title} ${candidate.snippet ?? ''}`));
  const overlap = terms.filter((t) => hay.has(t)).length;
  return cls.authority + 3 * overlap;
}

/** Up to two pages per domain first, so one site cannot dominate the evidence. */
export function pickDiverse(ranked, n, perDomain = 2) {
  const picked = [];
  const counts = new Map();
  for (const c of ranked) {
    const d = hostnameOf(c.url);
    const k = counts.get(d) ?? 0;
    if (k >= perDomain) continue;
    counts.set(d, k + 1);
    picked.push(c);
    if (picked.length >= n) break;
  }
  return picked;
}

function buildSource({ candidate, doc, level, terms, plan, config, now }) {
  const domain = hostnameOf(candidate.url);
  let pathname = '';
  try {
    pathname = new URL(candidate.url).pathname;
  } catch {
    // keep empty path
  }
  const cls = classifySourceHost(domain, pathname);
  const text = doc?.text ?? '';
  const passage =
    level === 'page'
      ? selectPassages(text, terms, { maxChars: config.research.maxPassageChars }).text
      : truncate(candidate.snippet || '', config.research.maxPassageChars);

  const needsRecency = plan.requiresCurrent || plan.domain === 'news' || plan.domain === 'product';
  const scored = scoreSource({
    url: candidate.url,
    title: doc?.title || candidate.title,
    text,
    snippet: candidate.snippet,
    authority: cls.authority,
    publishedAt: doc?.publishedAt || candidate.publishedAt || null,
    updatedAt: doc?.updatedAt || null,
    author: doc?.author || null,
    queryTerms: terms,
    needsRecency,
    now,
  });

  return {
    id: null,
    title: truncate(doc?.title || candidate.title, 200),
    url: candidate.url,
    domain,
    type: cls.type,
    isPrimary: cls.isPrimary,
    publishedAt: doc?.publishedAt || candidate.publishedAt || null,
    updatedAt: doc?.updatedAt || null,
    author: doc?.author || null,
    snippet: candidate.snippet || '',
    text,
    passage,
    excerpt: truncate(passage || candidate.snippet || '', 280),
    evidenceLevel: level,
    quality: scored.total,
    breakdown: scored.breakdown,
    syndicatedFrom: null,
    foundBy: candidate.foundBy ?? [],
  };
}

function summarizeCodes(codes) {
  const counts = {};
  for (const c of codes) counts[c] = (counts[c] ?? 0) + 1;
  return Object.entries(counts)
    .map(([code, n]) => `${n} ${code.replace(/_/g, ' ')}`)
    .join(', ');
}
