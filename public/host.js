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

function connectHostWs() {
  const ws = new WebSocket(`${wsBase()}/ws/host?session=${encodeURIComponent(state.sessionId)}&token=${encodeURIComponent(state.hostToken)}`);
  state.ws = ws;
  setConn('CONNECTING', 'connecting');

  ws.onopen = () => setConn('LIVE', 'live');
  ws.onclose = () => {
    setConn('DISCONNECTED', 'disconnected');
    // Auto-reconnect unless the user intentionally ended the session.
    if (state.sessionId) setTimeout(() => { if (state.sessionId) connectHostWs(); }, 2000);
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
      appendLog('source-log', msg.text, msg.interim);
      break;
    case 'translation': {
      if (msg.language) {
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

// Timer handles of the CURRENT recognition instance (quiesce timeout +
// rolling-commit interval). stopRecognition clears them; set per start.
let promoteTimers = [];

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

function startRecognition() {
  if (!browserSupportsRecognition()) {
    showCaptureError(
      'This browser exposes no Web Speech recognition API. ' +
      'Use the mock input below, or configure a server-side transcription provider (see README §Fallback).'
    );
    return;
  }
  const RecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
  const recognition = new RecognitionCtor();
  recognition.lang = state.sourceLanguage || 'en-US';
  recognition.continuous = true;
  recognition.interimResults = true;

  // Did the very first attempt produce anything at all?
  let gotAnyResult = false;
  let firstResultTimer = null;

  // Interim->final promotion: real tab audio keeps long non-final stretches.
  // TWO mechanisms work together (either alone stalls):
  //   1. ROLLING COMMITS — every ROLL_COMMIT_MS, the interim hypothesis delta
  //      since the previous commit is sent as final_text, continuously, even
  //      while speech keeps changing the hypothesis. This is what makes
  //      translation LIVE instead of only after Stop capture.
  //      The server-side segmenter deduplicates repeated/overlapping tails.
  //   2. QUIESCENCE PROMOTE — if the hypothesis stays unchanged because the
  //      speaker paused, commit immediately rather than waiting for the tick.
  const ROLL_COMMIT_MS = 1500;
  const QUIESCE_PROMOTE_MS = 1000;
  let committedInterim = '';   // prefix of interim already sent as final_text
  let lastInterim = '';
  let lastInterimChangeAt = 0;
  let promoteTimer = null;
  let rollTimer = null;

  /** Send the uncommitted tail of the current interim hypothesis. */
  function commitInterimTail(hyp) {
    let tail = hyp;
    if (committedInterim && hyp.startsWith(committedInterim)) {
      tail = hyp.slice(committedInterim.length);
    } else if (committedInterim && !hyp.startsWith(committedInterim)) {
      // Hypothesis was revised (earlier words changed). Send the revised
      // tail starting at the last uncommitted sentence-ish boundary;
      // server-side overlap dedupe cleans the seam.
      const anchor = committedInterim.split(/(?<=[.?!])\s+/).pop() || '';
      const idx = anchor ? hyp.lastIndexOf(anchor) : -1;
      tail = idx > -1 ? hyp.slice(idx) : hyp;
    }
    tail = (tail || '').trim();
    if (tail && tail !== state._lastPromoted) {
      state._lastPromoted = tail;
      sendWs({ type: 'final_text', text: tail });
    }
    committedInterim = hyp;
  }

  const startArgs = [];
  if (state.mode === 'tab' && state.captureStream) {
    const track = state.captureStream.getAudioTracks()[0];
    if (track) startArgs.push(track); // experimental overload — tab audio
  }

  let lastFinalIndex = 0; // index tracking to dedupe restarts

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
      if (result.isFinal) {
        // Guard against duplicate finals after engine restarts.
        if (text && text !== state._lastFinal) {
          state._lastFinal = text;
          sendWs({ type: 'final_text', text });
        }
        lastFinalIndex = i + 1;
      } else {
        interim += text;
      }
    }
    // Interim results: display-only broadcast + two continuous commit paths.
    if (interim) {
      sendWs({ type: 'interim_text', text: interim });
      const now = Date.now();
      if (interim !== lastInterim) {
        lastInterim = interim;
        lastInterimChangeAt = now;
        if (promoteTimer) clearTimeout(promoteTimer);
        // Quiescence: hypothesis stabilized while speaker paused → commit now.
        promoteTimer = setTimeout(() => {
          if (lastInterim && Date.now() - lastInterimChangeAt >= QUIESCE_PROMOTE_MS - 50) {
            commitInterimTail(lastInterim);
          }
        }, QUIESCE_PROMOTE_MS);
      }
    }
  };

  // Rolling commit: continuous translation inflow (runs while recognizing).
  rollTimer = setInterval(() => {
    if (state.shouldRestart && lastInterim) commitInterimTail(lastInterim);
  }, ROLL_COMMIT_MS);
  promoteTimers = [promoteTimer, rollTimer];

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
    state.recognizing = false;
    // Auto-restart while capture is active and a mode is still elected, but
    // never after intentional stop: avoids overlapping sessions/loops.
    if (state.shouldRestart && (state.mode === 'tab' || state.mode === 'mic')) {
      setTimeout(() => { if (state.shouldRestart && state.mode !== 'idle') startRecognition(); }, 250);
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
  for (const t of promoteTimers) {
    try { clearInterval(t); clearTimeout(t); } catch {}
  }
  promoteTimers = [];
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
  log.appendChild(item);
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
