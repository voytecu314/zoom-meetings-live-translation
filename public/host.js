// Host page logic.
// Flow: create session (REST) → connect WS with host token → capture the Zoom
// tab audio via getDisplayMedia → feed finalized recognition text into the
// pipeline.
//
// Tab-audio recognition strategy (spec §4, updated after verifying the
// experimental Chromium behavior):
//   1. PRIMARY: the experimental SpeechRecognition.start(audioTrack) overload.
//      Recent Chrome/Edge builds accept a MediaStreamTrack from
//      getDisplayMedia() and recognize THE CAPTURED TAB AUDIO. Detected via
//      start throwing/ignoring the argument — we introspect:
//      if start(audioTrack) is accepted (no InvalidStateError/refusal and
//      results flow honoring the track), this is the real path.
//   2. FALLBACK A: explicit "recognize my microphone" checkbox — CLEARLY
//      labeled as transcribing the MIC, never auto-started (spec forbids a
//      silent mic fallback).
//   3. FALLBACK B: mock input panel — always works, whole pipeline testable.
//   4. Long-term: server-side transcription provider (server/transcription/).
// How mode is decided:
//   - If start(audioTrack) starts AND within ~2.5s we receive results (or no
//     error), treat as TAB mode. If we get a mic-style error or no results
//     while the tab track is live, stop and surface the choice UI instead.
// The UI labels every active mode in #capture-status / #capture-error.

const el = (id) => document.getElementById(id);

const state = {
  sessionId: null,
  hostToken: null,
  ws: null,
  captureStream: null,
  recognition: null,
  recognizing: false,
  shouldRestart: false, // true while the user wants capture to keep running
  mode: 'idle', // 'idle' | 'tab' | 'mic'
  micRecognitionEnabled: false, // explicit user opt-in only
  sourceLanguage: 'en-US',
};

// ------------------------------------------------------------------
// Language lists
// ------------------------------------------------------------------

const TARGET_OPTIONS = [
  ['en', 'English'], ['de', 'German'], ['fr', 'French'], ['es', 'Spanish'],
  ['it', 'Italian'], ['pt', 'Portuguese'], ['nl', 'Dutch'], ['ru', 'Russian'],
  ['zh', 'Chinese'], ['ja', 'Japanese'], ['ko', 'Korean'], ['ar', 'Arabic'],
  ['hi', 'Hindi'], ['tr', 'Turkish'], ['pl', 'Polish'],
];

function addTargetOption(pre = '') {
  const sel = document.createElement('select');
  sel.className = 'target-select';
  sel.setAttribute('aria-label', 'Target language');
  for (const [code, label] of TARGET_OPTIONS) {
    const opt = document.createElement('option');
    opt.value = code;
    opt.textContent = label;
    if (code === pre) opt.selected = true;
    sel.appendChild(opt);
  }
  el('target-list').appendChild(sel);
}

// ------------------------------------------------------------------
// Session creation + WS connection (host token is secret, never in viewer URL)
// ------------------------------------------------------------------

async function createSession() {
  const sourceLanguage = el('source-language').value;
  const targets = [...document.querySelectorAll('.target-select')].map((s) => s.value).filter(Boolean);
  el('setup-error').hidden = true;
  try {
    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceLanguage, targetLanguages: targets.length ? targets : ['en'] }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    const data = await res.json();
    state.sessionId = data.sessionId;
    state.hostToken = data.hostToken;
    el('viewer-url').value = data.viewerUrl;
    el('setup').hidden = true;
    el('capture').hidden = false;
    el('output').hidden = false;
    setStatus('capture-status', 'IDLE', 'idle');
    connectHostWs();
  } catch (err) {
    const p = el('setup-error');
    p.textContent = `Could not create session: ${err.message}`;
    p.hidden = false;
  }
}

function wsBase() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}`;
}

let reconnectDelay = 1000;

function connectHostWs() {
  const ws = new WebSocket(`${wsBase()}/ws/host?session=${encodeURIComponent(state.sessionId)}&token=${encodeURIComponent(state.hostToken)}`);
  state.ws = ws;
  setConn('CONNECTING', 'connecting');

  ws.onopen = () => { reconnectDelay = 1000; setConn('LIVE', 'live'); };
  ws.onclose = (ev) => {
    setConn('DISCONNECTED', 'disconnected');
    // Auto-reconnect unless the session ended / auth failed / another host
    // tab took over (4401 / 4404 / 4000) or the user ended it on purpose.
    if ([4401, 4404, 4000].includes(ev.code)) {
      showCaptureError(ev.code === 4000
        ? 'This session is now controlled from another host tab. Close this one.'
        : 'The session no longer exists on the server (it ended or the server restarted). Create a new session.');
      return;
    }
    if (state.sessionId) {
      reconnectDelay = Math.min(reconnectDelay * 1.5, 10000);
      setTimeout(() => { if (state.sessionId && state.ws === ws) connectHostWs(); }, reconnectDelay);
    }
  };
  ws.onerror = () => setConn('DISCONNECTED', 'disconnected');

  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handleServerMessage(msg);
  };
}

function setConn(text, cls) {
  const b = el('connection-status');
  b.textContent = text;
  b.className = `badge ${cls}`;
}

function setStatus(id, text, cls) {
  const b = el(id);
  b.textContent = text;
  b.className = `badge ${cls}`;
}

function handleServerMessage(msg) {
  switch (msg.type) {
    case 'session_joined':
      state.sourceLanguage = msg.sourceLanguage;
      break;
    case 'capture_status':
      setStatus('capture-status', msg.status.toUpperCase(), msg.status === 'running' ? 'live' : 'idle');
      break;
    case 'source':
      if (msg.final === false) break; // draft of an open utterance: host already sees the interim line
      if (msg.interim) {
        showInterimLine(msg.text); // one live line, not 100 log entries
      } else {
        clearInterimLine();
        appendLog('source-log', msg.text, false);
      }
      break;
    case 'viewers': {
      const v = el('viewer-count');
      if (v) v.textContent = `${msg.count} viewer${msg.count === 1 ? '' : 's'}`;
      break;
    }
    case 'translation': {
      if (msg.language && msg.final !== false) {
        // Host sees all languages with a small tag.
        appendLog('translation-log', `[${msg.language}] ${msg.text}`, false, msg.language);
      }
      break;
    }
    case 'error':
      if (msg.recoverable === false) {
        showCaptureError(`Server error: ${msg.message}`);
      } else {
        showCaptureError(`Recoverable: ${msg.message}`);
      }
      break;
    case 'session_stopped':
      stopCapture();
      el('capture').hidden = true;
      setConn('SESSION ENDED', 'disconnected');
      break;
  }
}

// ------------------------------------------------------------------
// Capture + recognition
// ------------------------------------------------------------------

function browserSupportsCapture() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
}

function browserSupportsRecognition() {
  return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

async function startCapture() {
  el('capture-error').hidden = true;
  if (!browserSupportsCapture()) {
    showCaptureError('This browser does not support screen/tab capture (getDisplayMedia). Please use a current Chromium-based browser.');
    return;
  }
  try {
    // Video must be enabled: display capture generally requires a video track.
    // The video track is intentionally ignored afterwards.
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      // Plain audio:true maximizes tab-audio availability; the disabled
      // processing constraints would mutate the meeting audio on some builds.
      audio: true,
      // Chrome-only hints that improve the dialog when supported.
      ...(window.chrome ? { selfBrowserSurface: 'exclude', systemAudio: 'include', preferCurrentTab: false } : {}),
    });
    state.captureStream = stream;

    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) {
      // Spec §4: verify an audio track exists and explain what to do.
      stopCapture();
      showCaptureError(
        'No audio track was shared. Please click Start capture again and select the Zoom meeting TAB, ' +
        'and make sure the “Also share tab audio” (or “Share audio”) checkbox is enabled.'
      );
      return;
    }

    // Release the video track — it is not needed once the dialog has picked a surface.
    for (const vt of stream.getVideoTracks()) vt.stop();

    audioTracks[0].addEventListener('ended', () => {
      // Browser ended sharing on its own (user clicked browser UI "Stop sharing").
      setStatus('capture-status', 'SHARING ENDED', 'idle');
      stopRecognition({ intentional: true });
      showCaptureError('Screen/tab sharing was ended from the browser side. Click Start capture to restart.');
    });

    // Announce capture over WS and try the experimental tab-audio path first.
    sendWs({ type: 'start_capture' });
    setStatus('capture-status', 'CAPTURING', 'live');
    el('stop-capture').hidden = false;
    el('mic-recognition-row').hidden = false;
    showCaptureNotice('Tab audio captured. Trying direct tab-audio recognition (experimental)...');
    state.mode = 'tab';
    el('mic-toggle').checked = false;
    state.micRecognitionEnabled = false;
    startRecognition();
  } catch (err) {
    if (err && (err.name === 'NotAllowedError' || err.name === 'AbortError')) {
      showCaptureError('Capture was denied or cancelled. Capture starts only after your explicit consent in the browser dialog.');
    } else {
      showCaptureError(`Capture failed: ${err?.message ?? err}`);
    }
  }
}

// ------------------------------------------------------------------
// Live committer: turns the recognizer's rolling hypothesis into a stream of
// NON-overlapping text deltas ("final_text") sent while the speaker is still
// talking. Chrome's recognizer keeps a result "interim" for a long time and
// usually adds no punctuation, so waiting for isFinal (or a full sentence)
// means nothing reaches viewers until capture stops.
//
//   - per recognition result index we remember how many tokens (words, or
//     characters for ja/zh/th) were already sent and only ever send the rest;
//   - while a result is interim, every TICK_MS the stable part is committed
//     (all tokens except the last MARGIN ones, which the engine may still
//     revise) once at least MIN_TOKENS are pending;
//   - if the hypothesis stops changing for IDLE_MS (speaker paused) or the
//     recognizer ends, everything pending is committed;
//   - when a result becomes final, its remaining tail is committed.
// ------------------------------------------------------------------

function createLiveCommitter(send, lang, onUtteranceEnd = () => {}) {
  const charMode = /^(ja|zh|th)/i.test(lang || '');
  const tokenize = (t) => (charMode ? Array.from(t.replace(/\s+/g, '')) : t.trim().split(/\s+/).filter(Boolean));
  const join = (toks) => (charMode ? toks.join('') : toks.join(' '));
  const MARGIN = charMode ? 2 : 1;
  const MIN_TOKENS = charMode ? 6 : 3;
  const TICK_MS = 800;
  // Silence that counts as the end of an utterance. Longer = fewer mid-sentence
  // cuts (better translations) but slower finals; drafts keep captions live.
  const IDLE_MS = 1200;

  const sent = new Map(); // result index -> tokens already committed
  const live = new Map(); // result index -> latest tokens of an interim result
  let tickTimer = null;
  let idleTimer = null;
  let dirty = false;

  function commit(i, tokens, upto) {
    const from = sent.get(i) || 0;
    if (upto <= from) return;
    sent.set(i, upto);
    const text = join(tokens.slice(from, upto));
    if (text) { send(text); dirty = true; }
  }

  // Tell the server the speaker paused / the result ended, so it can produce
  // the final translation of everything sent since the last boundary.
  function endUtterance() {
    if (!dirty) return;
    dirty = false;
    onUtteranceEnd();
  }

  function flushLive(all) {
    for (const [i, tokens] of live) {
      const upto = all ? tokens.length : tokens.length - MARGIN;
      const pending = upto - (sent.get(i) || 0);
      if (pending >= (all ? 1 : MIN_TOKENS)) commit(i, tokens, upto);
    }
  }

  function clearTimers() {
    if (tickTimer) { clearTimeout(tickTimer); tickTimer = null; }
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  }

  return {
    update(i, text, isFinal) {
      const tokens = tokenize(text);
      if (isFinal) {
        commit(i, tokens, tokens.length);
        live.delete(i);
        endUtterance(); // Chrome finalizes a result after a pause
        return;
      }
      live.set(i, tokens);
      if (!tickTimer) {
        tickTimer = setTimeout(() => { tickTimer = null; flushLive(false); }, TICK_MS);
      }
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { idleTimer = null; flushLive(true); endUtterance(); }, IDLE_MS);
    },
    /** Commit everything still pending (recognizer ended / capture stopped). */
    flushAll() {
      clearTimers();
      flushLive(true);
      live.clear();
      endUtterance();
    },
    dispose() {
      clearTimers();
      live.clear();
    },
  };
}

// Throttled display-only interim caption (latest value wins).
let interimTimer = null;
let interimPending = null;
function sendInterimThrottled(text) {
  interimPending = text;
  if (interimTimer) return;
  interimTimer = setTimeout(() => {
    interimTimer = null;
    if (interimPending) sendWs({ type: 'interim_text', text: interimPending });
    interimPending = null;
  }, 250);
}

function startRecognition() {
  if (!browserSupportsRecognition()) {
    showCaptureError(
      'This browser exposes no Web Speech recognition API. ' +
      'Use the mock input below, or configure a server-side transcription provider (see README §Fallback).'
    );
    return;
  }
  // Never run two recognizers at once (restart races would duplicate text).
  if (state.recognition) {
    try { state.recognition.onend = null; state.recognition.abort(); } catch {}
    state.committer?.dispose();
  }
  const RecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
  const recognition = new RecognitionCtor();
  recognition.lang = state.sourceLanguage || 'en-US';
  recognition.continuous = true;
  recognition.interimResults = true;

  const committer = createLiveCommitter(
    (text) => sendWs({ type: 'final_text', text }),
    recognition.lang,
    () => sendWs({ type: 'utterance_end' }),
  );
  state.committer = committer;

  // Did the very first attempt produce anything at all?
  let gotAnyResult = false;
  let firstResultTimer = null;

  const startArgs = [];
  if (state.mode === 'tab' && state.captureStream) {
    const track = state.captureStream.getAudioTracks()[0];
    if (track) startArgs.push(track); // experimental overload — tab audio
  }

  recognition.onresult = (event) => {
    if (!gotAnyResult) {
      gotAnyResult = true;
      if (firstResultTimer) { clearTimeout(firstResultTimer); firstResultTimer = null; }
      if (state.mode === 'tab') {
        showCaptureNotice('Direct tab-audio recognition is working (experimental API).');
      }
    }
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      const text = result[0]?.transcript ?? '';
      if (!text) continue;
      committer.update(i, text, result.isFinal);
      if (!result.isFinal) interim += (interim ? ' ' : '') + text.trim();
    }
    if (interim) sendInterimThrottled(interim);
  };

  recognition.onerror = (event) => {
    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      // In TAB mode this means the overload fell back to the mic path and was
      // refused — do NOT silently retry as mic.
      if (state.mode === 'tab') {
        tabRecognitionUnavailable('Permission required. This browser build refused direct tab-audio recognition.');
      } else {
        showCaptureError('Microphone permission denied for speech recognition. You can still use the mock input, or allow the mic in the browser site settings and re-enable the toggle.');
        state.shouldRestart = false;
        state.micRecognitionEnabled = false;
        el('mic-toggle').checked = false;
      }
    } else if (event.error === 'no-speech' || event.error === 'aborted') {
      // Benign — restart logic handles it.
    } else {
      console.warn('recognition error:', event.error);
    }
  };

  // TAB-mode probe: if nothing comes back shortly after start, assume the
  // browser ignored the audioTrack argument (older builds) and stop quietly,
  // telling the host what their options are. No silent mic fallback.
  function armTabProbe() {
    if (state.mode !== 'tab') return;
    if (firstResultTimer) clearTimeout(firstResultTimer);
    firstResultTimer = setTimeout(() => {
      if (!gotAnyResult && state.mode === 'tab') {
        tabRecognitionUnavailable('This browser did not accept direct tab-audio recognition (it may be transcribing the microphone instead, which we do not allow silently).');
      }
    }, 2500);
  }

  recognition.onend = () => {
    if (firstResultTimer) { clearTimeout(firstResultTimer); firstResultTimer = null; }
    // The engine ends sessions on its own every so often; whatever was still
    // interim would be lost, so commit it before restarting.
    committer.flushAll();
    if (state.recognition === recognition) {
      state.recognition = null;
      state.recognizing = false;
    }
    // Auto-restart while capture is active, never after an intentional stop.
    if (state.shouldRestart && (state.mode === 'tab' || state.mode === 'mic')) {
      setTimeout(() => { if (state.shouldRestart && state.mode !== 'idle' && !state.recognition) startRecognition(); }, 250);
    }
  };

  try {
    // Experimental overload in supporting builds: start(audioTrack).
    // Older builds ignore the argument (mic path). The 2.5s probe catches that.
    if (startArgs.length) recognition.start(...startArgs);
    else recognition.start();
    state.recognition = recognition;
    state.recognizing = true;
    state.shouldRestart = true;
    if (startArgs.length) armTabProbe();
  } catch (err) {
    // start() can throw InvalidStateError if already started — do not overlap.
    console.warn('recognition start failed:', err);
    committer.dispose();
    if (state.mode === 'tab') {
      tabRecognitionUnavailable('Direct tab-audio recognition was rejected on start (' + (err?.name ?? 'Error') + ').');
    }
  }
}

/**
 * TAB mode failed (probe timeout / refusal / start error). Stop everything,
 * label the UI honestly, and leave the explicit mic toggle + mock input as
 * the visible options. Never auto-switch to the mic.
 */
function tabRecognitionUnavailable(reason) {
  stopRecognition({ intentional: true });
  state.mode = 'idle';
  showCaptureError(
    reason + '\n' +
    'Options: (a) toggle "Recognize my microphone" below — labeled, transcribes the MIC,\n' +
    '(b) use the mock input panel, or (c) upgrade Chrome/Edge — recent builds support\n' +
    'SpeechRecognition.start(audioTrack) for real tab-audio recognition.'
  );
  setStatusSafe('RECOGNITION UNAVAILABLE', 'idle');
}

function setStatusSafe(text, cls) {
  // capture-status badge; keep CAPTURING alive if the tab track still streams.
  const current = el('capture-status').textContent;
  if (current !== 'CAPTURING') setStatus('capture-status', text, cls);
}

function stopRecognition({ intentional = false } = {}) {
  state.shouldRestart = false;
  // Send whatever is still pending BEFORE tearing the recognizer down.
  if (state.committer) { state.committer.flushAll(); state.committer = null; }
  if (interimTimer) { clearTimeout(interimTimer); interimTimer = null; interimPending = null; }
  if (state.recognition) {
    try { state.recognition.onend = null; state.recognition.abort(); } catch {}
    state.recognition = null;
    state.recognizing = false;
  }
  void intentional;
}

function stopCapture() {
  stopRecognition({ intentional: true });
  if (state.captureStream) {
    for (const track of state.captureStream.getTracks()) track.stop();
    state.captureStream = null;
  }
  el('stop-capture').hidden = true;
  el('mic-recognition-row').hidden = true; // re-hide mic toggle with capture
  setStatus('capture-status', 'IDLE', 'idle');
  sendWs({ type: 'stop_capture' });
  // Offer to translate or discard the pending fragment.
  el('flush-tail').hidden = false;
  el('discard-tail').hidden = false;
}

function showCaptureNotice(message) {
  showCaptureError(message); // same styled paragraph, non-fatal informational text
}

// ------------------------------------------------------------------
// Mock input (spec §12)
// ------------------------------------------------------------------

function sendMockFinal() {
  const text = el('mock-input').value.trim();
  if (!text) return;
  sendWs({ type: 'final_text', text });
  el('mock-input').value = '';
}

function sendMockInterim() {
  const text = el('mock-interim').value.trim();
  if (!text) return;
  sendWs({ type: 'interim_text', text });
  el('mock-interim').value = '';
}

// ------------------------------------------------------------------
// Utilities
// ------------------------------------------------------------------

function sendWs(obj) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(obj));
  }
}

function showCaptureError(message) {
  const p = el('capture-error');
  p.textContent = message;
  p.hidden = false;
}

function showInterimLine(text) {
  const log = el('source-log');
  let line = log.querySelector('.log-item.interim');
  if (!line) {
    line = document.createElement('div');
    line.className = 'log-item interim';
    log.appendChild(line);
  }
  line.textContent = text;
  log.scrollTop = log.scrollHeight;
}

function clearInterimLine() {
  el('source-log').querySelector('.log-item.interim')?.remove();
}

function appendLog(logId, text, isInterim, tag) {
  const log = el(logId);
  const item = document.createElement('div');
  item.className = 'log-item' + (isInterim ? ' interim' : '');
  if (tag) {
    const badge = document.createElement('span');
    badge.className = 'tag';
    badge.textContent = tag;
    item.appendChild(badge);
  }
  const span = document.createElement('span');
  // Safe rendering: textContent, never innerHTML (XSS-safe).
  span.textContent = text;
  item.appendChild(span);
  const interimLine = log.querySelector('.log-item.interim');
  if (interimLine) log.insertBefore(item, interimLine);
  else log.appendChild(item);
  while (log.childNodes.length > 100) log.removeChild(log.firstChild);
  log.scrollTop = log.scrollHeight;
}

// ------------------------------------------------------------------
// Wire up UI
// ------------------------------------------------------------------

el('add-target').addEventListener('click', () => addTargetOption('en'));
addTargetOption('de'); // sensible default, host can change/remove-or-add
el('create-session').addEventListener('click', createSession);
el('start-capture').addEventListener('click', startCapture);
el('stop-capture').addEventListener('click', stopCapture);
el('mic-toggle').addEventListener('change', (e) => {
  state.micRecognitionEnabled = e.target.checked;
  if (state.micRecognitionEnabled) {
    // Explicit opt-in: transcribes the MICROPHONE (labeled in the UI).
    state.mode = 'mic';
    startRecognition();
  } else {
    stopRecognition({ intentional: true });
    state.mode = 'idle';
  }
});
el('mock-send').addEventListener('click', sendMockFinal);
el('mock-interim-send').addEventListener('click', sendMockInterim);
el('mock-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendMockFinal(); });
el('copy-viewer-url').addEventListener('click', async () => {
  const input = el('viewer-url');
  try {
    await navigator.clipboard.writeText(input.value);
    el('copy-viewer-url').textContent = 'Copied!';
    setTimeout(() => { el('copy-viewer-url').textContent = 'Copy'; }, 1500);
  } catch {
    input.select();
    document.execCommand('copy');
  }
});
el('stop-session').addEventListener('click', () => {
  if (!confirm('End this session for all viewers?')) return;
  sendWs({ type: 'stop_session' });
  state.sessionId = null;
  state.hostToken = null;
  stopCapture();
  el('capture').hidden = true;
  el('output').hidden = true;
  setConn('SESSION ENDED', 'disconnected');
});
el('flush-tail').addEventListener('click', () => {
  sendWs({ type: 'flush_tail', translate: true });
  el('flush-tail').hidden = true;
  el('discard-tail').hidden = true;
});
el('discard-tail').addEventListener('click', () => {
  sendWs({ type: 'flush_tail', translate: false });
  el('flush-tail').hidden = true;
  el('discard-tail').hidden = true;
});
window.addEventListener('beforeunload', () => { try { state.ws?.close(); } catch {} });
