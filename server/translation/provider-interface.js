// Translation provider interface documentation + shared helpers.
//
// Every translation provider must implement:
//
//   createProvider(options) => {
//     name: string,
//     translate(text, sourceLanguage, targetLanguage) => Promise<string>,
//     // Optional: batchTranslate(texts[], source, target) => Promise<string[]>
//   }
//
// Errors must be thrown as Error instances; the pipeline serializes them to
// the host as recoverable error messages, never crashes the server.

export class TranslationError extends Error {
  constructor(message, { cause, retryable = false } = {}) {
    super(message);
    this.name = 'TranslationError';
    this.retryable = retryable;
    if (cause) this.cause = cause;
  }
}

/** Fetch with timeout (AbortController). */
export async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Simple concurrency-limited async queue. */
export function createRateLimiter(concurrency) {
  let active = 0;
  const waiting = [];
  return {
    async acquire() {
      if (active < concurrency) {
        active++;
        return;
      }
      await new Promise((resolve) => waiting.push(resolve));
      active++;
    },
    release() {
      active--;
      const next = waiting.shift();
      if (next) next();
    },
    async run(fn) {
      await this.acquire();
      try {
        return await fn();
      } finally {
        this.release();
      }
    },
  };
}
