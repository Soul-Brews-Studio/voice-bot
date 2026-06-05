import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  processPendingThinkRequests,
  startThinkResponder,
} from "../src/bot/think-responder.ts";

async function waitForFile(path: string, timeoutMs = 2_000): Promise<string> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await readFile(path, "utf8");
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`timed out waiting for ${path}`);
}

describe("think responder", () => {
  test("writes a reply file for a new request", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "voice-bot-think-"));
    const botName = "test-bot";
    const root = join(cwd, ".claude", "channels", botName);
    const requestDir = join(root, "think-requests");
    const replyDir = join(root, "think-replies");
    const firstReplyPath = join(replyDir, "req-1.txt");
    const secondReplyPath = join(replyDir, "req-2.txt");
    await mkdir(requestDir, { recursive: true });
    const firstCalls: Array<boolean | undefined> = [];

    const responder = await startThinkResponder({
      cwd,
      botName,
      pollDelayMs: 5,
      log: { error: () => undefined, log: () => undefined, warn: () => undefined },
      runner: async (prompt, request) => {
        expect(prompt.startsWith("hello")).toBe(true);
        expect(request.sessionId).toBe("session-1");
        firstCalls.push(request.firstCall);
        return `reply for ${request.requestId}`;
      },
    });

    try {
      await writeFile(
        join(requestDir, "req-1.json"),
        `${JSON.stringify(
          {
            requestId: "req-1",
            prompt: "hello",
            sessionId: "session-1",
            sessionLabel: "test-label",
            timestamp: new Date().toISOString(),
          },
          null,
          2,
        )}\n`,
      );

      await expect(waitForFile(firstReplyPath)).resolves.toBe("reply for req-1\n");
      await writeFile(
        join(requestDir, "req-2.json"),
        `${JSON.stringify(
          {
            requestId: "req-2",
            prompt: "hello again",
            sessionId: "session-1",
            sessionLabel: "test-label",
            timestamp: new Date().toISOString(),
          },
          null,
          2,
        )}\n`,
      );

      await expect(waitForFile(secondReplyPath)).resolves.toBe("reply for req-2\n");
      expect(firstCalls).toEqual([true, false]);
    } finally {
      responder.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("falls back to env session metadata for legacy requests", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "voice-bot-think-"));
    const botName = "test-bot";
    const requestDir = join(cwd, ".claude", "channels", botName, "think-requests");
    const replyPath = join(
      cwd,
      ".claude",
      "channels",
      botName,
      "think-replies",
      "legacy.txt",
    );
    const oldSessionId = process.env.VOICE_BOT_CLAUDE_SESSION_ID;
    const oldSessionLabel = process.env.VOICE_BOT_CLAUDE_SESSION_LABEL;

    await mkdir(requestDir, { recursive: true });
    await writeFile(
      join(requestDir, "legacy.json"),
      `${JSON.stringify({ requestId: "legacy", prompt: "hello" }, null, 2)}\n`,
    );

    process.env.VOICE_BOT_CLAUDE_SESSION_ID = "env-session";
    process.env.VOICE_BOT_CLAUDE_SESSION_LABEL = "env-label";

    try {
      const processed = await processPendingThinkRequests({
        cwd,
        botName,
        log: { error: () => undefined, log: () => undefined, warn: () => undefined },
        runner: async (_prompt, request) => {
          expect(request.sessionId).toBe("env-session");
          expect(request.sessionLabel).toBe("env-label");
          expect(request.firstCall).toBe(true);
          return "legacy reply";
        },
      });

      expect(processed).toBe(1);
      await expect(readFile(replyPath, "utf8")).resolves.toBe("legacy reply\n");
    } finally {
      if (oldSessionId === undefined) {
        delete process.env.VOICE_BOT_CLAUDE_SESSION_ID;
      } else {
        process.env.VOICE_BOT_CLAUDE_SESSION_ID = oldSessionId;
      }
      if (oldSessionLabel === undefined) {
        delete process.env.VOICE_BOT_CLAUDE_SESSION_LABEL;
      } else {
        process.env.VOICE_BOT_CLAUDE_SESSION_LABEL = oldSessionLabel;
      }
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
