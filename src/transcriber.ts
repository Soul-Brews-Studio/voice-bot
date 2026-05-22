/**
 * Public STT API surface — dispatches to backend under src/stt/.
 * Backend selected by STT_BACKEND env (default: whisper-cpp local + Metal).
 *
 * Cleanup: WAV file deleted post-call (privacy: audio discarded post-STT).
 */
export {
  transcribe,
  transcribeAndCleanup,
  sttBackend,
  type TranscribeResult,
} from "./stt/index.ts";
