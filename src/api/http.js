/**
 * Small HTTP helpers: JSON bodies, responses, security headers, static files, SSE.
 * No framework: the server is one Node http server.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ValidationError } from '../errors.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

export const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

export function applySecurityHeaders(res) {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
}

export function sendJson(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(payload);
}

export function sendError(res, status, code, message, extraHeaders = {}) {
  sendJson(res, status, { error: { code, message } }, extraHeaders);
}

/**
 * Reads and parses a JSON body with a size limit. Throws ValidationError on bad input.
 */
export function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > maxBytes) {
      req.resume();
      reject(new ValidationError('Request is too large.', { status: 413 }));
      return;
    }
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > maxBytes) {
        failed = true;
        reject(new ValidationError('Request is too large.', { status: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (failed) return;
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(new ValidationError('Request body must be a JSON object.'));
          return;
        }
        resolve(parsed);
      } catch {
        reject(new ValidationError('Request body must be valid JSON.'));
      }
    });
    req.on('error', () => reject(new ValidationError('Could not read the request.')));
  });
}

/**
 * Serves a file from `rootDir` only. Rejects traversal attempts and anything that is not a file.
 */
export function serveStatic(req, res, rootDir, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return sendError(res, 400, 'invalid_path', 'Bad request path.');
  }
  if (rel === '/' || rel === '') rel = '/index.html';
  const root = path.resolve(rootDir);
  const target = path.resolve(root, `.${rel}`);
  if (target !== root && !target.startsWith(root + path.sep)) {
    return sendError(res, 404, 'not_found', 'Not found.');
  }
  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    return sendError(res, 404, 'not_found', 'Not found.');
  }
  if (!stat.isFile()) return sendError(res, 404, 'not_found', 'Not found.');

  const type = MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache',
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(target).pipe(res);
  return undefined;
}

/** Server-Sent Events writer with a keep-alive heartbeat. */
export function openSse(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n');
  }, 15_000);
  heartbeat.unref?.();
  return {
    send(event, data) {
      if (res.writableEnded) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    close() {
      clearInterval(heartbeat);
      if (!res.writableEnded) res.end();
    },
  };
}
