/**
 * Small structured logger. Debug lines only print when LARGEN_DEBUG is on.
 * Any field whose name looks like a secret is redacted before printing.
 */
const SECRET_FIELD = /(key|token|secret|password|passwd|authorization|cookie)/i;

export function redact(fields) {
  if (!fields || typeof fields !== 'object') return fields;
  const out = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = SECRET_FIELD.test(k) ? '[redacted]' : v;
  }
  return out;
}

export function createLogger({ debug = false, sink = console } = {}) {
  const write = (level, message, fields) => {
    if (level === 'debug' && !debug) return;
    const ts = new Date().toISOString();
    const suffix = fields && Object.keys(fields).length ? ` ${safeJson(redact(fields))}` : '';
    const line = `${ts} ${level.toUpperCase().padEnd(5)} ${message}${suffix}`;
    if (level === 'error' || level === 'warn') sink.error(line);
    else sink.log(line);
  };
  return {
    debugEnabled: debug,
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
  };
}

export const silentLogger = {
  debugEnabled: false,
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function safeJson(value) {
  try {
    return JSON.stringify(value, (_k, v) => (typeof v === 'string' && v.length > 300 ? `${v.slice(0, 300)}…` : v));
  } catch {
    return '{}';
  }
}
