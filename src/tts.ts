/**
 * Public TTS API surface — dispatches to backend under src/tts/.
 * Backend selected by TTS_BACKEND env (default: mac-say = macOS `say` + Kanya).
 */
export {
  synthesizeTts,
  deleteTtsFile,
  ttsBackend,
  type TtsFile,
} from "./tts/index.ts";
