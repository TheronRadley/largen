/**
 * Fetches a web page safely:
 * - http(s) only, public hosts only (checked on every redirect hop)
 * - hard timeout and byte limit
 * - only HTML / plain text is accepted
 * Failures throw PageError with a machine-readable code; callers record them and move on.
 */
import { PageError } from '../errors.js';
import { assertPublicHost, parseHttpUrl } from './safeUrl.js';

export const USER_AGENT = 'Mozilla/5.0 (compatible; LargenResearchBot/0.1; +research assistant)';
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const ACCEPTED_TYPES = /^(text\/html|application\/xhtml\+xml|text\/plain)/i;

export async function fetchPage(
  rawUrl,
  { timeoutMs = 12_000, maxBytes = 1_500_000, allowPrivate = false, fetchImpl = globalThis.fetch, lookup, maxRedirects = 3 } = {}
) {
  let url = parseHttpUrl(rawUrl);
  if (!url) throw new PageError('Invalid or unsupported URL', 'invalid_url');

  for (let hop = 0; ; hop++) {
    try {
      await assertPublicHost(url.hostname, { allowPrivate, lookup });
    } catch (err) {
      throw err instanceof PageError ? err : new PageError('Blocked host', 'blocked_host');
    }

    let res;
    try {
      res = await fetchImpl(url.href, {
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          'user-agent': USER_AGENT,
          accept: 'text/html,application/xhtml+xml,text/plain;q=0.8',
          'accept-language': 'en;q=0.9',
        },
      });
    } catch (err) {
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
        throw new PageError('Page timed out', 'timeout');
      }
      throw new PageError(`Network error: ${err?.code ?? err?.name ?? 'unknown'}`, 'network');
    }

    if (REDIRECT_STATUSES.has(res.status)) {
      const location = res.headers.get('location');
      await res.body?.cancel?.().catch(() => {});
      if (!location || hop >= maxRedirects) throw new PageError('Too many redirects', 'redirect');
      const next = parseHttpUrl(new URL(location, url).href);
      if (!next) throw new PageError('Redirected to an unsupported URL', 'invalid_url');
      url = next;
      continue;
    }

    if (res.status === 401 || res.status === 403) throw new PageError(`HTTP ${res.status}`, 'blocked');
    if (res.status === 404 || res.status === 410) throw new PageError(`HTTP ${res.status}`, 'not_found');
    if (res.status === 429) throw new PageError('HTTP 429', 'rate_limited');
    if (!res.ok) throw new PageError(`HTTP ${res.status}`, 'http_error');

    const contentType = res.headers.get('content-type') ?? '';
    if (!ACCEPTED_TYPES.test(contentType)) {
      await res.body?.cancel?.().catch(() => {});
      throw new PageError(`Unsupported content type: ${contentType || 'unknown'}`, 'unsupported_type');
    }

    const { text, truncated } = await readLimited(res, maxBytes, contentType);
    return { url: url.href, contentType, text, truncated };
  }
}

async function readLimited(res, maxBytes, contentType) {
  const charset = (contentType.match(/charset=([^;\s]+)/i)?.[1] ?? 'utf-8').replace(/["']/g, '');
  let decoder;
  try {
    decoder = new TextDecoder(charset);
  } catch {
    decoder = new TextDecoder('utf-8');
  }
  if (!res.body) {
    const buf = Buffer.from(await res.arrayBuffer());
    return { text: decoder.decode(buf.subarray(0, maxBytes)), truncated: buf.length > maxBytes };
  }

  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        chunks.push(value.subarray(0, value.byteLength - (total - maxBytes)));
        truncated = true;
        await reader.cancel().catch(() => {});
        break;
      }
      chunks.push(value);
    }
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw new PageError('Page timed out while downloading', 'timeout');
    }
    throw new PageError('Failed while downloading page', 'network');
  }
  return { text: decoder.decode(Buffer.concat(chunks.map((c) => Buffer.from(c)))), truncated };
}
