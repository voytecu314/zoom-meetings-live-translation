// Pipeline: finalized recognition text → sentence segmentation → translation
// → broadcast. Owns: per-session segmenter instances, translation dispatch
// (one independent request per target language), ordering bookkeeping and
// WebSocket delivery to host + viewers. All translation work is async and
// never blocks subsequent source broadcasting.

import { createSegmenter, ABBREVIATION_PACKS } from './sentence-segmenter.js';
import { translateText } from './translation/index.js';
import {
  claimTranslation,
  completeTranslation,
  nextSequence,
  recordTranslation,
} from './sessions.js';

/** session -> { segmenter } */
const segmenters = new Map();

export function getSegmenterFor(session) {
  if (!segmentizersMap().has(session.id)) {
    segmentizersMap().set(session.id, createSegmenter({
      locale: baseLocale(session.sourceLanguage),
      maxBufferChars: session.maxBufferChars || 0,
    }));
  }
  return segmentizersMap().get(session.id);
}

function segmentizersMap() {
  return segmenters;
}

export function disposeSessionResources(sessionId) {
  segmenters.delete(sessionId);
}

/** Map a BCP-47 code like "en-US" to the language part for locale/abbrev packs. */
export function baseLocale(lang) {
  return (lang || 'en').split('-')[0];
}

/**
 * Ingest finalized recognition text for a session.
 * Returns emitted source messages [{sequence, text}] so the caller can
 * broadcast them; translation jobs are started in the background.
 *
 * @param {object} session      session object from sessions.js
 * @param {string} finalText    finalized recognition text (may repeat tail)
 * @param {object} broadcast    function(sessionId, payloadObject) to send JSON
 */
export function ingestFinalText(session, finalText, broadcast, { isFragment = null } = {}) {
  const segmenter = getSegmenterFor(session);
  // Host sends fast fragment commits (rolling interim tails) — fragment mode
  // streams clause boundaries live. Sessions can default to fragment mode
  // (s._fragmentMode) so mock-panel and standalone hosts share the live path.
  const fragment = isFragment !== null ? isFragment : (session._fragmentMode === true);
  const sentences = fragment
    ? segmenter.feed(finalText, { isFragment: true })
    : segmenter.feed(finalText);
  const messages = [];
  for (const sentence of sentences) {
    const entry = nextSequence(session, sentence);
    messages.push(entry);
  }
  // Broadcast source lines immediately (this is what viewers see first).
  for (const msg of messages) {
    broadcast(session.id, { type: 'source', sessionId: session.id, sequence: msg.sequence, text: msg.text });
    dispatchTranslations(session, msg.sequence, msg.text, broadcast);
  }
  return messages;
}

/** Flush leftover buffer when capture stops. */
export function flushSession(session, { translate = true } = {}, broadcast) {
  const segmenter = getSegmenterFor(session);
  const tail = segmenter.flush(translate);
  if (tail) {
    const entry = nextSequence(session, tail);
    broadcast(session.id, { type: 'source', sessionId: session.id, sequence: entry.sequence, text: tail });
    dispatchTranslations(session, entry.sequence, tail, broadcast);
    return entry;
  }
  return null;
}

/** Translate one source sentence into each configured target language. */
function dispatchTranslations(session, sequence, text, broadcast) {
  log(`session ${session.id} seq ${sequence}: translating "${truncate(text)}" -> ${session.targetLanguages.join(', ')}`);
  for (const lang of session.targetLanguages) {
    if (!claimTranslation(session, sequence, lang)) continue; // already requested
    void (async () => {
      try {
        const result = await translateText(text, session.sourceLanguage, lang);
        completeTranslation(session, sequence, lang);
        if (!result.ok) {
          log(`session ${session.id} seq ${sequence} FAILED (${lang}): ${result.error}`);
          broadcast(session.id, {
            type: 'error',
            sessionId: session.id,
            recoverable: true,
            message: `translation failed (seq ${sequence}, ${lang}): ${result.error}`,
          });
          return;
        }
        recordTranslation(session, sequence, lang, result.text);
        log(`session ${session.id} seq ${sequence} [${lang}]: "${truncate(result.text)}"`);
        broadcast(session.id, {
          type: 'translation',
          sessionId: session.id,
          sequence,
          language: lang,
          text: result.text,
        });
      } catch (err) {
        completeTranslation(session, sequence, lang);
        log(`session ${session.id} seq ${sequence} CRASHED (${lang}): ${err?.message ?? err}`);
        broadcast(session.id, {
          type: 'error',
          sessionId: session.id,
          recoverable: true,
          message: `translation crashed (seq ${sequence}, ${lang}): ${err?.message ?? err}`,
        });
      }
    })();
  }
}

// Per-connection transcript logging (kept short; no secrets, truncated text).
let logEnabled = true;
export function setPipelineLogging(on) {
  logEnabled = !!on;
}
function truncate(s, n = 60) {
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
function log(...args) {
  if (logEnabled) console.log('[pipeline]', ...args);
}

/** Update per-session segmentation settings (source language change etc.). */
export function configureSessionSegmentation(session, { sourceLanguage, maxBufferChars } = {}) {
  if (sourceLanguage && sourceLanguage !== session.sourceLanguage) {
    session.sourceLanguage = sourceLanguage;
    segmenters.delete(session.id);
    getSegmenterFor(session); // recreate with new locale
  }
  if (typeof maxBufferChars === 'number') {
    // stored per-session; applied on next segmenter creation
    session.maxBufferChars = maxBufferChars > 0 ? maxBufferChars : 0;
  }
}
