// HTTP server: Express routes + WebSocket upgrade.
// Public deployment note: run behind HTTPS (reverse proxy or secure tunnel)
// so browsers get WSS for the WebSocket and a secure context for
// getDisplayMedia / speech APIs. See README "Deployment".

import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { createSession, getSession, closeSession } from './sessions.js';
import { setupWebSocket } from './websocket.js';
import { createTranscriptionProvider } from './transcription/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.disable('x-powered-by');
if (config.env.trustProxy) app.set('trust proxy', true); // req.ip / req.protocol from X-Forwarded-*
app.use(express.json({ limit: '32kb' }));

// Minimal security headers.
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

// Very basic in-memory rate limiting for the API (per IP, per minute).
const apiHits = new Map();
app.use('/api', (req, res, next) => {
  const ip = req.ip || req.socket.remoteAddress || '?';
  const now = Date.now();
  const windowMs = 60000;
  const hits = apiHits.get(ip)?.filter((t) => now - t < windowMs) ?? [];
  hits.push(now);
  apiHits.set(ip, hits);
  if (apiHits.size > 5000) {
    for (const [k, v] of apiHits) if (!v.some((t) => now - t < windowMs)) apiHits.delete(k);
  }
  const limit = 60;
  if (hits.length > limit) {
    return res.status(429).json({ error: 'rate limit exceeded' });
  }
  next();
});

// ------------------------------------------------------------------
// Static pages
// ------------------------------------------------------------------

const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir, { index: false, maxAge: config.env.nodeEnv === 'production' ? '1h' : 0 }));

app.get('/', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));
app.get('/host', (_req, res) => res.sendFile(path.join(publicDir, 'host.html')));
app.get('/live/:sessionId', (req, res) => {
  const session = getSession(req.params.sessionId);
  if (!session || session.closed) {
    return res.status(404).sendFile(path.join(publicDir, 'session-ended.html'));
  }
  res.sendFile(path.join(publicDir, 'live.html'));
});

// ------------------------------------------------------------------
// API
// ------------------------------------------------------------------

app.get('/health', (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

// Create a session. Returns hostToken (for the host) and viewerUrl (safe to share).
app.post('/api/sessions', (req, res) => {
  const { sourceLanguage, targetLanguages } = req.body ?? {};
  if (sourceLanguage && (typeof sourceLanguage !== 'string' || sourceLanguage.length > 12)) {
    return res.status(400).json({ error: 'invalid sourceLanguage' });
  }
  if (targetLanguages !== undefined &&
      (!Array.isArray(targetLanguages) || targetLanguages.length > 8 ||
        targetLanguages.some((t) => typeof t !== 'string' || t.length > 12))) {
    return res.status(400).json({ error: 'invalid targetLanguages' });
  }
  const session = createSession({
    sourceLanguage: sourceLanguage || 'en',
    targetLanguages: Array.isArray(targetLanguages) ? targetLanguages : ['en'],
  });
  // Prefer an explicitly configured public URL; otherwise use the address the
  // host is actually browsing from (a hard-coded http://localhost:3000 link is
  // useless to anyone but the host).
  const base = config.env.publicBaseUrlExplicit
    ? config.env.publicBaseUrl
    : `${req.protocol}://${req.get('host')}`;
  const viewerUrl = `${base}/live/${session.id}`;
  console.log(`[http] session created ${session.id}`);
  res.status(201).json({
    sessionId: session.id,
    hostToken: session.hostToken,
    viewerUrl,
  });
});

// Host-side session info (requires host token, never exposed to viewers).
app.get('/api/sessions/:id', (req, res) => {
  const session = getSession(req.params.id);
  if (!session || session.closed) return res.status(404).json({ error: 'session not found' });
  const token = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (token !== session.hostToken) return res.status(403).json({ error: 'forbidden' });
  res.json({
    sessionId: session.id,
    sourceLanguage: session.sourceLanguage,
    targetLanguages: session.targetLanguages,
    viewerCount: session.viewers.size,
  });
});

// Host deletes/ends the session explicitly.
app.delete('/api/sessions/:id', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'session not found' });
  const token = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (token !== session.hostToken) return res.status(403).json({ error: 'forbidden' });
  closeSession(session.id);
  res.json({ ok: true });
});

// ------------------------------------------------------------------
// Fallbacks
// ------------------------------------------------------------------

app.use((_req, res) => res.status(404).send('Not found'));

// Error handler — never leak stack traces to clients.
app.use((err, _req, res, _next) => {
  console.error('[http] error:', err?.message ?? err);
  res.status(500).json({ error: 'internal error' });
});

// ------------------------------------------------------------------
// Boot
// ------------------------------------------------------------------

const httpServer = http.createServer(app);
const ws = setupWebSocket(httpServer, httpServer); // WebSocket upgrade on same server

// Optional server-side transcription provider (only used by fallback flow).
const transcriptionProvider = createTranscriptionProvider();
if (transcriptionProvider) {
  console.log(`[http] server-side transcription provider: ${transcriptionProvider.name}`);
}

httpServer.listen(config.env.port, () => {
  console.log(`zoom-live-translate listening on http://localhost:${config.env.port}`);
  console.log(`  host page:  ${config.env.publicBaseUrl}/host`);
  console.log(`  health:     http://localhost:${config.env.port}/health`);
  console.log(`  env:        ${config.env.nodeEnv}, provider=${config.translation.provider}`);
});

export { app, httpServer, ws };
