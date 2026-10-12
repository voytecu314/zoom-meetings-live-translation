// Central configuration, read from environment (optionally a local .env file).
// All values have safe defaults so the server boots with zero configuration.

function int(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

// Try to load a local .env file without requiring an extra dependency.
try {
  const { readFileSync } = await import('node:fs');
  const raw = readFileSync(new URL('../.env', import.meta.url), 'utf8');
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2];
    }
  }
} catch {
  // No .env file present — that is fine, defaults below apply.
}

export const config = {
  env: {
    port: int(process.env.PORT, 3000),
    nodeEnv: process.env.NODE_ENV || 'development',
    publicBaseUrl: (process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, ''),
    // When PUBLIC_BASE_URL is NOT set, viewer links are derived from the
    // request the host used (so a link shared from a tunnel/proxy works
    // instead of pointing at http://localhost:3000).
    publicBaseUrlExplicit: !!process.env.PUBLIC_BASE_URL,
    // Behind a reverse proxy / tunnel every client shares the proxy's socket
    // address; trust X-Forwarded-For so per-IP limits apply per real client.
    trustProxy: (process.env.TRUST_PROXY ?? 'true') !== 'false',
  },

  translation: {
    // mock | google-x | llm
    provider: process.env.TRANSLATION_PROVIDER || 'mock',
    // Used when the primary provider fails or is over quota ('' = none).
    // Defaults to google-x when the primary is llm.
    fallback: process.env.TRANSLATION_FALLBACK ?? (process.env.TRANSLATION_PROVIDER === 'llm' ? 'google-x' : ''),
    apiKey: process.env.TRANSLATION_API_KEY || '',
    concurrency: Math.max(1, int(process.env.TRANSLATION_CONCURRENCY, 4)),
    timeoutMs: Math.max(500, int(process.env.TRANSLATION_TIMEOUT_MS, 8000)),
  },

  // OpenAI-compatible chat API used by TRANSLATION_PROVIDER=llm.
  llm: {
    baseUrl: process.env.LLM_BASE_URL || 'https://router.bynara.id/v1',
    apiKey: process.env.LLM_API_KEY || '',
    model: process.env.LLM_MODEL || 'deepseek-v4-flash',
    timeoutMs: Math.max(1000, int(process.env.LLM_TIMEOUT_MS, 6000)),
    reasoningEffort: process.env.LLM_REASONING_EFFORT ?? 'none',
    // After a quota/auth error, skip the LLM for this long (it is retried afterwards).
    quotaCooldownMs: Math.max(1000, int(process.env.LLM_QUOTA_COOLDOWN_MS, 600000)),
    // Also use the LLM for live drafts (default: drafts use the fallback MT to save quota).
    drafts: (process.env.LLM_DRAFTS ?? 'false') === 'true',
    // How many earlier lines are sent as context with each final translation.
    contextLines: Math.max(0, int(process.env.LLM_CONTEXT_LINES, 3)),
  },

  transcription: {
    provider: process.env.TRANSCRIPTION_PROVIDER || 'none',
    apiKey: process.env.TRANSCRIPTION_API_KEY || '',
    apiUrl: process.env.TRANSCRIPTION_API_URL || '',
  },

  sessions: {
    // Seconds of host inactivity before a session expires; 0 disables expiry.
    timeoutSeconds: int(process.env.SESSION_TIMEOUT_SECONDS, 3600),
    // Seconds viewers may stay connected after the host leaves.
    viewerGraceSeconds: int(process.env.VIEWER_GRACE_SECONDS, 60),
    // Max queued messages kept per viewer catch-up buffer.
    historyLimit: int(process.env.HISTORY_LIMIT, 200),
  },

  segmentation: {
    // If a buffered fragment exceeds this many chars without terminal
    // punctuation, flush it at the last clause boundary. 0 disables.
    maxBufferChars: int(process.env.MAX_BUFFER_CHARS, 0),
    // An utterance (what gets translated as ONE unit) ends at terminal
    // punctuation, at a speaker pause signalled by the host, or - as a
    // fallback if that signal is lost - after this many ms without new text.
    pauseThresholdMs: Math.max(200, int(process.env.PAUSE_THRESHOLD_MS, 1800)),
    // A host-detected pause right after a dangling word ("and", "the", "to"...)
    // keeps the utterance open this long (ms) before finalizing. 0 disables.
    danglingHoldMs: Math.max(0, int(process.env.DANGLING_HOLD_MS, 3000)),
    // Safety valve: an utterance this long (words; ~2 chars each for ja/zh/th)
    // is finalized even without a pause, to bound latency.
    maxUtteranceWords: Math.max(8, int(process.env.MAX_UTTERANCE_WORDS, 60)),
    // Live DRAFT translations of the still-open utterance (replaced in place
    // on the viewer, never spoken). Costs extra translation requests.
    draftTranslations: (process.env.DRAFT_TRANSLATIONS ?? 'true') !== 'false',
    draftIntervalMs: Math.max(250, int(process.env.DRAFT_INTERVAL_MS, 1000)),
    draftMinWords: Math.max(1, int(process.env.DRAFT_MIN_WORDS, 3)),
    draftMinNewWords: Math.max(1, int(process.env.DRAFT_MIN_NEW_WORDS, 2)),
  },

  // WebSocket guards
  ws: {
    maxPayloadBytes: int(process.env.WS_MAX_PAYLOAD_BYTES, 64 * 1024),
    maxConnectionsPerIp: int(process.env.WS_MAX_CONNECTIONS_PER_IP, 200),
    heartbeatMs: int(process.env.WS_HEARTBEAT_MS, 30000),
    allowedOrigins: (process.env.WS_ALLOWED_ORIGINS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },
};
