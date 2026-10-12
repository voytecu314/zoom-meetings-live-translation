// Transcription module entry point.
// Selects the configured server-side transcription provider. Default is
// "none": recognition then happens in the browser via the Web Speech API and
// no server transcription is needed (the common case for Chrome tab capture).

import { config } from '../config.js';

export function createTranscriptionProvider() {
  const name = config.transcription.provider;
  switch (name) {
    case 'none':
      return null;
    case 'generic-http':
      return createGenericHttpProvider();
    default:
      return null; // unknown names fall back to "none" + a warning in logs
  }
}

/**
 * A reference adapter for a generic HTTP speech-to-text API so integrators
 * have a template: POST multipart audio to TRANSCRIPTION_API_URL with an
 * Authorization: Bearer <TRANSCRIPTION_API_KEY> header; expect `{ text }`.
 * Adapt this to your actual vendor (Azure, Deepgram, Whisper server...).
 */
function createGenericHttpProvider() {
  if (!config.transcription.apiUrl) {
    return {
      name: 'generic-http (unconfigured)',
      async transcribe() {
        throw new Error('TRANSCRIPTION_API_URL is not configured');
      },
    };
  }
  return {
    name: 'generic-http',
    async transcribe(body, { mimeType = 'audio/wav', sourceLanguage = 'en' } = {}) {
      const { fetchWithTimeout, TranscriptionError } = await import('./provider-interface.js');
      const res = await fetchWithTimeout(
        config.transcription.apiUrl,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.transcription.apiKey}`,
            'Content-Type': mimeType,
            'X-Source-Language': sourceLanguage,
          },
          body,
        },
        20000
      );
      if (!res.ok) {
        throw new TranscriptionError(`transcription HTTP ${res.status}`);
      }
      const data = await res.json();
      return typeof data.text === 'string' ? data.text : '';
    },
  };
}
