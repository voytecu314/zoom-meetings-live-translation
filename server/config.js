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
    provider: process.env.TRANSLATION_PROVIDER || 'mock',
    apiKey: process.env.TRANSLATION_API_KEY || '',
    concurrency: Math.max(1, int(process.env.TRANSLATION_CONCURRENCY, 4)),
    timeoutMs: Math.max(500, int(process.env.TRANSLATION_TIMEOUT_MS, 8000)),
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
    // LIVE streaming: buffered text that has not reached a sentence end is
    // translated after this many ms without new text (speaker paused).
    pauseThresholdMs: Math.max(200, int(process.env.PAUSE_THRESHOLD_MS, 1200)),
    // LIVE streaming: translate a buffered chunk as soon as it holds this
    // many words (half of it when it ends at a clause boundary).
    streamMinWords: Math.max(2, int(process.env.STREAM_MIN_WORDS, 8)),
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
