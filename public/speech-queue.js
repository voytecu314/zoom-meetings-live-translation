// Ordered text-to-speech queue for live translated captions.
// Plain ES module with injected dependencies, so it runs in the browser (live.js)
// and in Node tests.
//
// Why captions used to be skipped:
//  1. Lines were spoken in ARRIVAL order and anything older than the last spoken
//     sequence was discarded. With mixed providers (LLM ~2s, Google ~0.3s) line N
//     can arrive after N+1 -> N was silently lost.            => ordered queue +
//     short "gap wait" for a line that is still being translated.
//  2. A hard cap of 3 queued lines dropped the oldest. TTS is slower than speech,
//     so that happened constantly.                          => speak FASTER when
//     behind (auto catch-up); drop only when the backlog would take > N seconds.
//  3. Browsers sometimes never fire `onend` (long text on network voices, GC of the
//     utterance object), freezing the queue.      => chunking + watchdog + keeping
//     a reference to the active utterance.

/** Split text into pieces of at most `max` chars, preferring sentence/clause breaks. */
export function splitForSpeech(text, max = 200) {
  const clean = String(text).replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  if (clean.length <= max) return [clean];
  const sentences = clean.split(/(?<=[.!?…。！？])\s+/);
  const pieces = [];
  for (const s of sentences) {
    if (s.length <= max) { pieces.push(s); continue; }
    // Too long: break at commas/semicolons, then at spaces.
    let rest = s;
    while (rest.length > max) {
      let cut = Math.max(rest.lastIndexOf(', ', max), rest.lastIndexOf('; ', max));
      if (cut < max * 0.4) cut = rest.lastIndexOf(' ', max);
      if (cut < max * 0.4) cut = max;
      pieces.push(rest.slice(0, cut + 1).trim());
      rest = rest.slice(cut + 1).trim();
    }
    if (rest) pieces.push(rest);
  }
  // Merge small neighbours back together up to `max`.
  const merged = [];
  for (const p of pieces) {
    const last = merged[merged.length - 1];
    if (last && last.length + 1 + p.length <= max) merged[merged.length - 1] = `${last} ${p}`;
    else merged.push(p);
  }
  return merged;
}

export function createSpeechQueue({
  synth,                          // { speak(u), cancel() }
  makeUtterance,                  // (text, lang) => utterance-like object
  getRate = () => 1,              // user's base speed
  autoCatchUp = () => true,       // speed up while behind
  isPaused = () => false,         // user paused speech (don't trip the watchdog)
  hasPendingBefore = () => false, // (sequence, spokenUpTo) => a lower line is still being translated
  onSkip = () => {},              // (sequences[]) lines dropped because we were too far behind
  onState = () => {},             // (sequence | null) which line is being read now
  gapWaitMs = 3000,
  maxBacklogSeconds = 25,
  maxCatchUpRate = 2,
  watchdogSlackMs = 3000,
  charsPerSecond = 14,            // ~speaking speed at rate 1.0 (conservative estimate)
  maxChunkChars = 200,
  now = () => Date.now(),
} = {}) {
  let queue = [];
  let spokenUpTo = -1;
  let current = null;
  let token = 0;
  let pumpTimer = null;

  const estimate = (text, rate) => text.length / (charsPerSecond * Math.max(rate, 0.1));

  function effectiveRate(remaining) {
    const base = getRate();
    if (!autoCatchUp() || remaining <= 0) return base;
    return Math.min(base * (1 + 0.2 * remaining), Math.max(base, maxCatchUpRate));
  }

  function trimBacklog() {
    const fastest = Math.max(getRate(), maxCatchUpRate);
    let total = queue.reduce((s, q) => s + estimate(q.text, fastest), 0);
    const skipped = [];
    while (queue.length > 1 && total > maxBacklogSeconds) {
      const dropped = queue.shift();
      total -= estimate(dropped.text, fastest);
      spokenUpTo = Math.max(spokenUpTo, dropped.sequence);
      skipped.push(dropped.sequence);
    }
    if (skipped.length) onSkip(skipped);
  }

  function pump() {
    if (current) return;
    if (pumpTimer) { clearTimeout(pumpTimer); pumpTimer = null; }
    const head = queue[0];
    if (!head) return;
    // A lower-numbered line is still being translated: briefly wait so it is
    // read BEFORE this one instead of being lost.
    if (hasPendingBefore(head.sequence, spokenUpTo) && now() - head.queuedAt < gapWaitMs) {
      pumpTimer = setTimeout(pump, 150);
      return;
    }
    queue.shift();
    speakItem(head, effectiveRate(queue.length));
  }

  function speakItem(item, rate) {
    const myToken = ++token;
    const chunks = splitForSpeech(item.text, maxChunkChars);
    current = { item, utt: null };
    onState(item.sequence);
    let i = 0;

    const finish = () => {
      if (token !== myToken) return;
      spokenUpTo = Math.max(spokenUpTo, item.sequence);
      current = null;
      onState(null);
      pump();
    };

    const nextChunk = () => {
      if (token !== myToken) return;
      if (i >= chunks.length) return finish();
      const text = chunks[i++];
      const u = makeUtterance(text, item.lang);
      u.rate = rate;
      current.utt = u; // keep a strong reference (some browsers GC it and never fire onend)
      let ended = false;
      let wd = null;
      const end = () => {
        if (ended || token !== myToken) return;
        ended = true;
        clearTimeout(wd);
        nextChunk();
      };
      u.onend = end;
      u.onerror = end;
      const arm = () => {
        wd = setTimeout(() => {
          if (ended || token !== myToken) return;
          if (isPaused()) return arm();
          try { synth.cancel(); } catch {}
          setTimeout(end, 30); // let the engine settle after cancel()
        }, estimate(text, rate) * 1000 * 2 + watchdogSlackMs);
      };
      arm();
      synth.speak(u);
    };

    nextChunk();
  }

  return {
    /** Queue a finished translation: { sequence, text, lang }. */
    enqueue(item) {
      const { sequence } = item;
      if (sequence <= spokenUpTo) return;
      if (current?.item.sequence === sequence || queue.some((q) => q.sequence === sequence)) return;
      const entry = { ...item, queuedAt: now() };
      const at = queue.findIndex((q) => q.sequence > sequence);
      if (at === -1) queue.push(entry); else queue.splice(at, 0, entry);
      trimBacklog();
      pump();
    },
    /** Read one line right now (click on a caption), replacing whatever is queued. */
    speakNow(item) {
      this.stop();
      speakItem({ ...item, queuedAt: now() }, getRate());
    },
    stop() {
      token += 1;
      if (pumpTimer) { clearTimeout(pumpTimer); pumpTimer = null; }
      queue = [];
      current = null;
      try { synth.cancel(); } catch {}
      onState(null);
    },
    /** Treat everything up to `sequence` as already heard. */
    markSpoken(sequence) { spokenUpTo = Math.max(spokenUpTo, sequence); },
    get spokenUpTo() { return spokenUpTo; },
    get queued() { return queue.length; },
  };
}
