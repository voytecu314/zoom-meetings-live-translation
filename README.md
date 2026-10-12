# Zoom Live Translation

Live translated subtitles for Zoom meetings — one host captures the Zoom tab
audio in their browser, speech is recognized and translated, and viewers open a
plain URL to watch the subtitles live. No accounts, no installs, no database.

## How it works

```
Host browser                     Server (Node/Express/ws)          Viewer browser
───────────────────              ────────────────────────          ─────────────────
Zoom meeting tab                 sentence segmenter                /live/<sessionId>
  └─ getDisplayMedia()  ──ws──▶  (abbreviations, decimals,    ──▶  subtitle display
  └─ Web Speech recognition         restart-safety)                language selector
  └─ finalized sentences  ──▶    translation provider            optional speechSynthesis
  └─ interim captions     ──▶    (pluggable, mock by default)    reconnect handling
```

**Status of each path, honestly stated:**

| Path | Status |
|------|--------|
| Sentence segmentation → translation → broadcast | **Implemented and tested** (29 unit tests + e2e smoke test, `npm test`) |
| Mock input mode (no Zoom needed) | **Working** — host page has a mock panel |
| Zoom tab audio capture via `getDisplayMedia()` | Implemented per spec; the browser dialog path works in Chromium browsers but **end-to-end recognition of captured tab audio could not be verified in this environment** (no Chromium instance available here — see “Known limitations”) |
| Tab audio → Web Speech recognition | **Known browser limitation** (below) — the mock panel and server-side fallback are the reliable paths |

## Prerequisites

- **Node.js 20+** (tested on Node 22 LTS)
- Any OS; viewers need only a modern browser

## Install & start

```bash
npm install
npm start          # serves on http://localhost:3000 (override with PORT)
```

For development with auto-reload: `npm run dev`.

## Configuration

Copy `.env.example` to `.env` and edit. All settings have working defaults
(`TRANSLATION_PROVIDER=mock`, so the app runs offline out of the box).

| Var | Meaning |
|-----|---------|
| `PORT` | HTTP+WS port (default 3000) |
| `PUBLIC_BASE_URL` | Optional. Base for viewer links, e.g. `https://sub.example.com`. If unset, derived from the host's request |
| `TRUST_PROXY` | `true` (default): use `X-Forwarded-For` for per-IP limits behind a proxy/tunnel |
| `PAUSE_THRESHOLD_MS` | Fallback end-of-utterance: ms without new text before the final translation (default 1800). The host normally signals the pause itself (~1.2 s of silence) |
| `MAX_UTTERANCE_WORDS` | An utterance this long is finalized even without a pause (default 40) |
| `DRAFT_TRANSLATIONS` | `true` (default): re-translate the growing utterance live (drafts replaced in place, never spoken). `false`: one translation per utterance |
| `DRAFT_INTERVAL_MS` / `DRAFT_MIN_WORDS` / `DRAFT_MIN_NEW_WORDS` | Draft throttling: min ms between drafts per language (1000), min words before the first draft (3), min new words between drafts (2) |
| `TRANSLATION_PROVIDER` | `mock` (dev, free, offline) or `google-x` |
| `TRANSLATION_CONCURRENCY` | Max parallel translation requests (default 4) |
| `TRANSLATION_TIMEOUT_MS` | Per-request timeout (default 8000) |
| `SESSION_TIMEOUT_SECONDS` | Idle session expiry (default 3600, 0=never) |
| `VIEWER_GRACE_SECONDS` | How long viewers can linger after the host leaves |
| `MAX_BUFFER_CHARS` | Flush buffer at clause boundary after N chars (0 = off) |
| `WS_ALLOWED_ORIGINS` | Comma-separated origins for WebSocket validation (set this in production!) |
| `TRANSCRIPTION_PROVIDER` | `none` (default) or `generic-http` — server-side fallback |

## How text is chunked for translation

Chrome's speech recognition returns text **without punctuation**, so sentence
boundaries cannot be found in the text. Translation is therefore done per
*utterance* (speech up to a pause), never per fixed number of words:

1. While the speaker talks, the whole utterance so far is re-translated
   (throttled) as a **draft**; viewers replace the same caption line in place
   (shown slightly dimmed).
2. On a pause (host sends `utterance_end` after ~1.2 s of silence or when
   Chrome finalizes a result; server timer as fallback), one **final**
   translation of the complete utterance replaces the draft.
3. With `TRANSLATION_PROVIDER=llm`, finals are translated by an LLM that also
   sees the previous lines (punctuation, misheard words, interruptions) while
   drafts stay on Google. On any LLM error or an exhausted quota the call falls
   back to `google-x`, and the LLM is skipped for a cooldown. A pause right
   after a dangling word ("and", "the"...) is held open (`DANGLING_HOLD_MS`).
   Failovers are logged (`⚠ llm failed: rate limited (429) → falling back to
   google-x`, `✓ llm is working again`) plus a per-minute summary line.
   `LOG_LEVEL=debug` shows every text chunk and translated line.
4. Only finals are read aloud and stored in the catch-up history.

If the recognizer does emit sentence punctuation, it also ends utterances.

### Reading aloud (viewer)

Lines are read in order. If reading falls behind, it speeds up (**Auto
catch-up**) instead of skipping; only a backlog of more than ~25 s drops the
oldest lines, and those stay on screen dimmed (click one to hear it). The
**Speed** slider sets the base reading speed and is remembered per browser.

## Testing without Zoom (mock mode)

1. Open `/host`, pick source + target languages, click **Create session**.
2. Use the **Mock input** panel: type `Dr. Smith is joining us. Let's begin.`,
   press Enter — you'll see it segmented into two sentences, then translations
   appear for every configured target language.
3. Open the copied viewer URL in another window/nav to see the full viewer
   experience, including the optional **Speak** toggle (speech synthesis).

## Running a real session

1. On the host machine, open the Zoom meeting **in a browser tab** (web client
   or the tab that plays the meeting audio).
2. On `/host`: create the session, click **Start capture**, and in the browser's
   sharing dialog select the **Zoom tab** and **enable tab-audio sharing**.
3. The app verifies an audio track exists — if you forgot the audio checkbox you
   get an explicit error instead of silence. **No speech recognition starts
   automatically**; browsers cannot feed captured tab audio into their speech
   recognizer (see "Known limitation" below).
4. Choose a transcription source explicitly:
   - **Mock input** on the host page (always works, good for testing), or
   - the opt-in **"Recognize my microphone"** toggle, which clearly states that
     it transcribes your **microphone**, not the Zoom tab — useful only when you
     speak into the mic yourself, or
   - a server-side transcription provider (see the fallback section) for real
     tab-audio recognition.
5. Share the viewer URL. Viewers pick their language and optionally enable spoken
   subtitles. They never need mic/screen/Zoom access.
6. Click **Stop capture** to finish; you choose whether the trailing unfinished
   fragment gets translated or discarded.
7. **End session for everyone** closes the session for all viewers.

## Browser support (transcription paths)

| Scenario | Result |
|----------|--------|
| Chrome/Edge (recent): `SpeechRecognition.start(audioTrack)` | **Primary path** — experimental overload accepts the captured tab `MediaStreamTrack` and recognizes the TAB audio. Verified in the wild; auto-probed with a 2.5 s results-timeout |
| Chrome/Edge: `getDisplayMedia` with tab audio | Capture always works (audio track verified) |
| Optional mic recognition (explicit toggle) | Works in Chrome/Edge/other browsers with the Web Speech API; clearly labeled as transcribing the mic |
| Safari/Firefox: `getDisplayMedia` audio | Often unsupported or forced per-app; expect the mock path |

### Known limitation: Web Speech API cannot consume a MediaStream

The Web Speech API (`SpeechRecognition`) historically has **no standard mechanism to accept
an arbitrary `MediaStream`** from `getDisplayMedia()`. Chromium's recognition
always used the system default **microphone**. Recent Chrome/Edge builds added
an **experimental `start(audioTrack)` overload** that accepts a
`MediaStreamTrack` — this app now uses it as the primary path:

1. Captures the tab audio and immediately attempts `recognition.start(audioTrack)`;
2. probes for 2.5 s — if results arrive, tab-audio recognition is live (status
   shows "Direct tab-audio recognition is working");
3. if the browser ignores the overload (old builds) or refuses permission, the
   app **stops recognition and never silently transcribes the microphone** —
   instead it labels the situation and shows the opt-in mic toggle + mock input;
4. the mic toggle explicitly says it transcribes the **microphone**, not the
   Zoom tab;
5. the server-side transcription provider fallback (template in
   `server/transcription/`) remains available for deployments that need a
   guaranteed vendor path (**a cloud STT vendor may charge money**).

Do not assume that capturing + recognition silently works just because audio
tracks exist. Verify in your target browser before a real meeting.

## Translation providers

- **mock** (default): free, offline, returns `[de] Hello world` style markup.
  Use it for development and tests.
- **google-x**: uses `google-translate-api-x` (an optional npm dependency,
  installed automatically when available). **Warning:** it hits unofficial
  consumer endpoints. It can be rate-limited, break, or stop working at any
  time, and heavy use may violate Google's ToS. Not covered by any guarantee.
  Recent real-session tests showed working `en→de/fr` output, but treat it as
  best-effort.
- **Others**: implement the interface in `server/translation/provider-interface.js`
  (just `translate(text, src, tgt) → Promise<string>`) and register it in
  `server/translation/index.js`. DeepL, Azure, OpenAI-compatible endpoints all
  fit — those may or may not be free.

**Cost note:** the app, mock provider, and self-hosted server are free. The  `google-x` route uses an unofficial API without cost today but no stability
promise; any serious deployment should budget for a proper translation API or
STT vendor if you connect one.

## Spoken subtitles

Viewers enable the **Speak** toggle (explicit user action, per autoplay
policies). Text subtitles always render immediately — speech never blocks them.
Speech uses the browser `speechSynthesis` API: queued in sequence order, no
overlapping utterances, pause/resume/stop controls, and graceful behavior when
no matching voice exists.

## Deployment (HTTPS/WSS)

Run behind a reverse proxy or secure tunnel with TLS:

```bash
# example with Caddy (auto-HTTPS)
caddy reverse-proxy --from subtitles.example.com --to localhost:3000

# or a quick tunnel for testing
npx cloudflared tunnel --url http://localhost:3000
```

Set `PUBLIC_BASE_URL=https://subtitles.example.com` and
`WS_ALLOWED_ORIGINS=https://subtitles.example.com` (comma-separated list is
allowed). Browsers require HTTPS (secure context) for `getDisplayMedia` and
WSS for mixed-content-free WebSockets.

## Security notes

- Session IDs are 64-bit cryptographically random (`crypto.randomBytes`), separate
  24-byte host tokens; host tokens never appear in viewer URLs.
- Host WS connections are authorized per message; viewers can only listen and
  pick a language — they cannot affect the session.
- Payload limits, per-IP connection caps, basic REST rate limiting, and
  heartbeats for dead connections are built in.
- Subtitle content is rendered with `textContent` only (no HTML injection).
- Nothing is persisted to disk; meetings exist only in memory.
- **Participant consent:** recording/translating a meeting may be legally
  restricted. Inform participants that live translation is running.

## Project layout

```
server/
  index.js               Express + static + WS wiring
  config.js              env parsing with defaults
  sessions.js            session lifecycle, tokens, history, expiry
  websocket.js           /ws/host + /ws/live, messages, heartbeats
  pipeline.js            segment → assign seq → translate → broadcast
  sentence-segmenter.js  Intl.Segmenter + targeted abbreviation/number rules
  transcription/        server-side transcription fallback (provider template)
  translation/           provider interface, mock, google-x adapter
public/                  landing, host page, viewer page, styles
test/                    29 node:test cases + e2e-ws.mjs smoke script
```

## Tests

```bash
npm test                       # 29 tests: segmentation (all specced cases),
                               # translation (mock, retry, limiter, timeout),
                               # sessions (isolation, auth tokens, ordering)
node test/e2e-ws.mjs           # full WS round-trip (start server in another terminal)
```

The segmentation suite covers every case required by the spec, including
`Dr. Smith`, `3.14`, `2.1.4`, `U.S.`, `p.m.` + quotes, sentences split across
recognition chunks, restart duplicates, and flush/discard of trailing text.

## Troubleshooting

- **No tab audio available**: re-run Start capture and tick **Share tab audio**
  in the browser dialog; make sure you selected a tab, not a window/screen.
- **`SpeechRecognition` produces nothing after tab capture**: this browser build
  ignores the experimental `start(audioTrack)` overload — the app tells you and
  stops. Update Chrome/Edge to a recent version, or use the mic toggle / mock
  input / server-side transcription.
- **Viewer shows DISCONNECTED**: server restart or network drop — viewers auto-
  reconnect every 2s and catch up from the bounded history buffer.
- **Translation errors appear in the UI**: they are recoverable — the host
  message log shows the per-sequence failure; try again or switch provider.
- **WS_ALLOWED_ORIGINS rejects my proxy**: include the exact scheme+host your
  browser uses, e.g. `https://sub.example.com`.

## Free vs. paid

| Component | Cost |
|-----------|------|
| Server, pages, WebSocket layer, segmenter | Free (self-hosted) |
| `mock` translation provider | Free (offline) |
| `google-translate-api-x` | Free today, unofficial — no uptime guarantee |
| Browser speech recognition / synthesis | Free, browser-dependent |
| Optional server-side STT vendor | Whatever that vendor charges |
