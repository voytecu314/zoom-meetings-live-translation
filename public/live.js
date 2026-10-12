// Viewer page logic: subtitle display, language pick, reconnection, optional
// speech synthesis. Subtitles render immediately; speech is optional and
// never blocks text display.

const el = (id) => document.getElementById(id);

const state = {
  sessionId: location.pathname.split('/').pop(),
  ws: null,
  preferredLanguage: null, // picked / stored language
  targetLanguages: [],
  sourceLanguage: 'en',
  // sequence -> { text: '' , translations: Map(lang->text)} for ordering
  sourceLines: new Map(),
  historyLoaded: false,
  speaking: false,
  speechQueue: [],     // ordered [{sequence, text}]
  spokenUpTo: -1,
  speakingNow: null,   // current utterance bookkeeping
  speechEnabled: false,
};

const SUBTITLE_LIMIT = 60; // bounded history kept in DOM

// ------------------------------------------------------------------
// WebSocket connection + reconnection
// ------------------------------------------------------------------

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws/live?session=${encodeURIComponent(state.sessionId)}`;
}

function connect() {
  setStatus('CONNECTING', 'connecting');
  const ws = new WebSocket(wsUrl());
  state.ws = ws;

  ws.onopen = () => setStatus('LIVE', 'live');
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handle(msg);
  };
  ws.onclose = () => {
    setStatus('DISCONNECTED', 'disconnected');
    console.warn('[viewer] ws closed — reconnecting in 2s');
    setTimeout(() => { if (!stopped && !state.closedByServer) connect(); }, 2000); // reconnect handling
  };
  ws.onerror = () => setStatus('DISCONNECTED', 'disconnected');
}

let stopped = false;

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
        for (const h of msg.history) applyMessage(h);
        state.historyLoaded = true;
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
      rememberSource(msg.sequence, msg.text);
      // Translations lag recognition by a second or three on real providers;
      // show the SOURCE line dimmed immediately, replaced by its translation
      // when it arrives (swap happens automatically on the next render()).
      render();
      break;

    case 'translation':
      rememberTranslation(msg.sequence, msg.language, msg.text);
      render();
      enqueueSpeech(msg.sequence);
      break;

    case 'session_stopped':
      stopped = true;
      state.closedByServer = true;
      state.speechEnabled = false;
      setStatus('SESSION ENDED', 'disconnected');
      hideControls();
      break;

    case 'error':
      if (msg.recoverable === false) setStatus('DISCONNECTED', 'disconnected');
      console.warn('server error:', msg.message);
      break;
  }
}

// ------------------------------------------------------------------
// Data model: keep source text + per-language translations keyed by sequence
// ------------------------------------------------------------------

function rememberSource(sequence, text) {
  if (!state.sourceLines.has(sequence)) {
    state.sourceLines.set(sequence, { text, translations: new Map() });
    // keep memory bounded
    if (state.sourceLines.size > 200) {
      const oldest = Math.min(...state.sourceLines.keys());
      state.sourceLines.delete(oldest);
    }
  } else {
    state.sourceLines.get(sequence).text = text;
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
  list.textContent = '';  for (const seq of seqs) {
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
    div.className = 'subtitle' + (pending ? ' pending' : '');
    div.dataset.sequence = String(seq);
    div.textContent = text; // XSS-safe
    list.appendChild(div);
  }

  // trim DOM history
  while (list.children.length > SUBTITLE_LIMIT) list.removeChild(list.firstChild);

  el('waiting').hidden = anyShown;
  if (anyShown) list.scrollTop = list.scrollHeight;
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

function enqueueSpeech(sequence) {
  if (!state.speechEnabled) return;
  const lang = languageInUse() || state.targetLanguages[0];
  if (!lang) return;
  const entry = state.sourceLines.get(sequence);
  const text = entry?.translations.get(lang);
  if (!text) return;
  if (sequence <= state.spokenUpTo) return; // prevent regression
  state.speechQueue.push({ sequence, text, lang });
  processSpeechQueue();
}

function processSpeechQueue() {
  if (!state.speechEnabled || state.speakingNow || !('speechSynthesis' in window)) return;
  const next = state.speechQueue.shift();
  if (!next) return;
  state.speakingNow = next;

  const u = new SpeechSynthesisUtterance(next.text);
  u.lang = mapToVoiceLocale(next.lang);
  const voice = pickVoice(u.lang);
  if (voice) u.voice = voice;
  u.onend = () => {
    state.spokenUpTo = Math.max(state.spokenUpTo, next.sequence);
    state.speakingNow = null;
    processSpeechQueue();
  };
  u.onerror = () => {
    state.speakingNow = null;
    processSpeechQueue();
  };
  // Text subtitle already rendered — speech must not block it.
  speechSynthesis.speak(u);
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
  speechSynthesis.cancel();
  state.speechQueue.length = 0;
  state.speakingNow = null;
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
  for (const id of ['language-select', 'speak-toggle', 'pause-speech', 'clear']) {
    const n = el(id);
    if (n) n.disabled = true;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  el('language-select').addEventListener('change', (e) => {
    state.preferredLanguage = e.target.value;
    localStorage.setItem('preferredLanguage', state.preferredLanguage);
    if (state.speechEnabled) stopSpeech();
    state.spokenUpTo = -1;
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

  el('show-source').addEventListener('change', (e) => {
    el('source-captions-log').hidden = !e.target.checked;
  });

  el('clear').addEventListener('click', () => {
    state.sourceLines.clear();
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
    // Speak anything already translated but not yet spoken.
    const lang = languageInUse() || state.targetLanguages[0];
    const seqs = [...state.sourceLines.keys()].sort((a, b) => a - b);
    for (const seq of seqs) {
      if (seq > state.spokenUpTo) enqueueSpeech(seq);
    }
    void lang;
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
