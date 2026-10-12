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
  updateSource,
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
// LIVE INGESTION: utterances, drafts and final translations
// ------------------------------------------------------------------
// Browser speech recognition (Chrome) emits no punctuation, so there is no
// reliable sentence boundary in the text. Cutting by word count (the old
// behaviour) splits sentences in arbitrary places and ruins translation
// quality. Instead:
//
//   * The unit of translation is an UTTERANCE: speech up to a pause (or up to
//     real terminal punctuation when the engine does provide it).
//   * While an utterance is still open, its WHOLE text so far is re-translated
//     (throttled) as a DRAFT: { final: false }. Viewers replace the same
//     caption line in place, so captions stay live and every draft is a
//     translation of a complete prefix, never of a detached fragment.
//   * When the utterance ends (host pause signal "utterance_end", fallback
//     timer, punctuation, or the max-length valve) ONE final, full-context
//     translation is sent: { final: true }. Only finals are read aloud and
//     stored in catch-up history.
//
// Trade-off: extra translation requests for drafts (DRAFT_TRANSLATIONS=false
// disables them; captions then appear once per utterance).

function countUnits(text) {
  const t = text.trim();
  if (!t) return 0;
  const words = t.split(/\s+/).length;
  // Scripts without spaces (ja/zh/th): approximate a "word" as ~2 characters.
  return words > 1 ? words : Math.ceil(t.length / 2);
}

/** Per-session state of the utterance that is currently open. */
function utt(session) {
  if (!session._utt) session._utt = { seq: null, text: '', langs: new Map() };
  return session._utt;
}

function resetUtterance(session) {
  const u = utt(session);
  for (const d of u.langs.values()) if (d.timer) clearTimeout(d.timer);
  u.seq = null;
  u.text = '';
  u.langs = new Map(); // also invalidates in-flight draft results
}

function clearIdleTimer(session) {
  if (session._idleTimer) {
    clearTimeout(session._idleTimer);
    session._idleTimer = null;
  }
}

/** Announce / update the still-open utterance and schedule draft translations. */
function openOrUpdateDraft(session, text, broadcast) {
  const u = utt(session);
  if (u.seq == null) {
    u.seq = nextSequence(session, text).sequence;
  } else {
    updateSource(session, u.seq, text);
  }
  u.text = text;
  broadcast(session.id, { type: 'source', sessionId: session.id, sequence: u.seq, text, final: false });
  scheduleDrafts(session, broadcast);
}

/** Close the open utterance (or start+close a new one) with its final text. */
function finalizeUtterance(session, text, broadcast) {
  const u = utt(session);
  let sequence;
  if (u.seq != null) {
    sequence = u.seq;
    updateSource(session, sequence, text);
  } else {
    sequence = nextSequence(session, text).sequence;
  }
  resetUtterance(session);
  broadcast(session.id, { type: 'source', sessionId: session.id, sequence, text, final: true });
  dispatchTranslations(session, sequence, text, broadcast);
  return { sequence, text };
}

function scheduleDrafts(session, broadcast) {
  const { draftTranslations, draftIntervalMs, draftMinWords, draftMinNewWords } = config.segmentation;
  if (!draftTranslations) return;
  const u = utt(session);
  const units = countUnits(u.text);
  if (u.seq == null || units < draftMinWords) return;
  for (const lang of session.targetLanguages) {
    let d = u.langs.get(lang);
    if (!d) {
      d = { inflight: false, timer: null, lastAt: 0, lastUnits: 0 };
      u.langs.set(lang, d);
    }
    if (d.inflight || d.timer) continue; // it will pick up the latest text
    if (d.lastUnits && units - d.lastUnits < draftMinNewWords) continue;
    const wait = Math.max(0, d.lastAt + draftIntervalMs - Date.now());
    d.timer = setTimeout(() => {
      d.timer = null;
      void runDraft(session, lang, d, broadcast);
    }, wait);
    d.timer.unref?.();
  }
}

async function runDraft(session, lang, d, broadcast) {
  const u = utt(session);
  if (session.closed || u.seq == null || u.langs.get(lang) !== d) return;
  const sequence = u.seq;
  const text = u.text;
  d.inflight = true;
  d.lastAt = Date.now();
  d.lastUnits = countUnits(text);
  let result = null;
  try {
    result = await translateText(text, session.sourceLanguage, lang);
  } catch (err) {
    log(`session ${session.id} seq ${sequence} draft CRASHED (${lang}): ${err?.message ?? err}`);
  }
  d.inflight = false;
  // Utterance finalized (or session closed) while we were waiting: drop it.
  if (session.closed || u.seq !== sequence || u.langs.get(lang) !== d) return;
  if (result?.ok) {
    broadcast(session.id, {
      type: 'translation', sessionId: session.id, sequence, language: lang, text: result.text, final: false,
    });
  }
  scheduleDrafts(session, broadcast); // text may have grown meanwhile
}

/**
 * Ingest committed recognition text (a delta, not a rolling hypothesis).
 * Returns the utterances that were finalized by this call.
 *
 * @param {object} session
 * @param {string} text         newly committed text
 * @param {function} broadcast  function(sessionId, payloadObject)
 */
export function ingestFinalText(session, text, broadcast) {
  const segmenter = getSegmenterFor(session);
  const { maxUtteranceWords, pauseThresholdMs } = config.segmentation;
  const finalized = [];

  clearIdleTimer(session);

  // Real sentence punctuation (when the engine provides any) closes sentences.
  // The first one also closes the open utterance: it contains the buffered text.
  // Host deltas carry no leading space; keep words apart (not for ja/zh/th).
  const needsSpace = segmenter.bufferedText() && !/^\s/.test(text) && !/^(ja|zh|th)/i.test(session.sourceLanguage || '');
  for (const sentence of segmenter.feed((needsSpace ? ' ' : '') + text, { dedupe: false })) {
    finalized.push(finalizeUtterance(session, sentence, broadcast));
  }

  const rest = segmenter.bufferedText().trim();
  if (!rest) return finalized;

  if (countUnits(rest) >= maxUtteranceWords) {
    const tail = segmenter.flush(true, { dedupe: false });
    if (tail) finalized.push(finalizeUtterance(session, tail, broadcast));
    return finalized;
  }

  openOrUpdateDraft(session, rest, broadcast);

  // Fallback end-of-utterance in case the host's pause signal never arrives.
  session._idleTimer = setTimeout(() => {
    session._idleTimer = null;
    if (!session.closed) flushSession(session, { translate: true }, broadcast);
  }, pauseThresholdMs);
  session._idleTimer.unref?.();
  return finalized;
}

/**
 * End the open utterance now (speaker paused / capture stopped) and send its
 * final translation. With translate:false the leftover is discarded.
 */
export function flushSession(session, { translate = true } = {}, broadcast) {
  clearIdleTimer(session);
  const segmenter = getSegmenterFor(session);
  const tail = segmenter.flush(translate, { dedupe: false });
  if (tail) return finalizeUtterance(session, tail, broadcast);
  resetUtterance(session);
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
          final: true,
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
    clearIdleTimer(session);
    resetUtterance(session);
    getSegmenterFor(session); // recreate with new locale
  }
  if (typeof maxBufferChars === 'number') {
    // stored per-session; applied on next segmenter creation
    session.maxBufferChars = maxBufferChars > 0 ? maxBufferChars : 0;
  }
}
