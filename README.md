# Largen

**The AI that finds evidence before it answers.**

Largen is a research assistant. You ask a question, and it:

1. **Understands** the question (is it simple, does it need current web sources, what aspects matter?).
2. **Plans** a set of focused search queries, one per aspect.
3. **Searches** the web with those queries, in parallel.
4. **Reads** the most promising pages and pulls out the relevant passages.
5. **Scores** each source on authority, relevance, recency, evidence, and transparency.
6. **Removes syndicated copies** (the same article republished on other sites).
7. **Extracts and compares claims** with quote-grounded support, contradiction, and irrelevance edges, alongside numeric contradiction detection.
8. **Builds an evidence matrix** and gives the answer a **High / Medium / Low** confidence rating.
9. **Writes the answer** in Markdown with numbered citations like `[1]`, followed by a **Sources** section.

Largen never invents sources. It can only cite pages it actually retrieved. If a search or page fails, the answer says so.

It is designed for modest hardware. It has **no npm dependencies**, does not run a local LLM, stores conversations in a JSON file, and keeps caches in memory. The AI model and the search engine are cloud services you configure with API keys.

---

## Requirements

- **Node.js 22 or newer** (check with `node -v`). Download it from <https://nodejs.org>.
- An **AI provider** API key, for example OpenAI, OpenRouter, or Groq. Any OpenAI-compatible chat API works.
- A **search provider**: a Brave Search API key, or your own SearXNG instance.

Without an AI key, Largen still runs, but it can only show source excerpts (no written answer). Without a search provider, it cannot research the web.

## Quick start

```bash
git clone https://github.com/TheronRadley/largen.git
cd largen
cp .env.example .env        # then edit .env and add your keys
npm start
```

Open <http://localhost:8787> in your browser.

To try Largen without any API keys, use the built-in mock providers (they return canned responses and are only for checking that the app works):

```bash
AI_PROVIDER=mock SEARCH_PROVIDER=mock npm start
```

## Configuration

Largen reads settings from environment variables. You can put them in a `.env` file in the project root (see `.env.example`). Real environment variables override `.env`. Keys are never sent to the browser and are never written to logs.

### Core providers

| Variable | Default | Description |
| --- | --- | --- |
| `AI_PROVIDER` | `openai-compatible` if `AI_API_KEY` is set, else `none` | `openai-compatible` (also accepts `openai`), `mock`, or `none` |
| `AI_API_KEY` | _(empty)_ | API key for the AI provider |
| `AI_BASE_URL` | `https://api.openai.com/v1` | Base URL of any OpenAI-compatible API |
| `AI_MODEL` | `gpt-4o-mini` | Model name sent to the provider |
| `AI_JSON_MODE` | `1` | Request JSON responses. Set `0` if your provider rejects `response_format` |
| `AI_TIMEOUT_MS` | `60000` | Timeout for each AI request |
| `AI_MAX_OUTPUT_TOKENS` | `1500` | Maximum tokens per AI response |
| `SEARCH_PROVIDER` | `brave` if `SEARCH_API_KEY` is set, else `none` | `brave`, `searxng`, `mock`, or `none` |
| `SEARCH_API_KEY` | _(empty)_ | Brave Search API key |
| `SEARXNG_URL` | `http://localhost:8080` | Base URL of your SearXNG instance (used when `SEARCH_PROVIDER=searxng`) |
| `SEARCH_RESULTS_PER_QUERY` | `6` | Results requested for each query |
| `SEARCH_TIMEOUT_MS` | `15000` | Timeout for each search request |
| `SEARCH_CACHE_TTL_MS` | `3600000` | How long identical searches are cached (1 hour) |
| `SEARCH_CONCURRENCY` | `3` | Searches running at once |

### Server, research limits, and safety

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `8787` | Port to listen on |
| `HOST` | `0.0.0.0` | Interface to bind to |
| `LARGEN_DEBUG` | `0` | `1` enables verbose logs (never includes keys) |
| `LARGEN_DATA_DIR` | `data` | Folder for `conversations.json` |
| `TRUST_PROXY` | `0` | `1` only behind a trusted reverse proxy; rate limits then use `X-Forwarded-For` |
| `QUICK_MAX_SEARCHES` / `RESEARCH_MAX_SEARCHES` / `DEEP_MAX_SEARCHES` | `2` / `6` / `10` | Maximum search queries per depth mode |
| `QUICK_MAX_PAGES` / `RESEARCH_MAX_PAGES` / `DEEP_MAX_PAGES` | `3` / `6` / `10` | Maximum pages read per depth mode |
| `MAX_RESEARCH_MS` | `120000` | Time budget for one research run. Past this, Largen answers with what it has and says so |
| `MAX_CONCURRENT_RUNS` | `2` | Research runs at once. Extra requests get a "busy" response |
| `RATE_LIMIT_PER_MINUTE` | `20` | Questions per minute per client IP |
| `MAX_QUESTION_CHARS` | `2000` | Longest allowed question |
| `MAX_HISTORY_TURNS` | `6` | Earlier turns sent to the model for follow-up questions |
| `PAGE_TIMEOUT_MS` | `12000` | Timeout per page |
| `MAX_PAGE_BYTES` | `1500000` | Largest page body read (bigger pages are cut off) |
| `PAGE_CACHE_TTL_MS` | `21600000` | How long page text is cached (6 hours) |
| `FETCH_CONCURRENCY` | `4` | Pages read at once |
| `ALLOW_PRIVATE_FETCH` | `0` | Keep `0`. `1` lets Largen read `localhost` and private networks (development only) |
| `MAX_EVIDENCE_CHARS` / `MAX_PASSAGE_CHARS` | `12000` / `1200` | Size limits for the text sent to the model |

The full list with comments is in [`.env.example`](.env.example). The variable names there match `src/config.js`.

### Depth modes

The web interface has three modes:

| Mode | Use it for | Search queries | Pages read |
| --- | --- | --- | --- |
| **Quick** | A fast, light check | up to 2 | up to 3 |
| **Research** (default) | Most questions | up to 6 | up to 6 |
| **Deep** | Complex, high-stakes questions | up to 10 | up to 10 |

Question complexity sets how many queries are used: simple questions use 0 to 1, moderate questions 2 to 4, complex questions 4 to 8, and very complex questions up to 10. The mode caps the number, and the complexity sets the target within the cap. Largen never goes above the mode cap. The mode caps are configurable (see the table above). A research run makes at most three AI calls: one to understand the question, one to write search queries, and one to write the answer. Reading pages and scoring sources use no AI calls.

### Providers you can use

**OpenAI**

```env
AI_PROVIDER=openai-compatible
AI_API_KEY=sk-...
AI_BASE_URL=https://api.openai.com/v1
AI_MODEL=gpt-4o-mini
```

**OpenRouter, Groq, or another OpenAI-compatible service.** Change only the base URL, key, and model. Check your provider's documentation for the exact model names:

```env
AI_API_KEY=your-key
AI_BASE_URL=https://openrouter.ai/api/v1
AI_MODEL=openai/gpt-4o-mini
```

**Local model with Ollama (optional).** Largen does not need a local model. If you have one, Ollama exposes an OpenAI-compatible API. Ollama ignores the key, but Largen requires a non-empty one:

```env
AI_API_KEY=ollama
AI_BASE_URL=http://localhost:11434/v1
AI_MODEL=llama3.1
AI_JSON_MODE=0
```

**Brave Search API.** Create a key at Brave's Search API page, then:

```env
SEARCH_PROVIDER=brave
SEARCH_API_KEY=your-brave-key
```

**SearXNG (self-hosted, no key).** Run your own instance, enable the `json` output format in its settings, then:

```env
SEARCH_PROVIDER=searxng
SEARXNG_URL=http://localhost:8080
```

## Running the tests

```bash
npm test
```

The tests use mock providers and local fake HTTP servers, so they need no API keys and no internet access. They cover:

- **Question understanding and query decomposition**: planning, fallback when the model returns garbage, duplicate and near-duplicate query removal, depth caps.
- **Source scoring and deduplication**: authority, relevance, recency, and evidence scores; syndication detection; URL canonicalization.
- **Contradictions**: numeric conflicts (same unit, similar subject), and the rule that a small percentage difference is not a conflict.
- **Evidence and citations**: confidence rules, renumbering to `[1]`, `[2]`, and removal of invented citations.
- **Failures**: failed searches, failed or blocked pages, empty results, provider errors (the answer falls back to extracted excerpts and says so).
- **Conversations**: simple questions, complex questions, follow-ups, and conversation storage (including recovery from a corrupt file).
- **Security**: SSRF blocking of private addresses, the path-traversal guard, body-size limit (413), rate limit (429), validation errors (400), and that keys never appear in responses.
- **Integration over real HTTP**: the full pipeline against local fake search, page, and AI servers.
- **Frontend helpers**: safe Markdown rendering, SSE parsing, and utility functions.

Run the syntax check with `npm run check`.

## Development

```bash
npm run dev            # restarts on file changes
```

Set `LARGEN_DEBUG=1` in `.env` for verbose logs. Logs show stages, counts, and timings. They never show API keys or full page contents.

## Project structure

```
src/
  server.js              entry point: loads .env, validates config, starts HTTP, graceful shutdown
  app.js                 routes: health, conversations, chat (SSE and JSON), static files, limits
  config.js              environment → config object; warnings; public status (no secrets)
  errors.js              error classes with safe, user-facing messages
  logger.js              logger with key redaction
  utils/                 text, TTL cache, concurrency helpers, rate limiter, loose JSON parser
  llm/                   provider interface, OpenAI-compatible client (retries), mock provider
  search/                provider interface, Brave and SearXNG adapters, mock, result normalization
  retrieval/             SSRF-safe URL checks, page fetching (byte cap, redirect checks),
                         HTML extraction, passage selection
  sources/               domain classification, five-part source scoring, syndication dedupe
  evidence/              claim verification graph, numeric conflicts, evidence matrix and confidence
  orchestrator/          understand.js, plan.js, pipeline.js (the research flow)
  synthesis/             prompts, answer writing (AI or extractive fallback)
  citations/format.js    citation renumbering and the Sources list
  store/conversations.js JSON-file conversation store (atomic writes)
  api/                   HTTP helpers (headers, JSON, SSE, static files) and chat handling
frontend/                index.html, styles.css, app.js (UI), markdown.js (safe Markdown), sse.js
tests/                   node:test suites (see "Running the tests")
data/                    created at runtime: conversations.json (git-ignored)
```

## API

| Method and path | Purpose |
| --- | --- |
| `GET /api/health` | Status. Shows whether AI and search are configured and which providers are used. Never shows keys |
| `GET /api/conversations` | List conversations |
| `POST /api/conversations` | Create an empty conversation |
| `GET /api/conversations/:id` | Get one conversation with all messages |
| `PATCH /api/conversations/:id` | Rename (`{"title": "..."}`) |
| `DELETE /api/conversations/:id` | Delete |
| `POST /api/chat/stream` | Ask a question. Responds with Server-Sent Events: `status`, then `result` or `error` |
| `POST /api/chat` | Same request, JSON response (no progress events) |

Chat request body: `{ "message": "...", "mode": "quick|research|deep", "webSearch": true, "conversationId": "optional" }`.

SSE events:

- `status`: `{ "stage": "understanding|planning|searching|reading|comparing|writing", "message": "..." }`. These are short, user-safe progress messages. They do not contain the model's internal reasoning.
- `result`: `{ "conversationId": "...", "message": { "answer", "mode", "confidence", "references", "otherSources", "conflicts", "warnings", "stats" } }`
- `error`: `{ "code": "...", "message": "...", "conversationId": "..." }`

## Security notes

- **API keys stay on the server.** They are read from environment variables, are never returned by any endpoint, and are redacted in logs.
- **Web content is untrusted.** Pages are sanitized, and the browser renders answers with a safe Markdown renderer. No raw HTML from pages reaches the browser. The page sends a Content-Security-Policy header.
- **SSRF protection.** Before any page is fetched, Largen checks the address. It refuses non-HTTP(S) URLs, `localhost` and internal host names, and private, loopback, and link-local IP ranges (link-local includes cloud metadata addresses such as `169.254.169.254`). Redirects are checked again on each hop. Keep `ALLOW_PRIVATE_FETCH=0` in production.
- **Path traversal guard.** Static files are only served from `frontend/`. Encoded traversal attempts return 404.
- **Limits.** Request bodies are capped at 64 KB, questions at `MAX_QUESTION_CHARS`, and requests are rate limited per IP.
- **Errors.** Users see short messages. Unexpected errors are written to the server log (without keys), but stack traces never reach the browser.
- **No login.** Largen has no user accounts. Anyone who can reach the server can use your API keys through it. Put it behind a login (see below) before exposing it to the internet.

## Deployment

### Option 1: Docker

```bash
docker build -t largen .
docker run -d --name largen -p 8787:8787 --env-file .env -v largen-data:/data largen
```

The container stores conversations in `/data`, which is a Docker volume, so they survive restarts.

### Option 2: any server with Node 22

```bash
npm start           # no dependencies to install; set the variables in .env first
```

Use a process manager such as `systemd` or `pm2` to restart it on failure.

### Put it behind HTTPS and a login

Largen has no login of its own. For a public deployment:

1. Terminate HTTPS at a reverse proxy (Caddy, nginx, or a hosting platform's load balancer).
2. Add authentication at the proxy (for example, HTTP basic auth or single sign-on).
3. Set `TRUST_PROXY=1` so rate limits use the real client address.
4. Keep `ALLOW_PRIVATE_FETCH=0`.

## Replacing a provider

Each provider is one small module with a fixed interface.

**AI provider**: `src/llm/provider.js`. A provider has a `name` and an async `complete({ system, messages, json, maxTokens, temperature })` method that returns `{ text }`. Write a class with that method, then add a `case` for it in `createLLMProvider`. Add the name to the allowed list in `src/config.js`.

**Search provider**: `src/search/provider.js`. A provider has a `name` and an async `search(query, { count })` method that returns an array of `{ title, url, snippet, publishedAt, provider }`. On failure, throw a `SearchError`. Largen treats one failed query as one fewer source, not as a crash. Add a `case` in `createSearchProvider` and the name in `src/config.js`. Use `src/search/brave.js` as a template.

## Known limitations

- **No accounts or login** (see Security notes). Anyone who can reach the server can spend your API quota.
- **Single process, in-memory state.** Caches and rate limits reset on restart and are not shared between multiple server instances. The JSON-file store suits one user or a small team, not heavy multi-user traffic.
- **Pages that need JavaScript** (many news sites and web apps) return little or no text and are skipped. PDFs and images are not read.
- **Contradiction detection is fallible.** Numeric heuristics are supplemented by model-assessed semantic comparisons with validated quotes. Neither guarantees correct interpretation or complete coverage. Confidence ratings are deterministic rules, not a statistical measure of truth.
- **Authority and recency scores come from rules.** Domain lists in `src/sources/domains.js` are a starting point, not a complete ranking.
- **DNS rebinding.** The address check happens before fetching, but a hostile DNS server could still point a public name to a private address during the request. Run Largen in a network that blocks private destinations for full protection.
- **Real providers are not exercised in the automated tests.** The tests use mocks and local fake servers. The OpenAI-compatible, Brave, and SearXNG adapters follow their documented APIs but should be checked with a real key before you rely on them.
- **Progress is by stage**, not token by token. The answer appears once it is complete.
- **Cost.** Deep mode can make up to 10 searches and read 10 pages, plus several AI calls. Lower the caps if cost matters.

## Next steps

1. Evaluate and improve claim entailment and semantic contradiction accuracy.
2. Improve query planning around missing facets and unresolved evidence.
3. Add bounded PDF/document retrieval.
4. Add dynamic research stopping and targeted follow-up searches within hard budgets.
5. Strengthen primary-source and editorial-independence detection.

Accounts, streaming, exports, and storage changes are secondary to the evidence engine.

## License

Not yet specified. Add a `LICENSE` file before publishing.


## Claim-level evidence verification

Between retrieval and writing, Largen makes one additional cloud-model call to extract
up to 12 atomic claims and compare their scope against the retrieved excerpts. It handles
wording disagreements, not only differing numbers. The analyst is instructed to distinguish
real contradictions from differences in time, jurisdiction, population, and conditions
(for example, a general prohibition can coexist with a conditional exception).

The API's additive `evidenceGraph` field exposes:

- `status`: `assessed` or `unavailable` (with a machine-readable reason).
- `method`: `model_assessed_quote_grounded` for completed assessments.
- `sources`: IDs of the passages actually sent to the verifier.
- `claims`: claim IDs, precise text, status, supporting-domain count, and evidence edges.
- Each edge contains a source ID, `supports` / `contradicts` / `irrelevant`, an exact
  passage quote, and the model's explanation.
- Claim status is `corroborated`, `single_source`, `contested`, `contradicted`, or
  `unverified`. Contested claims also appear in the existing conflicts response.

Unknown IDs, invented quotes, malformed edges, snippets, and syndicated copies cannot
establish graph support. Quotes must occur within the actual excerpt supplied to the
analyst (whitespace normalized). Same-domain sources count once for corroboration.
Input uses the existing evidence/passages character budgets, at most 12 sources, and a
3,500-token output cap. No dependency, database, or local model is added.

The writer receives the graph and must preserve qualifications and disagreements.
Returned factual claims are linked by exact normalized wording, never fuzzy similarity;
an unmatched writer claim remains unverified even if its citation exists. Factual claims
expose `verification`, `supported`, `confidence`, and `conflicted` fields. `supported`
means a cited supporting edge exists, **not** that a contested claim is true. Missing or
incomplete verification prevents a high overall confidence rating. Provider failures,
malformed output, no readable pages, or a deadline reached before verification degrade
explicitly rather than aborting the research.

**Limits:** Quote matching establishes provenance, not entailment or truth. Semantic
relations still depend on the cloud model and can be wrong; this is not an independent
fact-checker. Domain diversity does not guarantee editorial independence. Verification
covers selected excerpts and extracted claims, not every sentence in the answer, and
exact wording matching intentionally leaves paraphrases unverified. Current confidence
remains partly heuristic. Live-provider accuracy needs evaluation; automated tests use
scripted model outputs. PDF retrieval, dynamic stopping, and automatic follow-up searches
remain future work.
