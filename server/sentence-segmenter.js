// Sentence segmentation module.
//
// Design goals (spec section 5):
// - Candidate sentence boundaries come from Intl.Segmenter (when available)
//   UNION a manual scan for terminal punctuation. Intl.Segmenter alone is NOT
//   trusted: UAX #29 misses common abbreviations and over-splits decimals, so
//   every candidate is verified with targeted rules below.
// - Preserve original punctuation and spacing.
// - Buffer incomplete trailing text; never emit it until it ends with
//   terminal punctuation (or a forced/clause flush happens).
// - Be restart-safe: the caller may feed repeated finalized text (recognition
//   engines repeat their tail after restarting); duplication is prevented by
//   overlap detection against the accumulated raw text.
// - Locale + abbreviation rules are configurable for other source languages.

const TERMINALS = new Set(['.', '?', '!', '。', '！', '？', '؟', '।', '…']);
// Closing characters that may follow a terminal (quotes, brackets).
const CLOSERS = new Set(['"', "'", '”', '’', '»', '«', ')', ']', '}', '」', '』']);

const DEFAULT_ABBREVIATIONS = [
  // English titles (single-dot class: never split when followed by a name)
  'Dr.', 'Mr.', 'Mrs.', 'Ms.', 'Prof.', 'Sr.', 'Jr.', 'St.', 'Gen.', 'Col.',
  'Lt.', 'Capt.', 'Sgt.', 'Rev.', 'Hon.', 'Pres.', 'Gov.', 'Sen.', 'Rep.',
  // Latin / academic
  'e.g.', 'i.e.', 'etc.', 'vs.', 'cf.', 'viz.', 'No.', 'Fig.',
  'Ph.D.', 'M.D.', 'B.A.', 'M.A.',
  // Multi-dot chains: split allowed before a capitalized word
  'U.S.', 'U.K.', 'U.N.', 'E.U.', 'D.C.',
  // Time: split allowed before a capital word, and after closing quotes
  'a.m.', 'p.m.',
];

/**
 * Create a sentence segmenter instance.
 *
 * @param {object} [options]
 * @param {string} [options.locale='en']      BCP-47 source locale for Intl.Segmenter.
 * @param {number} [options.maxBufferChars=0] Max chars in buffer before a clause-boundary
 *                                            forced flush (0 = disabled). Clause-based
 *                                            translation may be less accurate.
 * @param {string[]} [options.extraAbbrev]    Extra abbreviations incl. trailing dot.
 * @param {number} [options.recentWindow]     Rolling window size for duplicate detection.
 */
export function createSegmenter(options = {}) {
  const {
    locale = 'en',
    maxBufferChars = 0,
    extraAbbrev = [],
    recentWindow = 30,
  } = options;

  const ABBREV_SET = new Set(
    [...DEFAULT_ABBREVIATIONS, ...extraAbbrev].map((a) => a.toLowerCase().replace(/\.$/, '') + '.')
  );

  // Raw text accumulated across all fed chunks (used for cursor + rewind).
  let accumulated = '';
  // Index into `accumulated` up to which everything has been emitted.
  let cursor = 0;
  // Rolling list of recently emitted sentences for exact-duplicate detection.
  const recent = [];

  // ------------------------------------------------------------------
  // Targeted rules
  // ------------------------------------------------------------------

  /** True when the dot at i sits between two digits ("3.14", "2.1.4"). */
  function isInsideNumber(text, i) {
    return /[0-9]/.test(text[i - 1] ?? '') && /[0-9]/.test(text[i + 1] ?? '');
  }

  /**
   * Collect the token ending just before the dot at index i, walking back
   * over letters AND dots (to catch multi-dot abbreviations like "e.g"/"U.S").
   * Returns { token, isAbbrev, chained, isInitial }.
   */
  function tokenBefore(text, i) {
    let j = i - 1;
    let token = '';
    while (j >= 0 && i - j <= 8 && /[A-Za-z.]/.test(text[j])) {
      token = text[j] + token;
      j--;
    }
    if (!token) return { token: '', isAbbrev: false, chained: false, isInitial: false };
    const isAbbrev = ABBREV_SET.has(token.toLowerCase() + '.');
    // "Chained" requires an embedded dot BETWEEN letters, e.g. "e.g", "U.S",
    const chained = /^[A-Za-z]+\.[A-Za-z]+(?:\.[A-Za-z]+)*$/.test(token);
    const isInitial = token.length === 1 && /[A-Z]/.test(token);
    return { token, isAbbrev, chained, isInitial };
  }

  /** First word character after position k is an uppercase letter? */
  function nextWordIsCapitalized(text, k) {
    let m = k;
    while (m < text.length && /\s/.test(text[m])) m++;
    return /[A-Z]/.test(text[m] ?? '');
  }

  /**
   * Decide whether the terminal punctuation at index i truly ends a sentence.
   * Returns the split end index (after trailing closers) or -1 if not a split.
   */
  function isRealSentenceEnd(text, i) {
    const ch = text[i];
    if (!TERMINALS.has(ch)) return -1;

    // Compute the split position after trailing closers (quotes/brackets).
    const k = endAfterClosers(text, i);
    if (k < 0) return -1; // e.g. "example.com" — no whitespace after

    // Not a sentence end inside a number ("3.14", "2.1.4").
    if (ch === '.' && isInsideNumber(text, i)) return -1;

    // Evaluate the token BEFORE the terminal (e.g. "3 p.m." + closing quote
    // + next sentence — the abbreviation still guards the split).
    const t = tokenBefore(text, i);

    if (k >= text.length) {
      // Text currently ends here; the next chunk may continue an
      // abbreviation ("…the U.S." + " We serve…"). Keep those buffered.
      return (t.isAbbrev || t.isInitial) ? -1 : k;
    }

    if (t.isAbbrev && !t.chained) return -1; // "etc." "e.g." "Dr." never split

    if (t.isAbbrev) {
      // Multi-dot chains (U.S., a.m., p.m.): a split is allowed before a
      // capitalized word — that is the next sentence, not a continuation.
      return nextWordIsCapitalized(text, k) ? k : -1;
    }
    if (t.isInitial) {
      // Plain initial ("J."): a following capitalized name means the
      // sentence continues ("J. Smith is here."); not a split.
      return nextWordIsCapitalized(text, k) ? -1 : k;
    }
    return k;
  }

  /** Index after any following closing quotes/brackets; must be followed by
   *  whitespace or end of text (rejects "example.com"). Returns -1 if invalid. */
  function endAfterClosers(text, i) {
    let k = i + 1;
    while (k < text.length && CLOSERS.has(text[k])) k++;
    if (k < text.length && !/\s/.test(text[k])) return -1;
    return k;
  }

  // ------------------------------------------------------------------
  // Candidate boundary detection
  // ------------------------------------------------------------------

  let intlSegmenter = null;
  try {
    if (typeof Intl !== 'undefined' && Intl.Segmenter) {
      intlSegmenter = new Intl.Segmenter(locale, { granularity: 'sentence' });
    }
  } catch {
    intlSegmenter = null; // invalid locale etc.
  }

  /** All verified sentence end indices (exclusive) in `text`. Pure function. */
  function findSentenceEnds(text) {
    const ends = new Set();

    // 1) Manual scan — the primary, deterministic source.
    for (let i = 0; i < text.length; i++) {
      const end = isRealSentenceEnd(text, i);
      if (end > 0) ends.add(end);
    }

    // 2) Intl.Segmenter candidates — supplements the manual scan (e.g. for
    //    locale-specific terminal handling), then verified by the same rules.
    if (intlSegmenter) {
      for (const seg of intlSegmenter.segment(text)) {
        const end = seg.index + seg.segment.length;
        if (end > 0 && end <= text.length && !TERMINALS.has(text[end - 1])) {
          // Find the last terminal inside this segment and verify it.
          for (let i = end - 1; i >= 0 && i >= end - 4; i--) {
            if (!TERMINALS.has(text[i])) continue;
            const verified = isRealSentenceEnd(text, i);
            if (verified > 0) {
              ends.add(verified); // verified index, NOT i+1
              break;
            }
          }
        }
      }
    }

    return [...ends].sort((a, b) => a - b);
  }

  /** Does the given text contain an internal clause boundary (comma etc.)? */
  function hasClauseBoundary(text) {
    // Ignore a trailing boundary (that IS the boundary we'd cut at) only if
    // it's at the very end AND followed by nothing — still counts, because a
    // real speaker continues after it (fragment streaming).
    return /[,;:、،]/u.test(text);
  }

  /** Clause-boundary fallback for long unpunctuated speech. */
  function findClauseBoundary(text, from, to) {
    for (const c of [', ', '; ', ': ', '、', '،']) {
      const idx = text.lastIndexOf(c, to - 1);
      if (idx > from) return idx + c.length;
    }
    const space = text.lastIndexOf(' ', to - 1);
    if (space > from) return space + 1;
    return to;
  }

  function pushRecent(s) {
    recent.push(s);
    if (recent.length > recentWindow) recent.shift();
  }

  function isDuplicate(s) {
    return recent.includes(s);
  }

  function emitRange(from, to, sentences) {
    const raw = accumulated.slice(from, to);
    const trimmed = raw.trim();
    if (!trimmed || isDuplicate(trimmed)) return;
    pushRecent(trimmed);
    sentences.push(trimmed);
  }

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------

  /**
   * Feed newly finalized recognition text. Returns complete sentences.
   * Repeated tails from recognition restarts are detected and skipped.
   * For LIVE subtitle input (fast fragment commits), `isFragment` mode adds:
   *   - existing commas/clause boundaries inside the buffer become split
   *     points after a short silence, and
   *   - the very first incomplete fragment after a long gap is emitted early
   *     (clause-based translation — documented as less accurate than full
   *     sentences but required for live delivery without host action).
   * @param {string} text
   * @param {object} [opts]
   * @param {boolean} [opts.isFragment=false]  fast-commit/live mode
   * @returns {string[]}
   */
  function feed(text, opts = {}) {
    const isFragment = !!opts.isFragment;
    if (!text) return [];

    // Restart overlap: engines repeat ALL unprocessed text since their last
    // final result. Detect that exact case — the incoming text starts with
    // the WHOLE unprocessed buffer — and strip it. Partial prefix matches are
    // NOT stripped: they are usually genuine new text that happens to begin
    // with the same words (stripping those destroyed real sentences).
    if (accumulated.length > cursor) {
      const bufferedLen = accumulated.length - cursor;
      const maxLen = Math.min(bufferedLen, text.length, 512);
      if (maxLen === bufferedLen) {
        const tail = accumulated.slice(accumulated.length - maxLen);
        if (maxLen > 0 && text.startsWith(tail)) {
          text = text.slice(maxLen);
        }
      }
    }
    if (!text) return [];

    accumulated += text;
    const sentences = [];

    const ends = findSentenceEnds(accumulated).filter((e) => e > cursor);
    for (const end of ends) {
      emitRange(cursor, end, sentences);
      cursor = end;
    }

    // Clause flushes for live delivery:
    //  (a) long unpunctuated buffer (config cap), and
    //  (b) fragment mode: any buffered clause that already contains a comma
    //      or similar boundary flushes at the LAST boundary — speech continued
    //      past a clause without reaching a period, so streaming it beats
    //      waiting for a sentence end that may be far away. (Documented as
    //      less accurate than full-sentence translation.)
    const buffered = accumulated.length - cursor;
    if (maxBufferChars > 0 && buffered > maxBufferChars) {
      const cut = findClauseBoundary(accumulated, cursor, accumulated.length);
      if (cut > cursor) {
        emitRange(cursor, cut, sentences);
        cursor = cut;
      }
    } else if (isFragment) {
      // Fragment mode = LIVE streaming. Each committed delta is new speech;
      // stream the buffer after every commit so viewers translate along with
      // the speaker. Rolling commits + quiesce promotion on the host/server
      // decide WHEN to commit — here we just deliver what was committed.
      // Trade-off (documented): may translate mid-sentence. The overlap
      // dedupe + recent-window prevents repetition.
      const stillBuffered = accumulated.length - cursor;
      if (stillBuffered >= 3) {
        emitRange(cursor, accumulated.length, sentences);
        cursor = accumulated.length;
      }
    }

    return sentences;
  }

  /**
   * Flush whatever remains in the buffer (capture stopped).
   * @param {boolean} [translate=true] when false the fragment is discarded.
   * @returns {string|null}
   */
  function flush(translate = true) {
    const remaining = accumulated.slice(cursor).trim();
    cursor = accumulated.length;
    if (!remaining) return null;
    if (!translate || isDuplicate(remaining)) return null;
    pushRecent(remaining);
    return remaining;
  }

  /** Chars still buffered (incomplete trailing text). */
  function bufferedLength() {
    return accumulated.length - cursor;
  }

  /** Remaining buffered text (debug/tests). */
  function bufferedText() {
    return accumulated.slice(cursor);
  }

  /** Reset all state. */
  function reset() {
    accumulated = '';
    cursor = 0;
    recent.length = 0;
  }

  return { feed, flush, bufferedLength, bufferedText, reset };
}

// --------------------------------------------------------------------
// Language packs: abbreviation lists per source language (add trailing dot).
// --------------------------------------------------------------------
export const ABBREVIATION_PACKS = {
  en: [],
  de: ['z.B.', 'd.h.', 'u.a.', 'bzw.', 'Mio.', 'Mrd.', 'Nr.'],
  fr: ['M.', 'Mme', 'Mlle', 'p.ex.', 'c.-à-d.', 'art.'],
  es: ['Sra.', 'Sr.', 'Srta.', 'p. ej.', 'Dra.'],
  it: ['Sig.', 'Sig.ra', 'p. es.', 'ecc.', 'Dra.'],
  pt: ['Sra.', 'p. ex.', 'Dra.'],
  ja: [],
  zh: [],
};
