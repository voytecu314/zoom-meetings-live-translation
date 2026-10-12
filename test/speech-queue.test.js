import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSpeechQueue, splitForSpeech } from '../public/speech-queue.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function harness(opts = {}) {
  const spoken = []; // { text, rate }
  let active = null;
  const synth = {
    speak(u) { active = u; spoken.push({ text: u.text, rate: u.rate }); },
    cancel() { active = null; },
  };
  const q = createSpeechQueue({
    synth,
    makeUtterance: (text) => ({ text }),
    watchdogSlackMs: 30,
    gapWaitMs: 120,
    ...opts,
  });
  return {
    q, spoken,
    /** finish the utterance currently being spoken */
    finish() { const u = active; active = null; u?.onend?.(); },
  };
}

test('lines arriving out of order are still read in order (late line is not lost)', async () => {
  const pending = new Set([1]); // seq 1 is still being translated
  const h = harness({ hasPendingBefore: (seq) => [...pending].some((p) => p < seq) });
  h.q.enqueue({ sequence: 2, text: 'second', lang: 'pl' });
  await sleep(40);
  assert.equal(h.spoken.length, 0, 'waits for the lower line instead of skipping it');
  pending.delete(1);
  h.q.enqueue({ sequence: 1, text: 'first', lang: 'pl' });
  assert.deepEqual(h.spoken.map((s) => s.text), ['first']);
  h.finish();
  assert.deepEqual(h.spoken.map((s) => s.text), ['first', 'second']);
});

test('gap wait is bounded: a line that never arrives does not block the queue', async () => {
  const h = harness({ hasPendingBefore: () => true, gapWaitMs: 60 });
  h.q.enqueue({ sequence: 5, text: 'later', lang: 'pl' });
  await sleep(250);
  assert.deepEqual(h.spoken.map((s) => s.text), ['later']);
});

test('falling behind speeds reading up instead of dropping lines', () => {
  const h = harness();
  for (let i = 1; i <= 5; i++) h.q.enqueue({ sequence: i, text: `line ${i}`, lang: 'pl' });
  assert.equal(h.spoken[0].rate, 1, 'nothing was behind when line 1 started');
  for (let i = 0; i < 4; i++) h.finish();
  assert.deepEqual(h.spoken.map((s) => s.text), ['line 1', 'line 2', 'line 3', 'line 4', 'line 5']);
  const rates = h.spoken.map((s) => s.rate);
  assert.ok(rates[1] > 1, 'line 2 is read faster because 3 lines are waiting');
  assert.ok(rates[1] > rates[3] && rates[4] === 1, 'rate relaxes as the backlog shrinks');
  assert.ok(Math.max(...rates) <= 2, 'never faster than the catch-up cap');
});

test('auto catch-up off: user speed is used as-is', () => {
  const h = harness({ autoCatchUp: () => false, getRate: () => 1.3 });
  for (let i = 1; i <= 4; i++) h.q.enqueue({ sequence: i, text: `line ${i}`, lang: 'pl' });
  assert.equal(h.spoken[0].rate, 1.3);
});

test('only an unreasonably long backlog drops the oldest lines, and reports it', () => {
  const skipped = [];
  const h = harness({ maxBacklogSeconds: 5, onSkip: (s) => skipped.push(...s) });
  const long = 'x'.repeat(150); // ~5s at rate 2 ... each
  h.q.enqueue({ sequence: 1, text: 'now speaking', lang: 'pl' });
  for (let i = 2; i <= 6; i++) h.q.enqueue({ sequence: i, text: long, lang: 'pl' });
  assert.ok(skipped.length > 0 && skipped.every((s) => s >= 2 && s <= 5), 'oldest queued lines dropped');
  assert.ok(!skipped.includes(6), 'newest line is always kept');
});

test('watchdog: an utterance whose onend never fires does not freeze the queue', async () => {
  const h = harness();
  h.q.enqueue({ sequence: 1, text: 'a', lang: 'pl' });
  h.q.enqueue({ sequence: 2, text: 'b', lang: 'pl' });
  await sleep(400); // never call finish()
  assert.deepEqual(h.spoken.map((s) => s.text), ['a', 'b']);
});

test('watchdog does not fire while the user has paused speech', async () => {
  let paused = true;
  const h = harness({ isPaused: () => paused });
  h.q.enqueue({ sequence: 1, text: 'a', lang: 'pl' });
  h.q.enqueue({ sequence: 2, text: 'b', lang: 'pl' });
  await sleep(300);
  assert.deepEqual(h.spoken.map((s) => s.text), ['a']);
  paused = false;
  h.finish();
  assert.deepEqual(h.spoken.map((s) => s.text), ['a', 'b']);
});

test('long text is spoken as several chunks but counts as one line', () => {
  const text = Array.from({ length: 8 }, (_, i) => `To jest zdanie numer ${i + 1} o czymś ważnym.`).join(' ');
  assert.ok(text.length > 200);
  const h = harness();
  h.q.enqueue({ sequence: 1, text, lang: 'pl' });
  h.q.enqueue({ sequence: 2, text: 'next', lang: 'pl' });
  let guard = 0;
  while (h.spoken.at(-1).text !== 'next' && guard++ < 20) h.finish();
  const chunks = h.spoken.slice(0, -1);
  assert.ok(chunks.length >= 2 && chunks.every((c) => c.text.length <= 200));
  assert.equal(chunks.map((c) => c.text).join(' '), text);
});

test('stop clears the queue; speakNow replaces it; duplicates are ignored', () => {
  const h = harness();
  h.q.enqueue({ sequence: 1, text: 'a', lang: 'pl' });
  h.q.enqueue({ sequence: 1, text: 'a', lang: 'pl' });
  h.q.enqueue({ sequence: 2, text: 'b', lang: 'pl' });
  assert.equal(h.q.queued, 1);
  h.q.speakNow({ sequence: 9, text: 'click', lang: 'pl' });
  assert.equal(h.spoken.at(-1).text, 'click');
  assert.equal(h.q.queued, 0);
  h.q.stop();
  h.finish();
  assert.equal(h.spoken.length, 2);
});

test('splitForSpeech prefers sentence breaks and never exceeds the limit', () => {
  const t = 'Pierwsze zdanie jest tutaj. Drugie zdanie też. ' + 'słowo '.repeat(80);
  const parts = splitForSpeech(t, 100);
  assert.ok(parts.every((p) => p.length <= 100));
  assert.equal(parts.join(' ').replace(/\s+/g, ' '), t.replace(/\s+/g, ' ').trim());
  assert.deepEqual(splitForSpeech('  '), []);
});
