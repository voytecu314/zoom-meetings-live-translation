// WebSocket layer.
// Routes:
//   /ws/host?session=<id>&token=<hostToken>   host connection (authorized)
//   /ws/live?session=<id>                     viewer connection
//
// Message protocol (JSON envelopes, one object per frame):
//   host → server:   { type: 'start_capture' }                       (ack: capture_status)
//                    { type: 'stop_capture' }
//                    { type: 'final_text', text }                     NEW committed text (a delta, never
//                                                                     the whole rolling hypothesis)
//                    { type: 'interim_text', text }                   provisional captions only
//                    { type: 'stop_session' }                         ends session for everyone
//                    { type: 'set_languages', targets: [...], source? }
//   server → host:   { type: 'viewers', count }                      viewer join/leave
//                    { type: 'session_created', sessionId, hostToken?, viewerUrl }
//                    { type: 'session_joined', sessionId, sourceLanguage, targetLanguages, history }
//                    { type: 'capture_status', status: 'running'|'stopped', detail? }
//                    { type: 'source' | 'translation' }               echoes what viewers get
//                    { type: 'error', recoverable, message }
//                    { type: 'session_stopped' }
//   server → viewer: { type: 'session_joined', sessionId, sourceLanguage, targetLanguages, history }
//                    { type: 'source' | 'translation' }
//                    { type: 'error', recoverable, message }
//                    { type: 'session_stopped' }
//
// WebSocket close codes used (clients must NOT auto-reconnect on these):
//   4401 host authorization failed   4404 session not found/ended
//   4000 host connection replaced by a newer host connection
//
// Security notes:
// - Session IDs are cryptographically random; the host token is separate and
//   NEVER embedded in the viewer URL.
// - Host messages are only accepted from authorized host sockets; all
//   messages are scoped to the session the socket belongs to.
// - Payload size limits + per-IP connection caps + heartbeats handled here.

import { createLogger } from './log.js';
import { WebSocketServer } from 'ws';
import {
  addViewer,
  __allSessions,
  removeHost,
  removeViewer,
  setHostSocket,
  getSession,
  closeSession,
} from './sessions.js';
import { disposeSessionResources, flushSession, pauseSession, ingestFinalText, configureSessionSegmentation } from './pipeline.js';
import { config } from './config.js';

const connectionsPerIp = new Map(); // ip -> count

const logger = createLogger('ws');
function log(...args) {
  logger.info(...args);
}

function safeSend(socket, obj) {
  if (socket.readyState === socket.OPEN) {
    try {
      socket.send(JSON.stringify(obj));
    } catch {
      /* connection dying mid-send is expected during cleanup */
    }
  }
}

const CLOSE_UNAUTHORIZED = 4401;
const CLOSE_NOT_FOUND = 4404;
const CLOSE_REPLACED = 4000;

/** Real client address: behind a proxy/tunnel the socket address is the proxy's. */
function clientIp(req) {
  if (config.env.trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim() || 'unknown';
  }
  return req.socket.remoteAddress || 'unknown';
}

function closeWith(socket, code, reason) {
  try { socket.close(code, reason); } catch { /* already closing */ }
}

function originOk(origin) {
  if (!origin) return true; // non-browser clients (tests) — fine behind same reverse proxy
  if (config.ws.allowedOrigins.length === 0) return true; // dev: allow all, prod sets list
  return config.ws.allowedOrigins.includes(origin);
}

export function setupWebSocket(server, httpServer) {
  const wss = new WebSocketServer({
    server: httpServer,
    maxPayload: config.ws.maxPayloadBytes,
    // origin validation happens in verifyClient to reject before upgrade
    verifyClient: ({ req }) => {
      if (!originOk(req.headers.origin)) {
        log('rejected origin', req.headers.origin);
        return false;
      }
      const count = connectionsPerIp.get(clientIp(req)) || 0;
      if (count >= config.ws.maxConnectionsPerIp) {
        log('rejected: too many connections from', clientIp(req));
        return false;
      }
      return true;
    },
  });

  wss.on('connection', (socket, req) => {
    const url = new URL(req.url, 'http://internal');
    const ip = clientIp(req);

    // Count this socket and ALWAYS release it on close. (Previously the
    // counter was only released by the host/viewer branches, so every
    // rejected connection leaked a slot; reconnecting viewers then exhausted
    // the per-IP limit — for everyone behind the same proxy/NAT.)
    connectionsPerIp.set(ip, (connectionsPerIp.get(ip) || 0) + 1);
    socket.once('close', () => {
      const n = (connectionsPerIp.get(ip) || 1) - 1;
      if (n <= 0) connectionsPerIp.delete(ip);
      else connectionsPerIp.set(ip, n);
    });
    socket.on('error', () => { /* 'close' follows; avoid unhandled 'error' crashes */ });

    socket.isAlive = true;
    socket.on('pong', () => { socket.isAlive = true; });

    const path = url.pathname;
    const sessionId = url.searchParams.get('session');
    const initial = sessionId ? getSession(sessionId) : null;

    if (path === '/ws/host') {
      const token = url.searchParams.get('token');
      if (!initial || initial.closed) {
        safeSend(socket, { type: 'error', recoverable: false, message: 'session not found' });
        closeWith(socket, CLOSE_NOT_FOUND, 'session not found');
        return;
      }
      if (!token || token !== initial.hostToken) {
        safeSend(socket, { type: 'error', recoverable: false, message: 'host authorization failed' });
        closeWith(socket, CLOSE_UNAUTHORIZED, 'unauthorized');
        return;
      }
      const sid = initial.id;
      // A valid host token always wins: after a network drop the old socket
      // can linger as half-open for up to a heartbeat interval, and refusing
      // the reconnect would lock the host out of its own session.
      const previous = initial.hostSocket;
      setHostSocket(initial, socket);
      if (previous && previous !== socket) {
        safeSend(previous, { type: 'error', recoverable: false, message: 'host connection replaced' });
        closeWith(previous, CLOSE_REPLACED, 'replaced');
      }
      safeSend(socket, {
        type: 'session_joined',
        sessionId: initial.id,
        sourceLanguage: initial.sourceLanguage,
        targetLanguages: initial.targetLanguages,
        history: initial.history,
      });
      safeSend(socket, { type: 'viewers', count: initial.viewers.size });
      log(`host attached to session ${sid}`);

      socket.on('message', (raw) => {
        const current = getSession(sid);
        if (!current || current.closed) return;
        current.lastActive = Date.now();
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          safeSend(socket, { type: 'error', recoverable: true, message: 'invalid JSON' });
          return;
        }
        handleHostMessage(current, socket, msg);
      });

      socket.on('close', () => {
        const current = getSession(sid);
        if (!current) return;
        removeHost(current, socket);
        log(`host disconnected from ${sid}; viewers=${current.viewers.size}`);
        if (current.hostSocket || current.closed) return; // host already reconnected
        if (current.viewers.size === 0) {
          disposeSessionResources(sid);
          setTimeout(() => {
            const s2 = getSession(sid);
            if (s2 && !s2.hostSocket && s2.viewers.size === 0) closeSessionById(sid);
          }, config.sessions.viewerGraceSeconds * 1000).unref?.();
        }
      });
    } else if (path === '/ws/live') {
      if (!initial || initial.closed) {
        safeSend(socket, { type: 'error', recoverable: false, message: 'session not found' });
        closeWith(socket, CLOSE_NOT_FOUND, 'session not found');
        return;
      }
      const sid = initial.id;
      addViewer(initial, socket);
      safeSend(socket, {
        type: 'session_joined',
        sessionId: initial.id,
        sourceLanguage: initial.sourceLanguage,
        targetLanguages: initial.targetLanguages,
        history: initial.history,
      });
      notifyViewerCount(initial);
      log(`viewer attached to ${sid}; viewers=${initial.viewers.size}`);

      socket.on('message', (raw) => {
        // Viewers only send control messages; they cannot affect the session.
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        const current = getSession(sid);
        if (current && msg.type === 'set_language' && typeof msg.language === 'string' &&
            current.targetLanguages.includes(msg.language)) {
          socket._preferredLanguage = msg.language.slice(0, 16);
        }
      });

      socket.on('close', () => {
        const current = getSession(sid);
        if (!current) return;
        removeViewer(current, socket);
        notifyViewerCount(current);
        log(`viewer left ${sid}; viewers=${current.viewers.size}`);
      });
    } else {
      safeSend(socket, { type: 'error', recoverable: false, message: 'unknown endpoint' });
      closeWith(socket, CLOSE_NOT_FOUND, 'unknown endpoint');
    }
  });

  function notifyViewerCount(session) {
    if (session.hostSocket) safeSend(session.hostSocket, { type: 'viewers', count: session.viewers.size });
  }

  // Heartbeats: drop dead connections.
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (!socket.isAlive) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      try { socket.ping(); } catch {}
    }
  }, config.ws.heartbeatMs);
  wss.on('close', () => clearInterval(heartbeat));

  // Periodic session expiry cleanup.
  const cleanup = setInterval(() => {
    const expired = requireCleanup();
    for (const id of expired) closeSessionById(id);
  }, Math.max(30, Math.min(300, config.sessions.timeoutSeconds)) * 1000);
  wss.on('close', () => clearInterval(cleanup));

  function requireCleanup() {
    const expired = [];
    for (const s of __allSessions()) {
      const idleMs = Date.now() - s.lastActive;
      if (config.sessions.timeoutSeconds > 0 && idleMs > config.sessions.timeoutSeconds * 1000) {
        expired.push(s.id);
      } else if (!s.hostConnected && s.viewers.size === 0 &&
                 idleMs > Math.max(10, config.sessions.viewerGraceSeconds) * 1000) {
        expired.push(s.id);
      }
    }
    return expired;
  }

  function closeSessionById(id) {
    const s = getSession(id);
    if (!s) return;
    safeBroadcast(id, { type: 'session_stopped', sessionId: id });
    disposeSessionResources(id);
    closeSession(id);
    log(`session ${id} closed`);
  }

  // Broadcast helper shared with host message handlers.
  function safeBroadcast(sessionId, obj) {
    const s = getSession(sessionId);
    if (!s) return;
    for (const v of s.viewers) safeSend(v, obj);
    if (s.hostSocket) safeSend(s.hostSocket, obj);
  }

  // ------------------------------------------------------------------
  // Host message handling
  // ------------------------------------------------------------------

  function handleHostMessage(session, socket, msg) {
    switch (msg.type) {
      case 'session_create': {
        // Hosts create via REST endpoint; kept here for API symmetry.
        log('host sent session_create over ws (ignored, use POST /api/sessions)');
        break;
      }

      case 'start_capture': {
        safeSend(socket, { type: 'capture_status', status: 'running' });
        break;
      }

      case 'stop_capture': {
        // Flush or discard trailing buffer.
        flushSession(session, { translate: msg.translate !== false }, (id, obj) => safeBroadcast(id, obj));
        safeBroadcast(session.id, { type: 'capture_status', status: 'stopped' });
        break;
      }

      case 'flush_tail': {
        // Host explicitly asks to translate (or discard) the trailing fragment.
        flushSession(session, { translate: msg.translate !== false }, (id, obj) => safeBroadcast(id, obj));
        break;
      }

      case 'interim_text': {
        // Display-only provisional caption (never translated).
        if (typeof msg.text === 'string' && msg.text.length <= 2000) {
          safeBroadcast(session.id, {
            type: 'source',
            sessionId: session.id,
            interim: true,
            text: msg.text,
          });
        }
        break;
      }

      case 'final_text': {
        // Committed text. The host sends DELTAS (new words only); the
        // pipeline streams them out as soon as a sentence/clause is ready.
        const text = typeof msg.text === 'string' ? msg.text : '';
        if (!text.trim()) return;
        if (text.length > 5000) {
          safeSend(socket, { type: 'error', recoverable: true, message: 'final_text too long' });
          return;
        }
        logger.debug(`session ${session.id}: final_text (${text.length} chars): "${text.replace(/\s+/g, ' ').slice(0, 80)}"`);
        ingestFinalText(session, text, safeBroadcast);
        break;
      }

      case 'utterance_end': {
        // Host detected a pause in speech: close the open utterance now so its
        // final, full-context translation is produced without waiting.
        pauseSession(session, (id, obj) => safeBroadcast(id, obj));
        break;
      }

      case 'set_languages': {
        const source = typeof msg.source === 'string' ? msg.source.slice(0, 12) : null;
        const targets = Array.isArray(msg.targets)
          ? msg.targets.filter((t) => typeof t === 'string' && t.length <= 12).slice(0, 8)
          : null;
        if (source) configureSessionSegmentation(session, { sourceLanguage: source });
        if (targets && targets.length) session.targetLanguages = targets;
        safeBroadcast(session.id, {
          type: 'session_updated',
          sessionId: session.id,
          sourceLanguage: session.sourceLanguage,
          targetLanguages: session.targetLanguages,
        });
        break;
      }

      case 'stop_session': {
        closeSessionById(session.id);
        break;
      }

      default:
        safeSend(socket, { type: 'error', recoverable: true, message: `unknown message type "${msg.type}"` });
    }
  }

  return { wss, safeBroadcast };
}


