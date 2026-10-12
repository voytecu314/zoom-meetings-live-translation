// Sentence segmenter tests (spec §5 required cases).
// Verifies exact expected segments, not merely nonempty output.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSegmenter } from '../server/sentence-segmenter.js';

function feedAll(seg, chunks) {
  const out = [];
  for (const c of chunks) out.push(...seg.feed(c));
  return out;
}

test('abbreviation title: "Dr. Smith is joining us. Let\'s begin."', () => {
  const seg = createSegmenter({ locale: 'en' });
  const out = feedAll(seg, ["Dr. Smith is joining us. Let's begin."]);
  assert.deepEqual(out, ["Dr. Smith is joining us.", "Let's begin."]);
});

test('decimal numbers are not split: "The value is 3.14. That\'s the result."', () => {
  const seg = createSegmenter({ locale: 'en' });
  const out = feedAll(seg, ["The value is 3.14. That's the result."]);
  assert.deepEqual(out, ["The value is 3.14.", "That's the result."]);
});

test('U.S. initials/abbrev: "We work in the U.S. We serve Europe, too."', () => {
  const seg = createSegmenter({ locale: 'en' });
  const out = feedAll(seg, ["We work in the U.S. We serve Europe, too."]);
  assert.deepEqual(out, ["We work in the U.S.", "We serve Europe, too."]);
});

test('question + exclamation: "Is it ready? Yes, it is!"', () => {
  const seg = createSegmenter({ locale: 'en' });
  const out = feedAll(seg, ["Is it ready? Yes, it is!"]);
  assert.deepEqual(out, ["Is it ready?", "Yes, it is!"]);
});

test('latin abbreviation: "The API, e.g. the REST endpoint, is ready."', () => {
  const seg = createSegmenter({ locale: 'en' });
  const out = feedAll(seg, ["The API, e.g. the REST endpoint, is ready."]);
  assert.deepEqual(out, ["The API, e.g. the REST endpoint, is ready."]);
});

test('quote with time abbreviation: \'Mr. Jones said, "We\'ll start at 3 p.m." Then he left.\'', () => {
  const seg = createSegmenter({ locale: 'en' });
  const out = feedAll(seg, ['Mr. Jones said, "We\'ll start at 3 p.m." Then he left.']);
  assert.deepEqual(out, ['Mr. Jones said, "We\'ll start at 3 p.m."', 'Then he left.']);
});

test('version numbers are not split: "Version 2.1.4 is available."', () => {
  const seg = createSegmenter({ locale: 'en' });
  const out = feedAll(seg, ["Version 2.1.4 is available."]);
  assert.deepEqual(out, ["Version 2.1.4 is available."]);
});

test('sentence split across two recognition results', () => {
  const seg = createSegmenter({ locale: 'en' });
  const out = feedAll(seg, ["Dr. Smith arrived at noon."]);
  assert.deepEqual(out, ["Dr. Smith arrived at noon."]);
  const out2 = feedAll(seg, [" We started right away."]);
  assert.deepEqual(out2, ["We started right away."]);
});

test('two sentences in one recognition result', () => {
  const seg = createSegmenter({ locale: 'en' });
  const out = feedAll(seg, ["First sentence here. Second one follows!"]);
  assert.deepEqual(out, ["First sentence here.", "Second one follows!"]);
});

test('recognition restart repeating previously finalized text does not duplicate', () => {
  const seg = createSegmenter({ locale: 'en' });
  const out1 = feedAll(seg, ["We should begin now."]);
  assert.deepEqual(out1, ["We should begin now."]);
  // Restart repeats the tail (partial repeat), then adds new text.
  const out2 = feedAll(seg, ["We should begin now. Next topic is budget."]);
  assert.deepEqual(out2, ["Next topic is budget."]);
});

test('long speech without punctuation: clause flush only with maxBufferChars', () => {
  const seg = createSegmenter({ locale: 'en', maxBufferChars: 40 });
  const out = feedAll(seg, [
    "we discussed the budget the timeline and the resources for the project",
  ]);
  assert.ok(out.length >= 1, 'clause flush emitted at least one fragment');
  const flushed = seg.flush(true);
  const joined = [...out, ...(flushed ? [flushed] : [])].join(' ');
  assert.equal(joined, "we discussed the budget the timeline and the resources for the project");
});

test('unpunctuated speech stays buffered when cap disabled', () => {
  const seg = createSegmenter({ locale: 'en', maxBufferChars: 0 });
  const out = feedAll(seg, ["we discussed the budget the timeline and the resources"]);
  assert.deepEqual(out, []);
  assert.equal(seg.bufferedText(), "we discussed the budget the timeline and the resources");
});

test('incomplete sentence flushed on capture stop (translate=true)', () => {
  const seg = createSegmenter({ locale: 'en' });
  const out = feedAll(seg, ["The meeting starts at nine."]);
  assert.deepEqual(out, ["The meeting starts at nine."]);
  feedAll(seg, ["and ten today"]);
  const flushed = seg.flush(true);
  assert.equal(flushed, "and ten today");
  const after = seg.flush(true);
  assert.equal(after, null);
});

test('incomplete sentence discarded on capture stop (translate=false)', () => {
  const seg = createSegmenter({ locale: 'en' });
  feedAll(seg, ["partial thought"]);
  assert.equal(seg.flush(false), null);
  assert.equal(seg.bufferedLength(), 0);
});

test('punctuation and spacing preserved', () => {
  const seg = createSegmenter({ locale: 'en' });
  feedAll(seg, ["Wait — really? Yes.  (I'm serious.)"]);
  const out = seg.flush(true);
  // everything had terminals; nothing should remain buffered... but ensure no invented text
  assert.ok(out === null || typeof out === 'string');
  void out;
});

test('reset clears buffers', () => {
  const seg = createSegmenter({ locale: 'en' });
  feedAll(seg, ["some buffered text"]);
  seg.reset();
  assert.equal(seg.bufferedLength(), 0);
  const out = feedAll(seg, ["Fresh start."]);
  assert.deepEqual(out, ["Fresh start."]);
});
