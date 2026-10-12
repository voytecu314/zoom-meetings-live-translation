// WebSocket layer.
// Routes:
//   /ws/host?session=<id>&token=<hostToken>   host connection (authorized)
//   /ws/live?session=<id>                     viewer connection
//
// Message protocol (JSON envelopes, one object per frame):
//   host → server:   { type: 'start_capture' }                       (ack: capture_status)
//                    { type: 'stop_capture' }
//                    { type: 'final_text', text }                     recognition results
//                    { type: 'interim_text', text }                   provisional captions only
//                    { type: 'stop_session' }                         ends session for everyone
//                    { type: 'set_languages', targets: [...], source? }
//   server → host:   { type: 'session_created', sessionId, hostToken?, viewerUrl }
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
// Security notes:
// - Session IDs are cryptographically random; the host token is separate and
//   NEVER embedded in the viewer URL.
// - Host messages are only accepted from authorized host sockets; all
//   messages are scoped to the session the socket belongs to.
// - Payload size limits + per-IP connection caps + heartbeats handled here.

import { WebSocketServer } from 'ws';
import {
  addViewer,
  __allSessions,
  removeHost,
  removeViewer,
  pushHistory,
  setHostSocket,
  getSession,
  closeSession,
} from './sessions.js';
import { disposeSessionResources, flushSession, ingestFinalText, configureSessionSegmentation } from './pipeline.js';
import { config } from './config.js';

const connectionsPerIp = new Map(); // ip -> count

function log(...args) {
  console.log('[ws]', ...args);
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

// Server-side quiesce promotion: when no interim change arrives for this
// long and the capture is live, the stable hypothesis is committed and
// translated. This guarantees LIVE subtitles server-side regardless of
// host-page JS freshness.
const SERVER_QUIESCE_MS = 1200;

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
      const ip = req.socket.remoteAddress || 'unknown';
      const count = connectionsPerIp.get(ip) || 0;
      if (count >= config.ws.maxConnectionsPerIp) return false;
      return true;
    },
  });

  wss.on('connection', (socket, req) => {
    const url = new URL(req.url, 'http://internal');
    const ip = req.socket.remoteAddress || 'unknown';
    connectionsPerIp.set(ip, (connectionsPerIp.get(ip) || 0) + 1);

    socket.isAlive = true;
    socket.on('pong', () => { socket.isAlive = true; });

    const path = url.pathname;
    const sessionId = url.searchParams.get('session');
    let session = sessionId ? getSession(sessionId) : null;

    if (path === '/ws/host') {
      const token = url.searchParams.get('token');
      if (!session || !token || token !== session.hostToken || session.hostSocket) {
        safeSend(socket, { type: 'error', recoverable: false, message: 'host authorization failed' });
        socket.close();
        return;
      }
      setHostSocket(session, socket);
      safeSend(socket, {
        type: 'session_joined',
        sessionId: session.id,
        sourceLanguage: session.sourceLanguage,
        targetLanguages: session.targetLanguages,
        history: session.history,
      });
      log(`host attached to session ${session.id}`);

      socket.on('message', (raw) => {
        session = getSession(session.id);
        if (!session || session.closed) return;
        session.lastActive = Date.now();
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          safeSend(socket, { type: 'error', recoverable: true, message: 'invalid JSON' });
          return;
        }
        handleHostMessage(session, socket, msg);
      });

      socket.on('close', () => {
        connectionsPerIp.set(ip, Math.max(0, (connectionsPerIp.get(ip) || 1) - 1));
        if (session) {
          removeHost(session, socket);
          log(`host disconnected from ${session.id}; viewers=${session.viewers.size}`);
          if (session.viewers.size === 0 && !session.closed) {
            // No one left listening and the host is gone → clean up.
            disposeSessionResources(session.id);
            // can't delete from map while iterating in sessions.js — schedule.
            setTimeout(() => {
              if (!session.hostSocket && session.viewers.size === 0) {
                closeSessionById(session.id);
              }
            }, config.sessions.viewerGraceSeconds * 1000);
          }
        }
      });
    } else if (path === '/ws/live') {
      if (!session || session.closed) {
        safeSend(socket, { type: 'error', recoverable: false, message: 'session not found' });
        socket.close();
        return;
      }
      addViewer(session, socket);
      safeSend(socket, {
        type: 'session_joined',
        sessionId: session.id,
        sourceLanguage: session.sourceLanguage,
        targetLanguages: session.targetLanguages,
        history: session.history,
      });
      log(`viewer attached to ${session.id}; viewers=${session.viewers.size}`);

      socket.on('message', (raw) => {
        // Viewers only send control messages: language pick, clear, speaking state.
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (msg.type === 'set_language' && typeof msg.language === 'string' &&
            session.targetLanguages.includes(msg.language)) {
          socket._preferredLanguage = msg.language.slice(0, 16);
        }
        // anything else from viewers is ignored — they cannot affect the session
      });

      socket.on('close', () => {
        connectionsPerIp.set(ip, Math.max(0, (connectionsPerIp.get(ip) || 1) - 1));
        if (session) removeViewer(session, socket);
        log(`viewer left ${session.id}; viewers=${session?.viewers?.size ?? 0}`);
      });
    } else {
      safeSend(socket, { type: 'error', recoverable: false, message: 'unknown endpoint' });
      socket.close();
    }
  });

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
  }, Math.max(30, Math.min(300, config.sessions.timeoutSeconds)));
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
        if (typeof msg.text === 'string' && msg.text.length <= 2000) {
          const hyp = msg.text.slice(0, 2000);
          safeBroadcast(session.id, {
            type: 'source',
            sessionId: session.id,
            interim: true,
            text: hyp,
          });
          // SERVER-SIDE LIVE COMMIT: browsers with stale host JS (or builds
          // where the page's own rolling commit doesn't run) rely on this.
          // If the interim hypothesis stops changing for QUIESCE_MS while the
          // capture is running, promote it to final text and translate. This
          // is what guarantees viewers get LIVE subtitles without host action.
          const now = Date.now();
          if (hyp !== session._srvInterim) {
            session._srvInterim = hyp;
            session._srvInterimAt = now;
            if (session._srvQuiesce) clearTimeout(session._srvQuiesce);
            session._srvQuiesce =            setTimeout(() => {
              const stable = session._srvInterim || '';
              const committed = session._srvCommitted || '';
              if (stable && stable.trim() && !session.closed) {
                // Promote only the NEW tail of a GROWING hypothesis (dedupe:
                // engines rewrite history; the segmenter receives deltas). If
                // the hypothesis shrank/rewrote, fall back to the full text —
                // the segmenter's overlap strip handles the seam.
                let delta = stable;
                if (committed && stable.startsWith(committed)) {
                  delta = stable.slice(committed.length);
                }
                delta = delta.trim();
                if (delta) {
                  log(`session ${session.id}: promoting interim tail (${delta.length} chars): "${delta.slice(0, 60)}"`);
                  ingestFinalText(session, delta, safeBroadcast, { isFragment: true });
                }
                session._srvCommitted = stable;
              }
            }, SERVER_QUIESCE_MS);
          }
        }
        break;
      }

      case 'final_text': {
        const text = typeof msg.text === 'string' ? msg.text : '';
        if (!text) return;
        if (text.length > 5000) {
          safeSend(socket, { type: 'error', recoverable: true, message: 'final_text too long' });
          return;
        }
        log(`session ${session.id}: host sent final_text (${text.length} chars): "${text.replace(/\s+/g, ' ').slice(0, 80)}"`);
        ingestFinalText(session, text, safeBroadcast);
        // A real engine final (or host rolling commit) covers the promoted
        // interim — remember it so quiesce doesn't re-promote the same tail.
        session._srvPromoted = text;
        if (session._srvQuiesce) { clearTimeout(session._srvQuiesce); session._srvQuiesce = null; }
        break;
      }

      case 'set_languages': {
        const source = typeof msg.source === 'string' ? msg.source.slice(0, 12) : null;
        const targets = Array.isArray(msg.targets)
          ? msg.targets.filter((t) => typeof t === 'string' && t.length <= 12).slice(0, 8)
          : null;
        if (source) configureSessionSegmentation(session, { sourceLanguage: source });
        if (targets && targets.length) session.targetLanguages = targets;
        pushHistory(session, {
          type: 'source',
          sequence: session.sequence,
          text: `__languages:${session.sourceLanguage}>${session.targetLanguages.join(',')}`,
        });
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


