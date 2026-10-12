// Adapter for google-translate-api-x (optional dependency).
//
// WARNING (documented requirement): google-translate-api-x talks to
// _unofficial consumer endpoints_ of Google Translate. These can change,
// rate-limit, or stop working at any time, and heavy use may violate
// Google's ToS. Nothing is guaranteed. If this provider proves unreliable,
// swap in another implementation of the provider interface — the rest of
// the app (sessions, pipeline, broadcast) does not depend on it.
//
// The package is an optional dependency: if it is not installed (e.g. it
// failed to install on your Node version), creating the provider throws a
// clear error at construction time.

export function createGoogleTranslateProvider() {
  return {
    name: 'google-x',
    async translate(text, sourceLanguage, targetLanguage) {
      const lib = await import('google-translate-api-x');
      const translateFn = lib.default ?? lib;
      const opts = { to: normalize(targetLanguage) };
      // auto-save automatic source detection unless explicitly given
      if (sourceLanguage && sourceLanguage !== 'auto') {
        opts.from = normalize(sourceLanguage);
      }
      const res = await translateFn(text, opts);
      return res.text;
    },
  };
}

/**
 * Map the app's BCP-47-ish codes ("en-US", "pt-BR", "zh") to the codes
 * google-translate-api-x accepts. That library only knows "zh-CN"/"zh-TW"
 * (plain "zh" throws "language not supported"), and "he"/"iw" etc.
 */
export function normalize(lang) {
  if (!lang) return 'auto';
  const lower = String(lang).toLowerCase();
  const [base, region] = lower.split('-');
  if (base === 'zh') return region === 'tw' || region === 'hk' ? 'zh-TW' : 'zh-CN';
  return base || lower;
}
