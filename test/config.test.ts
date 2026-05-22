import { describe, expect, test } from "bun:test";
import { createConfig, validateConfig } from "../src/config.js";

const validEnv = {
  HOME: "/tmp",
  DISCORD_TOKEN: "token",
  DISCORD_APP_ID: "app",
  DISCORD_GUILD_ID: "guild",
  DC_OWNER_IDS: "1,2",
  WHISPER_BIN: "/bin/whisper",
  WHISPER_MODEL: "/models/ggml.bin",
  EDGE_TTS_BIN: "/bin/edge-tts",
  FFMPEG_BIN: "ffmpeg",
  MAW_BIN: "/bin/maw",
};

const okOptions = {
  access: () => {},
  mkdir: () => undefined,
  spawn: () => ({ status: 0, error: undefined }),
} as any;

describe("config validation", () => {
  test("passes with required env, readable files, binaries, and dirs", () => {
    const cfg = createConfig(validEnv);
    expect(validateConfig(cfg, okOptions)).toEqual([]);
  });

  test("reports missing required Discord env", () => {
    const cfg = createConfig({ HOME: "/tmp" });
    const errors = validateConfig(cfg, okOptions);
    expect(errors).toContain("Missing DISCORD_TOKEN");
    expect(errors).toContain("Missing DISCORD_APP_ID");
    expect(errors).toContain("Missing DISCORD_GUILD_ID");
    expect(errors).toContain("Missing DC_OWNER_IDS");
  });

  test("reports unreadable model path", () => {
    const cfg = createConfig(validEnv);
    const errors = validateConfig(cfg, {
      ...okOptions,
      access: (path: string) => {
        if (path === "/models/ggml.bin") throw new Error("missing");
      },
    } as any);
    expect(errors).toContain("WHISPER_MODEL is not readable: /models/ggml.bin");
  });
});
