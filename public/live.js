// Viewer page logic: subtitle display, language pick, reconnection, optional
// speech synthesis. Subtitles render immediately; speech is optional and
// never blocks text display.

const el = (id) => document.getElementById(id);

import { createSpeechQueue } from '/speech-queue.js';

const state = {
  sessionId: location.pathname.split('/').pop(),
  ws: null,
  preferredLanguage: null, // picked / stored language
  targetLanguages: [],
  sourceLanguage: 'en',
  // sequence -> { text: '' , translations: Map(lang->text)} for ordering
  sourceLines: new Map(),
  historyLoaded: false,
  speechEnabled: false,
  speechRate: 1,        // user's reading speed (slider)
  autoCatchUp: true,    // read faster while behind instead of skipping lines
  speakingSeq: null,    // line being read right now
  reconnectDelay: 1000,
  reconnectTimer: null,
  closedByServer: false,
};

const SUBTITLE_LIMIT = 60; // bounded history kept in DOM

// ------------------------------------------------------------------
// WebSocket connection + reconnection
// ------------------------------------------------------------------

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws/live?session=${encodeURIComponent(state.sessionId)}`;
}

// Close codes sent by the server that mean "do not retry".
const FATAL_CLOSE_CODES = [4401, 4404];

function connect() {
  if (stopped || state.closedByServer) return;
  if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) return;
  clearTimeout(state.reconnectTimer);
  setStatus('CONNECTING', 'connecting');
  const ws = new WebSocket(wsUrl());
  state.ws = ws;

  ws.onopen = () => {
    state.reconnectDelay = 1000;
    setStatus('LIVE', 'live');
  };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handle(msg);
  };
  ws.onclose = (ev) => {
    if (state.ws !== ws) return; // an older socket, already replaced
    if (stopped || state.closedByServer) return;
    if (FATAL_CLOSE_CODES.includes(ev.code)) {
      // Session does not exist (ended / server restarted): retrying is pointless.
      stopped = true;
      setStatus('SESSION ENDED', 'disconnected');
      hideControls();
      return;
    }
    setStatus('RECONNECTING…', 'connecting');
    // Exponential backoff (1s → 10s) so a flaky network or restarting server
    // is not hammered, while a quick blip still recovers fast.
    state.reconnectTimer = setTimeout(connect, state.reconnectDelay);
    state.reconnectDelay = Math.min(state.reconnectDelay * 1.6, 10000);
  };
  ws.onerror = () => { /* onclose always follows and handles retry */ };
}

let stopped = false;

// Phones suspend background tabs and drop their sockets silently. Reconnect
// right away when the tab is visible again or the network comes back.
function reconnectNow() {
  if (stopped || state.closedByServer) return;
  if (!state.ws || state.ws.readyState === WebSocket.CLOSED || state.ws.readyState === WebSocket.CLOSING) {
    state.reconnectDelay = 1000;
    connect();
  }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) reconnectNow(); });
window.addEventListener('online', reconnectNow);

function applyMessage(h) {
  handle(h);
}

function handle(msg) {
  switch (msg.type) {
    case 'session_joined':
      state.targetLanguages = msg.targetLanguages || [];
      state.sourceLanguage = msg.sourceLanguage || 'en';
      populateLanguageSelect();
      if (Array.isArray(msg.history)) {
        // Replay catch-up history WITHOUT reading it aloud.
        const wasSpeaking = state.speechEnabled;
        state.speechEnabled = false;
        for (const h of msg.history) applyMessage(h);
        state.speechEnabled = wasSpeaking;
        state.historyLoaded = true;
        markAllAsSpoken();
      }
      break;

    case 'session_updated':
      state.targetLanguages = msg.targetLanguages || state.targetLanguages;
      state.sourceLanguage = msg.sourceLanguage || state.sourceLanguage;
      populateLanguageSelect();
      break;

    case 'source':
      if (msg.interim) {
        renderInterimSource(msg.text);
        break;
      }
      clearInterimSource();
      rememberSource(msg.sequence, msg.text, msg.final !== false);
      // Translations lag recognition by a second or three on real providers;
      // show the SOURCE line dimmed immediately, replaced by its translation
      // when it arrives (swap happens automatically on the next render()).
      render();
      break;

    case 'translation': {
      // final === false: live DRAFT of a still-growing utterance. It replaces
      // the same caption line in place and is never read aloud.
      const isFinal = msg.final !== false;
      if (!isFinal && state.sourceLines.get(msg.sequence)?.done) break; // stale draft
      rememberTranslation(msg.sequence, msg.language, msg.text);
      const line = state.sourceLines.get(msg.sequence);
      line.draft = !isFinal;
      if (isFinal) line.done = true;
      render();
      // Only speak finals, and only the language the viewer is actually reading.
      if (isFinal && msg.language === languageInUse()) enqueueSpeech(msg.sequence);
      break;
    }

    case 'session_stopped':
      stopped = true;
      state.closedByServer = true;
      state.speechEnabled = false;
      setStatus('SESSION ENDED', 'disconnected');
      hideControls();
      break;

    case 'error':
      if (msg.recoverable === false) {
        stopped = true; // server will also close with a fatal code
        setStatus('SESSION UNAVAILABLE', 'disconnected');
      }
      console.warn('server error:', msg.message);
      break;
  }
}

// ------------------------------------------------------------------
// Data model: keep source text + per-language translations keyed by sequence
// ------------------------------------------------------------------

function rememberSource(sequence, text, sourceFinal = true) {
  if (!state.sourceLines.has(sequence)) {
    state.sourceLines.set(sequence, { text, translations: new Map(), sourceFinal });
    // keep memory bounded
    if (state.sourceLines.size > 200) {
      const oldest = Math.min(...state.sourceLines.keys());
      state.sourceLines.delete(oldest);
    }
  } else {
    const e = state.sourceLines.get(sequence);
    e.text = text;
    e.sourceFinal = e.sourceFinal || sourceFinal;
  }
}

function rememberTranslation(sequence, language, text) {
  if (!state.sourceLines.has(sequence)) {
    // translation may arrive before we saw the source line (shouldn't happen;
    // source is always broadcast first). Create a placeholder.
    rememberSource(sequence, '…');
  }
  state.sourceLines.get(sequence).translations.set(language, text);
}

function languageInUse() {
  return state.preferredLanguage || null; // null = show all target languages enabled
}

// ------------------------------------------------------------------
// Rendering (safe: textContent only, no HTML injection)
// ------------------------------------------------------------------

function render() {
  const list = el('subtitles');
  clearInterimSource();
  const seqs = [...state.sourceLines.keys()].sort((a, b) => a - b);
  const lang = languageInUse();
  let anyShown = false;
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
  list.textContent = '';
  for (const seq of seqs) {
    const entry = state.sourceLines.get(seq);
    let text = null;
    let pending = false;
    if (lang) {
      text = entry.translations.get(lang) ?? null;
    } else {
      // No pick yet: show the first enabled target language that has text.
      for (const t of state.targetLanguages) {
        if (entry.translations.has(t)) { text = entry.translations.get(t); break; }
      }
    }
    if (text == null) {
      if (!state.sourceLines.has(seq)) continue;
      // Pending translation: show the dimmed SOURCE text so the viewer sees
      // speech immediately, upgraded to the translation when it arrives.
      text = entry.text;
      pending = true;
    }
    anyShown = true;
    const div = document.createElement('div');
    const isDraft = !pending && entry.draft === true;
    div.className = 'subtitle' + (pending ? ' pending' : '') + (isDraft ? ' draft' : '') +
      (entry.skipped ? ' skipped' : '') + (state.speakingSeq === seq ? ' speaking' : '');
    div.dataset.sequence = String(seq);
    div.textContent = text; // XSS-safe
    if (!pending && !isDraft) {
      div.title = 'Click to hear this line';
      div.classList.add('speakable');
    }
    list.appendChild(div);
  }

  // trim DOM history
  while (list.children.length > SUBTITLE_LIMIT) list.removeChild(list.firstChild);

  el('waiting').hidden = anyShown;
  if (anyShown && nearBottom) list.scrollTop = list.scrollHeight;
}

function renderInterimSource(text) {
  el('waiting').hidden = true;
  if (!el('show-source').checked) return;
  const log = el('source-captions-log');
  log.hidden = false;
  log.textContent = text; // safe
}

function clearInterimSource() {
  const log = el('source-captions-log');
  if (!el('show-source').checked) { log.hidden = true; log.textContent = ''; }
}

// ------------------------------------------------------------------
// Language selector + controls
// ------------------------------------------------------------------

function populateLanguageSelect() {
  const sel = el('language-select');
  const stored = localStorage.getItem('preferredLanguage');
  sel.textContent = '';
  for (const code of state.targetLanguages) {
    const opt = document.createElement('option');
    opt.value = code;
    opt.textContent = LANGUAGE_LABELS[code] || code;
    if (code === stored) opt.selected = true;
    sel.appendChild(opt);
  }
  if (sel.options.length > 0 && !sel.value) sel.selectedIndex = 0;
  state.preferredLanguage = sel.value || state.targetLanguages[0] || null;
  render();
}

const LANGUAGE_LABELS = {
  en: 'English', de: 'German', fr: 'French', es: 'Spanish', it: 'Italian',
  pt: 'Portuguese', nl: 'Dutch', ru: 'Russian', zh: 'Chinese', ja: 'Japanese',
  ko: 'Korean', ar: 'Arabic', hi: 'Hindi', tr: 'Turkish', pl: 'Polish',
};

// ------------------------------------------------------------------
// Optional speech synthesis (browser speechSynthesis)
// ------------------------------------------------------------------

function markSpeakingLine(seq) {
  state.speakingSeq = seq;
  for (const n of el('subtitles').querySelectorAll('.subtitle.speaking')) n.classList.remove('speaking');
  if (seq != null) el('subtitles').querySelector(`.subtitle[data-sequence="${seq}"]`)?.classList.add('speaking');
}

let speechQueue = null;
function speech() {
  if (speechQueue) return speechQueue;
  speechQueue = createSpeechQueue({
    synth: speechSynthesis,
    makeUtterance: (text, lang) => {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = mapToVoiceLocale(lang);
      const voice = pickVoice(u.lang);
      if (voice) u.voice = voice;
      return u;
    },
    getRate: () => state.speechRate,
    autoCatchUp: () => state.autoCatchUp,
    isPaused: () => speechSynthesis.paused,
    // A lower line is final but its translation has not arrived yet: read it first.
    hasPendingBefore: (seq, spokenUpTo) => {
      const lang = languageInUse() || state.targetLanguages[0];
      for (const [s, e] of state.sourceLines) {
        if (s < seq && s > spokenUpTo && e.sourceFinal && !e.translations.get(lang)) return true;
      }
      return false;
    },
    onSkip: (seqs) => {
      for (const q of seqs) {
        const e = state.sourceLines.get(q);
        if (e) e.skipped = true;
      }
      render(); // skipped lines are marked; click one to hear it
    },
    onState: markSpeakingLine,
  });
  return speechQueue;
}

function markAllAsSpoken() {
  // Treat everything we currently have as "already seen": turning speech on
  // starts from NOW instead of reading the whole backlog.
  if (!('speechSynthesis' in window)) return;
  for (const seq of state.sourceLines.keys()) speech().markSpoken(seq);
}

function enqueueSpeech(sequence) {
  if (!state.speechEnabled || !('speechSynthesis' in window)) return;
  const lang = languageInUse() || state.targetLanguages[0];
  if (!lang) return;
  const text = state.sourceLines.get(sequence)?.translations.get(lang);
  if (!text) return;
  speech().enqueue({ sequence, text, lang });
}

/** On-demand: read one specific line (click on a caption), regardless of the toggle. */
function speakLineNow(sequence) {
  if (!('speechSynthesis' in window)) return;
  const lang = languageInUse() || state.targetLanguages[0];
  const text = state.sourceLines.get(sequence)?.translations.get(lang);
  if (!text) return;
  speech().speakNow({ sequence, text, lang });
}

function mapToVoiceLocale(base) {
  const full = { en: 'en-US', de: 'de-DE', fr: 'fr-FR', es: 'es-ES', it: 'it-IT',
    pt: 'pt-BR', nl: 'nl-NL', ru: 'ru-RU', zh: 'zh-CN', ja: 'ja-JP',
    ko: 'ko-KR', ar: 'ar-SA', hi: 'hi-IN', tr: 'tr-TR', pl: 'pl-PL' };
  return full[base] || base;
}

function pickVoice(lang) {
  if (!('speechSynthesis' in window)) return null;
  const voices = speechSynthesis.getVoices();
  if (!voices.length) return null;
  const exact = voices.find((v) => v.lang === lang);
  if (exact) return exact;
  const sameBase = voices.find((v) => v.lang.split('-')[0] === lang.split('-')[0]);
  return sameBase || null; // graceful: browser picks a fallback voice
}

function stopSpeech() {
  if (!('speechSynthesis' in window)) return;
  speech().stop();
}

// ------------------------------------------------------------------
// Status + UI wiring
// ------------------------------------------------------------------

function setStatus(text, cls) {
  const b = el('live-status');
  b.textContent = text;
  b.className = `badge ${cls}`;
}

function hideControls() {
  for (const id of ['language-select', 'speak-toggle', 'speech-rate', 'auto-catchup', 'pause-speech', 'clear']) {
    const n = el(id);
    if (n) n.disabled = true;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  el('language-select').addEventListener('change', (e) => {
    state.preferredLanguage = e.target.value;
    localStorage.setItem('preferredLanguage', state.preferredLanguage);
    if (state.speechEnabled) stopSpeech();
    markAllAsSpoken();
    render();
  });

  el('font-size').addEventListener('input', (e) => {
    document.documentElement.style.setProperty('--subtitle-size', `${e.target.value}px`);
    localStorage.setItem('fontSize', e.target.value);
  });
  const storedSize = localStorage.getItem('fontSize');
  if (storedSize) {
    el('font-size').value = storedSize;
    document.documentElement.style.setProperty('--subtitle-size', `${storedSize}px`);
  }

  // Reading speed + auto catch-up (remembered between visits).
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  };
  const showRate = () => { el('speech-rate-out').textContent = `${state.speechRate.toFixed(2).replace(/0$/, '')}×`; };
  const storedRate = Number(store.get('speechRate'));
  if (storedRate >= 0.5 && storedRate <= 2.5) state.speechRate = storedRate;
  el('speech-rate').value = String(state.speechRate);
  showRate();
  el('speech-rate').addEventListener('input', (e) => {
    state.speechRate = Number(e.target.value);
    store.set('speechRate', String(state.speechRate));
    showRate(); // applies from the next line that is read
  });
  state.autoCatchUp = store.get('autoCatchUp') !== 'false';
  el('auto-catchup').checked = state.autoCatchUp;
  el('auto-catchup').addEventListener('change', (e) => {
    state.autoCatchUp = e.target.checked;
    store.set('autoCatchUp', String(state.autoCatchUp));
  });

  el('show-source').addEventListener('change', (e) => {
    el('source-captions-log').hidden = !e.target.checked;
  });

  el('clear').addEventListener('click', () => {
    state.sourceLines.clear();
    stopSpeech();
    render();
    el('waiting').hidden = false;
  });

  // Speech synthesis toggle requires explicit user interaction (autoplay policy).
  el('speak-toggle').addEventListener('change', (e) => {
    state.speechEnabled = e.target.checked;
    if (!state.speechEnabled) {
      stopSpeech();
      el('pause-speech').hidden = true;
      return;
    }
    if (!('speechSynthesis' in window)) {
      alert('Your browser does not support speech synthesis.');
      e.target.checked = false;
      state.speechEnabled = false;
      return;
    }
    el('pause-speech').hidden = false;
    // Start reading from NOW (new captions); click any caption to hear it.
    markAllAsSpoken();
    // Some browsers only load voices lazily; make sure a gesture-initiated
    // utterance primes the engine so later (non-gesture) speech is allowed.
    try { speechSynthesis.resume(); } catch {}
  });

  // Click a finished caption to hear that line (on-demand reading).
  el('subtitles').addEventListener('click', (e) => {
    const line = e.target.closest?.('.subtitle.speakable');
    if (line) speakLineNow(Number(line.dataset.sequence));
  });

  // Pause / resume / stop speech controls.
  el('pause-speech').addEventListener('click', () => {
    if (!('speechSynthesis' in window)) return;
    if (speechSynthesis.paused) {
      speechSynthesis.resume();
      el('pause-speech').textContent = 'Pause speech';
    } else {
      speechSynthesis.pause();
      el('pause-speech').textContent = 'Resume speech';
    }
  });

  state.sessionId && connect();
});
