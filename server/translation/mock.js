// Development / mock translation provider.
// Deterministic, offline, no cost. Marks up the text so it is easy to see
// where each requested language rendered.
//
// Format: "[<lang>] <text>" — e.g. "[de] Hello world"
// Repeated calls give identical output so tests are stable.

export function createMockProvider() {
  return {
    name: 'mock',
    async translate(text, _sourceLanguage, targetLanguage) {
      return `[${targetLanguage}] ${text}`;
    },
    async batchTranslate(texts, source, target) {
      return texts.map((t) => `[${target}] ${t}`);
    },
  };
}
