// Session manager.
// Owns session lifecycle, authorization tokens, viewer catch-up history and
// expiry. Storage is in-memory only — nothing about the meeting is persisted.

import { randomBytes } from 'node:crypto';
import { config } from './config.js';

const sessions = new Map(); // sessionId -> session object

/** Random, unguessable id using cryptographic randomness. */
export function generateSessionId() {
  return randomBytes(8).toString('base64url'); // ~11 chars, 64 bits of entropy
}

/** Separate secret token for host authorization (never in the viewer URL). */
export function generateHostToken() {
  return randomBytes(24).toString('base64url');
}

export function createSession({ sourceLanguage, targetLanguages, hostSocket = null } = {}) {
  const id = generateSessionId();
  const now = Date.now();
  const session = {
    id,
    hostToken: generateHostToken(),
    sourceLanguage: sourceLanguage || 'en',
    targetLanguages: (targetLanguages && targetLanguages.length ? targetLanguages : ['en']).slice(0, 8),
    createdAt: now,
    hostConnected: !!hostSocket,
    hostSocket,
    // monotonically increasing sequence number for recognized sentences
    sequence: 0,
    // viewer catch-up buffer: [{type:'source'|'translation', sequence, language?, text}]
    history: [],
    viewers: new Set(), // viewer sockets
    closed: false,
    lastActive: now,
    // translation bookkeeping: avoid duplicate translation requests
    // key: `${sequence}:${lang}` -> 'pending' | 'done'
    pendingTranslations: new Map(),
    // last time a recognized sentence arrived (for staleness detection)
    lastSpeechAt: now,
    // catch-up buffer size for late joiners (source + translation entries)
    historyLimit: config.sessions.historyLimit,
  };
  sessions.set(id, session);
  return session;
}

export function getSession(id) {
  return sessions.get(id) || null;
}

export function requireSession(id) {
  const s = sessions.get(id);
  if (!s || s.closed) throw new Error('session not found');
  return s;
}

export function closeSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  s.closed = true;
  if (s._idleTimer) { clearTimeout(s._idleTimer); s._idleTimer = null; }
  if (s.hostSocket) {
    s.hostSocket.close();
    s.hostSocket = null;
  }
  for (const v of s.viewers) {
    try { v.send(JSON.stringify({ type: 'session_stopped', sessionId: s.id })); } catch {}
    v.close();
  }
  s.viewers.clear();
  s.pendingTranslations.clear();
  // Keep entry out of the map so IDs cannot be reused.
  sessions.delete(id);
  return true;
}

export function addViewer(session, socket) {
  session.viewers.add(socket);
  session.lastActive = Date.now();
  socket._session = session;
}

export function removeViewer(session, socket) {
  session.viewers.delete(socket);
  if (socket._session === session) socket._session = null;
}

export function setHostSocket(session, socket) {
  session.hostSocket = socket;
  session.hostConnected = true;
  session.lastActive = Date.now();
  socket._session = session;
}

export function removeHost(session, socket) {
  if (session.hostSocket === socket) {
    session.hostSocket = null;
    session.hostConnected = false;
  }
  if (socket._session === session) socket._session = null;
  return session.viewers.size === 0;
}

/** Allocate the next sequence number and append source text to history. */
export function nextSequence(session, text) {
  session.sequence += 1;
  session.lastSpeechAt = Date.now();
  session.lastActive = Date.now();
  const entry = { type: 'source', sequence: session.sequence, text };
  pushHistory(session, entry);
  return entry;
}

/** Append a translation to history (order = append order; clients sort by sequence). */
export function recordTranslation(session, sequence, language, text) {
  const entry = { type: 'translation', sequence, language, text };
  pushHistory(session, entry);
  return entry;
}

export function pushHistory(session, entry) {
  session.history.push(entry);
  const limit = session.historyLimit ?? 200;
  while (session.history.length > limit) session.history.shift();
}

/** Mark a translation as started; returns false if it already exists. */
export function claimTranslation(session, sequence, language) {
  const key = `${sequence}:${language}`;
  if (session.pendingTranslations.has(key)) return false;
  session.pendingTranslations.set(key, 'pending');
  return true;
}

export function completeTranslation(session, sequence, language) {
  session.pendingTranslations.delete(`${sequence}:${language}`);
}

// ---------------------------------------------------------------
// Expiry / cleanup
// ---------------------------------------------------------------

export function isStale(session, timeoutSeconds, graceSeconds, now = Date.now()) {
  if (timeoutSeconds > 0 && now - session.lastActive > timeoutSeconds * 1000) return true;
  // Host gone and viewers have outstayed their grace period.
  if (!session.hostConnected && graceSeconds > 0) {
    const sinceHost = Math.max(session.lastActive, session.lastSpeechAt + graceSeconds * 1000);
    void sinceHost;
    if (now - session.lastActive > graceSeconds * 1000) return true;
  }
  return false;
}

export function cleanupExpired({ timeoutSeconds = 3600, graceSeconds = 60, onClose = () => {} } = {}) {
  const now = Date.now();
  const expired = [];
  for (const s of sessions.values()) {
    if (isStale(s, timeoutSeconds, graceSeconds, now)) expired.push(s.id);
  }
  for (const id of expired) {
    onClose(sessions.get(id));
    closeSession(id);
  }
  return expired;
}

/** Test helper: wipe everything. */
export function __resetAll() {
  for (const s of sessions.values()) closeSession(s.id);
  sessions.clear();
}

/** Test helper: number of live sessions. */
export function __sessionCount() {
  return sessions.size;
}

/** Iterate all live sessions (used by websocket cleanup). */
export function __allSessions() {
  return sessions.values();
}
