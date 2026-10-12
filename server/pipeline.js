// Pipeline: finalized recognition text → sentence segmentation → translation
// → broadcast. Owns: per-session segmenter instances, translation dispatch
// (one independent request per target language), ordering bookkeeping and
// WebSocket delivery to host + viewers. All translation work is async and
// never blocks subsequent source broadcasting.

import { createSegmenter, ABBREVIATION_PACKS } from './sentence-segmenter.js';
import { translateText } from './translation/index.js';
import { config } from './config.js';
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

// ------------------------------------------------------------------
// LIVE STREAMING INGESTION
// ------------------------------------------------------------------
// Browser speech recognition (Chrome) rarely emits punctuation, so waiting
// for a sentence terminator means nothing is translated until the host stops
// capturing. Instead the host streams small, NON-overlapping text deltas and
// the server decides when a chunk is worth translating:
//
//   1. complete sentences (terminal punctuation) are emitted immediately;
//   2. a buffered remainder is emitted as soon as it reaches
//      streamMinWords words (clause-sized chunk), or contains a clause
//      boundary and at least streamMinWords/2 words;
//   3. otherwise the remainder is emitted after pauseThresholdMs without new
//      text (speaker paused) — so latency is bounded even for short phrases.
//
// Trade-off (documented): chunks that end mid-sentence are translated without
// the rest of the sentence, which is slightly less accurate than full-sentence
// translation but is what makes the captions genuinely live.

function countUnits(text) {
  const t = text.trim();
  if (!t) return 0;
  const words = t.split(/\s+/).length;
  // Scripts without spaces (ja/zh/th): approximate a "word" as ~2 characters.
  return words > 1 ? words : Math.ceil(t.length / 2);
}

function emitSentence(session, text, broadcast) {
  const entry = nextSequence(session, text);
  broadcast(session.id, { type: 'source', sessionId: session.id, sequence: entry.sequence, text: entry.text });
  dispatchTranslations(session, entry.sequence, entry.text, broadcast);
  return entry;
}

function clearIdleTimer(session) {
  if (session._idleTimer) {
    clearTimeout(session._idleTimer);
    session._idleTimer = null;
  }
}

/**
 * Ingest committed recognition text for a session (a delta, not a rolling
 * hypothesis). Returns the source messages that were emitted right away.
 *
 * @param {object} session
 * @param {string} text         newly committed text
 * @param {function} broadcast  function(sessionId, payloadObject)
 */
export function ingestFinalText(session, text, broadcast) {
  const segmenter = getSegmenterFor(session);
  const { streamMinWords, pauseThresholdMs } = config.segmentation;
  const emitted = [];

  clearIdleTimer(session);

  for (const sentence of segmenter.feed(text, { dedupe: false })) {
    emitted.push(emitSentence(session, sentence, broadcast));
  }

  const rest = segmenter.bufferedText().trim();
  if (rest) {
    const units = countUnits(rest);
    const hasClause = /[,;:、،]/u.test(rest);
    if (units >= streamMinWords || (hasClause && units >= Math.ceil(streamMinWords / 2))) {
      const tail = segmenter.flush(true, { dedupe: false });
      if (tail) emitted.push(emitSentence(session, tail, broadcast));
    } else {
      // Speaker paused? Emit whatever is buffered after the idle threshold.
      session._idleTimer = setTimeout(() => {
        session._idleTimer = null;
        if (session.closed) return;
        const tail = segmenter.flush(true, { dedupe: false });
        if (tail) emitSentence(session, tail, broadcast);
      }, pauseThresholdMs);
      session._idleTimer.unref?.();
    }
  }
  return emitted;
}

/** Flush leftover buffer when capture stops. */
export function flushSession(session, { translate = true } = {}, broadcast) {
  clearIdleTimer(session);
  const segmenter = getSegmenterFor(session);
  const tail = segmenter.flush(translate, { dedupe: false });
  if (tail) return emitSentence(session, tail, broadcast);
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
          notifyHost(session, `translation failed (seq ${sequence}, ${lang}): ${result.error}`);
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
        notifyHost(session, `translation crashed (seq ${sequence}, ${lang}): ${err?.message ?? err}`);
      }
    })();
  }
}

/** Translation problems are an operator concern: tell the host, not viewers. */
function notifyHost(session, message) {
  const sock = session.hostSocket;
  if (sock && sock.readyState === sock.OPEN) {
    try { sock.send(JSON.stringify({ type: 'error', sessionId: session.id, recoverable: true, message })); } catch {}
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
