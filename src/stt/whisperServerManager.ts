/**
 * Auto-spawn + lifecycle for the local `whisper-server` child process.
 *
 * Owns one whisper-server instance bound to 127.0.0.1:$WHISPER_SERVER_PORT.
 * Called from index.ts startup when STT_BACKEND=whisper-cpp.
 *
 * On crash, child exits → next transcribe request will throw. No auto-restart
 * (keep it simple; voice-bot itself runs under launchd/tmux that will restart it).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { pingWhisperServer } from "./whisperCpp.ts";

const BIN = process.env.WHISPER_BIN || "whisper-server";
const PORT = Number(process.env.WHISPER_SERVER_PORT) || 9000;
const HOST = process.env.WHISPER_SERVER_HOST || "127.0.0.1";
const PATH = process.env.WHISPER_SERVER_PATH || "/transcribe";
const MODEL = process.env.WHISPER_MODEL_PATH || "models/ggml-medium.bin";
const LANG = process.env.WHISPER_LANGUAGE || "th";
const THREADS = Number(process.env.WHISPER_THREADS) || 8;
const BEAM = Number(process.env.WHISPER_BEAM_SIZE) || 1;
// Hallucination guards (large-v3 + Thai). Semantics from whisper.cpp:
//   --no-speech-thold N: silence if no_speech_prob > N. HIGHER = less silence
//     rejection (= more noise transcribed). Default 0.60 is a good balance.
//   --entropy-thold N: decode-fail if decoded text entropy < N. HIGHER = more
//     aggressive fallback on memorized hallucination loops. Default 2.40;
//     we push to 2.8 to better catch broadcast-template hallucinations.
//   --vad-threshold N: VAD speech-confidence cutoff. HIGHER = stricter speech
//     gate at the source (good for noisy mics). Default 0.50; we push to 0.65.
const NO_SPEECH_THOLD = process.env.WHISPER_NO_SPEECH_THOLD || "0.6";
const ENTROPY_THOLD = process.env.WHISPER_ENTROPY_THOLD || "2.8";
const VAD_THRESHOLD = process.env.WHISPER_VAD_THRESHOLD || "0.65";
const NO_FALLBACK = process.env.WHISPER_NO_FALLBACK !== "false"; // default ON
const SUPPRESS_NST = process.env.WHISPER_SUPPRESS_NST !== "false"; // default ON
const VAD_MODEL = process.env.WHISPER_VAD_MODEL_PATH || "models/ggml-silero-v5.1.2.bin";
const VAD_ENABLED = process.env.WHISPER_VAD !== "false"; // default ON if model exists

let proc: ChildProcess | null = null;

export async function startWhisperServer(): Promise<void> {
  // Already up?
  if (await pingWhisperServer(500)) {
    console.log(
      `[whisper-server] already running on ${HOST}:${PORT} — reusing`,
    );
    return;
  }

  if (!existsSync(MODEL)) {
    throw new Error(
      `[whisper-server] model file not found: ${MODEL}\n` +
        `Download via:\n` +
        `  curl -L -o ${MODEL} https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL.split("/").pop()}`,
    );
  }

  const args = [
    "-m", MODEL,
    "-l", LANG,
    "--host", HOST,
    "--port", String(PORT),
    "--inference-path", PATH,
    "-t", String(THREADS),
    "-bs", String(BEAM),
    // Hallucination guards
    "-nth", NO_SPEECH_THOLD,
    "-et", ENTROPY_THOLD,
  ];
  if (NO_FALLBACK) args.push("-nf");
  if (SUPPRESS_NST) args.push("-sns");

  if (VAD_ENABLED && existsSync(VAD_MODEL)) {
    args.push("--vad", "--vad-model", VAD_MODEL, "-vt", VAD_THRESHOLD);
    console.log(
      `[whisper-server] VAD enabled (model=${VAD_MODEL}, threshold=${VAD_THRESHOLD})`,
    );
  } else if (VAD_ENABLED) {
    console.warn(
      `[whisper-server] WHISPER_VAD requested but model not found: ${VAD_MODEL} — running without VAD`,
    );
  }

  console.log(`[whisper-server] spawning: ${BIN} ${args.join(" ")}`);

  proc = spawn(BIN, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });

  proc.stdout?.on("data", (d) => {
    const line = d.toString().trim();
    if (line) console.log(`[whisper-server] ${line}`);
  });
  proc.stderr?.on("data", (d) => {
    const line = d.toString().trim();
    if (line && !line.startsWith("ggml_metal_") && !line.startsWith("load_backend"))
      console.log(`[whisper-server] ${line}`);
  });
  proc.on("exit", (code, sig) => {
    console.warn(
      `[whisper-server] exited code=${code} sig=${sig} — transcribe calls will fail until restart`,
    );
    proc = null;
  });

  // Wait until /transcribe responds (model load takes 2-5s)
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await pingWhisperServer(500)) {
      console.log(`[whisper-server] ready on ${HOST}:${PORT} (model=${MODEL})`);
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("[whisper-server] failed to become ready within 30s");
}

export async function stopWhisperServer(): Promise<void> {
  if (!proc) return;
  console.log("[whisper-server] shutting down...");
  proc.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    if (!proc) return resolve();
    const t = setTimeout(() => {
      try {
        proc?.kill("SIGKILL");
      } catch {}
      resolve();
    }, 3000);
    proc.on("exit", () => {
      clearTimeout(t);
      resolve();
    });
  });
  proc = null;
}
