// Translation module entry point.
// translateText(text, sourceLanguage, targetLanguage, opts) runs through an
// ordered provider CHAIN (primary → fallback) with a concurrency limit,
// timeouts, retries and a per-provider circuit breaker, so provider failures
// (or an exhausted free quota) never stop captions and never crash the server.
//
//   quality 'final' : [primary, fallback]   e.g. [llm, google-x]
//   quality 'draft' : [fallback ?? primary] when primary is llm (saves quota)
//                     unless LLM_DRAFTS=true
//
// opts: { quality: 'final' | 'draft', context: [{ source, translation? }] }
// `context` is only used by providers that can use it (llm).

import { config } from '../config.js';
import { createMockProvider } from './mock.js';
import { createRateLimiter, TranslationError } from './provider-interface.js';

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 500;
const TRANSIENT_FAILS_BEFORE_OPEN = 3;
const TRANSIENT_COOLDOWN_MS = 60_000;

let limiter = null;
let forcedChain = null; // tests: { final: [...], draft: [...] }
const cache = new Map(); // provider name -> provider instance
const health = new Map(); // provider name -> { openUntil, fails }

function ensureLimiter() {
  if (!limiter) limiter = createRateLimiter(config.translation.concurrency);
}

async function getGoogleProvider() {
  try {
    const mod = await import('google-translate-api-x');
    const { createGoogleTranslateProvider } = await import('./google-translate.js');
    if (!mod.default && !mod.translate) throw new Error('google-translate-api-x did not load correctly');
    return createGoogleTranslateProvider();
  } catch (err) {
    throw new TranslationError(
      'Provider "google-x" requires the optional dependency google-translate-api-x. ' +
        'Install it with: npm i google-translate-api-x — or switch TRANSLATION_PROVIDER=mock. ' +
        `Original error: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    );
  }
}

async function getProvider(name) {
  if (cache.has(name)) return cache.get(name);
  let p;
  switch (name) {
    case 'mock': p = createMockProvider(); break;
    case 'google-x': p = await getGoogleProvider(); break;
    case 'llm': {
      const { createLlmProvider } = await import('./llm.js');
      p = createLlmProvider(config.llm);
      break;
    }
    default:
      throw new Error(`Unknown translation provider "${name}". Use "mock", "google-x" or "llm".`);
  }
  cache.set(name, p);
  return p;
}

/** Validate configuration at startup (throws on a bad provider name / missing key). */
export function initTranslationProvider(overrideName = null) {
  const name = overrideName ?? config.translation.provider;
  if (!['mock', 'google-x', 'llm'].includes(name)) {
    throw new Error(`Unknown TRANSLATION_PROVIDER "${name}". Use "mock", "google-x" or "llm".`);
  }
  if (name === 'llm' && !config.llm.apiKey) {
    throw new Error('TRANSLATION_PROVIDER=llm requires LLM_API_KEY.');
  }
  ensureLimiter();
  return name;
}

/** Ordered provider names to try for this quality. */
function chainNames(quality) {
  const primary = config.translation.provider;
  const fallback = config.translation.fallback && config.translation.fallback !== primary
    ? config.translation.fallback
    : null;
  if (primary === 'llm' && quality === 'draft' && !config.llm.drafts && fallback) return [fallback];
  return fallback ? [primary, fallback] : [primary];
}

function isOpen(name) {
  const h = health.get(name);
  return !!h && h.openUntil > Date.now();
}

function recordFailure(name, err) {
  const h = health.get(name) ?? { openUntil: 0, fails: 0 };
  h.fails += 1;
  if (err?.cooldownMs) {
    h.openUntil = Date.now() + err.cooldownMs; // quota / rate limit / auth: open immediately
  } else if (h.fails >= TRANSIENT_FAILS_BEFORE_OPEN) {
    h.openUntil = Date.now() + TRANSIENT_COOLDOWN_MS;
  }
  health.set(name, h);
}

function recordSuccess(name) {
  health.set(name, { openUntil: 0, fails: 0 });
}

/** One provider with timeout + retries. Throws the last error. */
async function runProvider(p, text, sourceLanguage, targetLanguage, opts) {
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      let timer;
      const call = Promise.race([
        p.translate(text, sourceLanguage, targetLanguage, opts),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new TranslationError('translation timed out', { retryable: true })),
            config.translation.timeoutMs
          );
        }),
      ]);
      let out;
      try { out = await call; } finally { clearTimeout(timer); }
      if (typeof out !== 'string') throw new TranslationError('provider returned non-string result');
      return out;
    } catch (err) {
      lastErr = err;
      const retryable = !err?.cooldownMs &&
        (err?.retryable || (err instanceof Error && /timed?\s?out|429|rate/i.test(err.message)));
      if (attempt === MAX_ATTEMPTS || !retryable) break;
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * attempt));
    }
  }
  throw lastErr instanceof TranslationError
    ? lastErr
    : new TranslationError(`translation failed: ${lastErr?.message ?? lastErr}`, { cause: lastErr });
}

/**
 * Translate `text`. Never throws — resolves to { ok:true, text, provider } or
 * { ok:false, error }.
 */
export async function translateText(text, sourceLanguage, targetLanguage, opts = {}) {
  if (!text?.trim()) return { ok: true, text: '' };
  // Nothing to translate when the viewer language equals the spoken language.
  if (sourceLanguage && targetLanguage &&
      String(sourceLanguage).split('-')[0].toLowerCase() === String(targetLanguage).split('-')[0].toLowerCase()) {
    return { ok: true, text };
  }
  const quality = opts.quality === 'draft' ? 'draft' : 'final';
  ensureLimiter();

  // Resolve the chain: [{ name, get() }]
  let entries;
  if (forcedChain) {
    entries = (forcedChain[quality] ?? forcedChain.final).map((p) => ({ name: p.name, get: async () => p }));
  } else {
    entries = chainNames(quality).map((name) => ({ name, get: () => getProvider(name) }));
  }
  // Skip providers whose circuit is open — unless nothing else is left.
  const usable = entries.filter((e) => !isOpen(e.name));
  const chain = usable.length ? usable : entries.slice(-1);

  let lastErr = null;
  for (const e of chain) {
    try {
      const p = await e.get();
      const out = await limiter.run(() => runProvider(p, text, sourceLanguage, targetLanguage, opts));
      recordSuccess(e.name);
      return { ok: true, text: out, provider: e.name };
    } catch (err) {
      lastErr = err;
      recordFailure(e.name, err);
      console.warn(`[translation] ${e.name} failed (${quality}): ${err?.message ?? err}${chain.length > 1 ? ' — trying fallback' : ''}`);
    }
  }
  return { ok: false, error: lastErr instanceof Error ? lastErr.message : String(lastErr) };
}

/** Test helper: force a single provider (bypassing config). */
export function __setProviderForTests(p) {
  forcedChain = { final: [p], draft: [p] };
  ensureLimiter();
}

/** Test helper: force explicit chains, e.g. { final: [llm, mt], draft: [mt] }. */
export function __setChainForTests(chains) {
  forcedChain = chains;
  health.clear();
  ensureLimiter();
}

/** Test helper: forget circuit-breaker state. */
export function __resetHealthForTests() {
  health.clear();
}
