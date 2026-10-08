/**
 * Error types. `message` is for developers (logs). `publicMessage` is safe to show users.
 * Raw stack traces and provider response bodies never reach the UI.
 */
export class LargenError extends Error {
  constructor(message, { code = 'internal_error', status = 500, publicMessage } = {}) {
    super(message);
    this.name = 'LargenError';
    this.code = code;
    this.status = status;
    this.publicMessage = publicMessage ?? message;
  }
}

export class ConfigError extends LargenError {
  constructor(message) {
    super(message, { code: 'config_error', status: 500, publicMessage: message });
    this.name = 'ConfigError';
  }
}

export class ValidationError extends LargenError {
  constructor(message, { status = 400 } = {}) {
    super(message, { code: 'invalid_input', status, publicMessage: message });
    this.name = 'ValidationError';
  }
}

export class NotConfiguredError extends LargenError {
  constructor(message, publicMessage) {
    super(message, { code: 'not_configured', status: 503, publicMessage: publicMessage ?? message });
    this.name = 'NotConfiguredError';
  }
}

export class ProviderError extends LargenError {
  constructor(message, { code = 'provider_error', publicMessage } = {}) {
    super(message, {
      code,
      status: 502,
      publicMessage: publicMessage ?? 'The AI provider could not complete this request. Please try again.',
    });
    this.name = 'ProviderError';
  }
}

export class SearchError extends LargenError {
  constructor(message, { code = 'search_failed', publicMessage } = {}) {
    super(message, {
      code,
      status: 502,
      publicMessage: publicMessage ?? 'Web search failed for part of this question.',
    });
    this.name = 'SearchError';
  }
}

export class PageError extends LargenError {
  constructor(message, code = 'page_failed') {
    super(message, { code, status: 502, publicMessage: 'This page could not be read.' });
    this.name = 'PageError';
  }
}

export class BusyError extends LargenError {
  constructor(message = 'Largen is busy with other research right now.') {
    super(message, { code: 'busy', status: 429, publicMessage: message });
    this.name = 'BusyError';
  }
}

/** Convert anything thrown into a safe `{ status, code, message }` triple. */
export function toPublicError(err) {
  if (err instanceof LargenError) {
    return { status: err.status, code: err.code, message: err.publicMessage };
  }
  return {
    status: 500,
    code: 'internal_error',
    message: 'Something went wrong while researching this question. Please try again.',
  };
}
