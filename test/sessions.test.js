// Session + pipeline tests: authorization, isolation, ordering, protocol.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createSession,
  getSession,
  closeSession,
  generateSessionId,
  generateHostToken,
  nextSequence,
  recordTranslation,
  claimTranslation,
  __resetAll,
  __allSessions,
} from '../server/sessions.js';
import { ingestFinalText, flushSession } from '../server/pipeline.js';
import { initTranslationProvider } from '../server/translation/index.js';
import { createMockProvider } from '../server/translation/mock.js';
import { __setProviderForTests } from '../server/translation/index.js';

test.beforeEach(() => { void test; });
// (node:test has no beforeEach for plain objects; we reset manually)

function broadcaster() {
  const sent = [];
  return {
    sent,
    fn: (sessionId, obj) => { void sessionId; sent.push(obj); },
  };
}

test('session ids and tokens are random and unguessable', () => {
  const a = generateSessionId();
  const b = generateSessionId();
  assert.notEqual(a, b);
  assert.ok(a.length >= 10);
  const t1 = generateHostToken();
  const t2 = generateHostToken();
  assert.notEqual(t1, t2);
  assert.notEqual(t1, a); // host token must not be derivable from session id
});

test('two sessions are fully isolated', () => {
  __resetAll();
  __setProviderForTests(createMockProvider());
  const s1 = createSession({ sourceLanguage: 'en', targetLanguages: ['de'] });
  const s2 = createSession({ sourceLanguage: 'en', targetLanguages: ['fr'] });
  assert.notEqual(s1.id, s2.id);
  assert.notEqual(s1.hostToken, s2.hostToken);

  const b1 = broadcaster();
  ingestFinalText(s1, 'This is session one.', b1.fn);
  const b2 = broadcaster();
  ingestFinalText(s2, 'Session two text.', b2.fn);

  assert.equal(s1.sequence, 1);
  assert.equal(s2.sequence, 1);
  assert.ok(b1.sent.every((m) => m.sessionId === s1.id));
  assert.ok(b2.sent.every((m) => m.sessionId === s2.id));
  assert.match(b1.sent[0].text, /session one/);
  closeSession(s1.id);
  closeSession(s2.id);
});

test('source messages carry monotonic sequence numbers and valid protocol shape', () => {
  __resetAll();
  __setProviderForTests(createMockProvider());
  const s = createSession({ sourceLanguage: 'en', targetLanguages: ['de'] });
  const b = broadcaster();
  ingestFinalText(s, 'First sentence. Second one follows.', b.fn);

  const sources = b.sent.filter((m) => m.type === 'source');
  assert.equal(sources.length, 2);
  sources.forEach((m) => {
    assert.equal(m.type, 'source');
    assert.equal(m.sessionId, s.id);
    assert.equal(typeof m.sequence, 'number');
    assert.equal(typeof m.text, 'string');
  });
  assert.deepEqual(
    sources.map((m) => m.sequence),
    [1, 2]
  );
  closeSession(s.id);
});

test('translations carry sequence + language and are recorded once per claim', async () => {
  __resetAll();
  __setProviderForTests(createMockProvider());
  const s = createSession({ sourceLanguage: 'en', targetLanguages: ['de'] });
  const b = broadcaster();
  ingestFinalText(s, 'Hello there.', b.fn);

  // duplicate claim must be rejected
  assert.equal(claimTranslation(s, 1, 'de'), false);

  // wait for translation jobs
  await new Promise((r) => setTimeout(r, 120));
  const translations = b.sent.filter((m) => m.type === 'translation');
  assert.equal(translations.length, 1);
  assert.equal(translations[0].sequence, 1);
  assert.equal(translations[0].language, 'de');
  assert.equal(translations[0].text, '[de] Hello there.');
  closeSession(s.id);
});

test('flush emits trailing fragment and assigns next sequence', () => {
  __resetAll();
  __setProviderForTests(createMockProvider());
  const s = createSession({ sourceLanguage: 'en', targetLanguages: ['de'] });
  s._fragmentMode = true; // fragment-mode session (host streaming)
  const b = broadcaster();
  ingestFinalText(s, 'Complete sentence.', b.fn);   // streamed at seq 1
  ingestFinalText(s, 'ok', b.fn);                 // <3 chars stays buffered
  const entry = flushSession(s, { translate: true }, b.fn);
  assert.ok(entry, 'flush emits the tiny buffered tail');
  assert.equal(entry.text, 'ok');
  assert.equal(entry.sequence, 2);
  closeSession(s.id);
});

test('non-fragment ingest (mock input) keeps sentence-boundary behavior', () => {
  __resetAll();
  __setProviderForTests(createMockProvider());
  const s = createSession({ sourceLanguage: 'en', targetLanguages: ['de'] });
  const b = broadcaster();
  // Non-fragment mode: text without terminal punctuation stays buffered
  // until a sentence end or flush — normal segmentation semantics.
  ingestFinalText(s, 'trailing buffer text', b.fn); // <12 chars stays buffered
  const entry = flushSession(s, { translate: true }, b.fn);
  assert.ok(entry, 'flush emits the buffered tail in normal mode');
  assert.equal(entry.text, 'trailing buffer text');
  closeSession(s.id);
});

test('history is appended and bounded', () => {
  __resetAll();
  const s = createSession({ sourceLanguage: 'en', targetLanguages: ['de'] });
  s.historyLimit = 3;
  for (let i = 1; i <= 5; i++) {
    const e = nextSequence(s, `line ${i}`);
    void e;
  }
  assert.equal(s.history.length, 3);
  assert.deepEqual(
    s.history.map((h) => h.text),
    ['line 3', 'line 4', 'line 5']
  );
  closeSession(s.id);
});

test('closed sessions cannot be retrieved', () => {
  __resetAll();
  const s = createSession({});
  const id = s.id;
  closeSession(id);
  assert.equal(getSession(id), null);
  const remaining = [...__allSessions()];
  assert.ok(remaining.every((x) => x.id !== id), 'closed session removed from the map');
  __resetAll();
});
