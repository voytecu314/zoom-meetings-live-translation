// Transcription provider interface (server-side fallback).
//
// The primary recognition path is the browser's Web Speech API. But the Web
// Speech API has NO standard way to consume an arbitrary MediaStream from
// getDisplayMedia(). If a deployment browser does not couple captured tab
// audio to recognition, a server-side transcription provider can be used
// instead: the host page records captured tab audio into chunks (e.g. 16 kHz
// mono WAV slices) and uploads them; the server transcribes and feeds the
// finalized text into the pipeline.
//
// Every provider implements:
//
//   createTranscriptionProvider() => {
//     name: string,
//     // Transcribe one audio chunk. Returns finalized text for that chunk.
//     // Empty string = nothing recognized.
//     transcribe(AudioBuffer_or_bytes, { mimeType, sourceLanguage }) => Promise<string>
//   }
//
// Keep this replaceable: any speech-to-text API can be adapted here without
// touching sessions, pipeline or broadcasting logic. NOTE: a provider like
// Whisper (cloud or local GPU) may incur charges — that is a per-user
// decision, the app itself includes no transcription provider by default.

export class TranscriptionError extends Error {
  constructor(message, { cause } = {}) {
    super(message);
    this.name = 'TranscriptionError';
    if (cause) this.cause = cause;
  }
}
