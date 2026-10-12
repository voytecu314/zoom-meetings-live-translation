// Translation module entry point.
// Provides translateText(text, sourceLanguage, targetLanguage) backed by a
// pluggable provider, with a concurrency limit, retries for retryable
// errors, and timeouts — so provider failures never crash the server.

import { config } from '../config.js';
import { createMockProvider } from './mock.js';
import { createRateLimiter, TranslationError } from './provider-interface.js';

let provider = null;
let limiter = null;

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 500;

/** Build the provider named in config (or override for tests). */
export function initTranslationProvider(overrideName = null) {
  const name = overrideName ?? config.translation.provider;
  if (provider && !overrideName) return provider;
  switch (name) {
    case 'mock':
      provider = createMockProvider();
      break;
    case 'google-x':
      // Lazy import so the optional dependency is only resolved when selected.
      provider = null; // resolved on first call to translate below
      limiter = createRateLimiter(config.translation.concurrency);
      return 'google-x';
    default:
      throw new Error(`Unknown TRANSLATION_PROVIDER "${name}". Use "mock" or "google-x".`);
  }
  limiter = createRateLimiter(config.translation.concurrency);
  return name === 'mock' ? provider : name;
}

async function getGoogleProvider() {
  try {
    const mod = await import('google-translate-api-x');
    const { createGoogleTranslateProvider } = await import('./google-translate.js');
    const p = createGoogleTranslateProvider();
    // Sanity check optional dep is really there.
    if (!mod.default && !mod.translate) {
      throw new Error('google-translate-api-x did not load correctly');
    }
    return p;
  } catch (err) {
    throw new TranslationError(
      'Provider "google-x" requires the optional dependency google-translate-api-x. ' +
        'Install it with: npm i google-translate-api-x — or switch TRANSLATION_PROVIDER=mock. ' +
        `Original error: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    );
  }
}

function ensureLimiter() {
  if (!limiter) limiter = createRateLimiter(config.translation.concurrency);
}

/**
 * Translate `text` from sourceLanguage to targetLanguage.
 * Applies the configured concurrency limit, timeout and retries.
 * Never throws — resolves to { ok, text } or { ok, error }.
 */
export async function translateText(text, sourceLanguage, targetLanguage) {
  if (!text?.trim()) return { ok: true, text: '' };
  ensureLimiter();
  try {
    const result = await limiter.run(async () => {
      let lastErr = null;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          // Resolve the provider per config on first use (mock by default);
          // a null provider here must NEVER mean "use google-x" silently.
          if (!provider) initTranslationProvider();
          let p = provider;
          if (!p) {
            // Only reachable when config selects google-x.
            p = await getGoogleProvider();
            provider = p;
          }
          const withTimeout = Promise.race([
            p.translate(text, sourceLanguage, targetLanguage),
            new Promise((_, reject) =>
              setTimeout(
                () => reject(new TranslationError('translation timed out', { retryable: true })),
                config.translation.timeoutMs
              )
            ),
          ]);
          const out = await withTimeout;
          if (typeof out !== 'string') {
            throw new TranslationError('provider returned non-string result');
          }
          return out;
        } catch (err) {
          lastErr = err;
          const isLast = attempt === MAX_ATTEMPTS;
          const retryable = err?.retryable || (err instanceof Error && /timed?\s?out|429|rate/i.test(err.message));
          if (isLast || !retryable) break;
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * attempt));
        }
      }
      throw lastErr instanceof TranslationError
        ? lastErr
        : new TranslationError(`translation failed: ${lastErr?.message ?? lastErr}`, { cause: lastErr });
    });
    return { ok: true, text: result };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Test helper: force a provider instance (bypassing config). */
export function __setProviderForTests(p) {
  provider = p;
  ensureLimiter();
}
