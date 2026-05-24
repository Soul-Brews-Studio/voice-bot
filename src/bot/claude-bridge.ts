import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  callDiscordTool,
  discordTools,
  type ClaudeTool,
} from "../tools/index.ts";

export interface ClaudeBridge {
  ask(message: string): Promise<string>;
  useSession(sessionId: string, label?: string): Promise<void>;
  close(): Promise<void>;
}

export interface ClaudeBridgeOptions {
  command?: string;
  args?: string[];
  timeoutMs?: number;
  cwd?: string;
  tools?: ClaudeTool[];
  maxToolRounds?: number;
}

interface ToolCall {
  name: string;
  arguments?: Record<string, unknown>;
}

type BridgeMode = "maw-hey" | "claude-p";

function removeFlag(args: string[], flag: string, takesValue = false): string[] {
  const result: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag) {
      if (takesValue) i++;
      continue;
    }
    result.push(args[i]!);
  }
  return result;
}

function setFlag(args: string[], flag: string, value: string): string[] {
  return [...removeFlag(args, flag, true), flag, value];
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function ensureFlag(args: string[], flag: string): string[] {
  return args.includes(flag) ? args : [...args, flag];
}

function defaultSessionLabel(): string {
  const botName = process.env.BOT_NAME ?? process.env.VOICE_BOT_NAME ?? "voice-bot";
  const d = new Date();
  const stamp =
    `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}` +
    `-${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;
  return `${botName}-${stamp}`;
}

function botName(): string {
  return process.env.BOT_NAME ?? process.env.VOICE_BOT_NAME ?? "voice-bot";
}

function claudePrintArgs(sessionId: string, firstCall: boolean): string[] {
  const model = process.env.CLAUDE_MODEL ?? "sonnet";
  let args = ["-p", "--model", model, "--output-format", "text"];
  args = firstCall ? [...args, "--session-id", sessionId] : [...args, "--continue"];
  if (process.env.CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS === "1") {
    args = ensureFlag(args, "--dangerously-skip-permissions");
  }
  return args;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shortMessage(message: string): string {
  const singleLine = message.replace(/\s+/g, " ").trim();
  return singleLine.length > 120 ? `${singleLine.slice(0, 117)}...` : singleLine;
}

function normalizeClaudePrintArgs(
  args: string[],
  sessionId: string,
  firstCall: boolean,
): string[] {
  args = removeFlag(args, "-p");
  args = removeFlag(args, "--print");
  args = removeFlag(args, "--input-format", true);
  args = removeFlag(args, "--session-id", true);
  args = removeFlag(args, "--continue");
  if (!hasFlag(args, "--model")) {
    args = setFlag(args, "--model", process.env.CLAUDE_MODEL ?? "sonnet");
  }
  args = firstCall ? setFlag(args, "--session-id", sessionId) : ensureFlag(args, "--continue");
  args = setFlag(args, "--output-format", "text");
  return ["-p", ...args];
}

export async function sendToClaude(
  message: string,
  options: ClaudeBridgeOptions = {},
): Promise<string> {
  const session = new PersistentClaudeSession(options);
  try {
    return await session.ask(message);
  } finally {
    await session.close();
  }
}

class PersistentClaudeSession {
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private sessionId: string = crypto.randomUUID();
  private label = defaultSessionLabel();
  private isFirstCall = true;
  private mawWakeAttempted = false;

  constructor(private readonly options: ClaudeBridgeOptions = {}) {}

  ask(message: string): Promise<string> {
    const run = this.queue
      .catch(() => undefined)
      .then(() => this.askWithTools(message));
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  async useSession(sessionId: string, label = defaultSessionLabel()): Promise<void> {
    if (this.sessionId === sessionId && this.label === label) return;
    this.closed = false;
    this.sessionId = sessionId;
    this.label = label;
    this.isFirstCall = true;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  private async askWithTools(message: string): Promise<string> {
    const tools = this.options.tools ?? discordTools;
    const maxToolRounds = this.options.maxToolRounds ?? 2;
    let prompt = withToolInstructions(message, tools);
    for (let round = 0; round <= maxToolRounds; round++) {
      const reply = await this.askOnce(prompt);
      const toolCall = extractToolCall(reply);
      if (!toolCall) return reply;

      const result = await callDiscordTool(toolCall.name, toolCall.arguments ?? {});
      prompt =
        `${message}\n\n` +
        `Tool ${toolCall.name} returned:\n${JSON.stringify(result, null, 2)}\n\n` +
        "Reply to the user with the final answer. If another Discord tool is required, return another TOOL_CALL line.";
    }
    throw new Error("[claude-bridge] exceeded tool call round limit");
  }

  private async askOnce(prompt: string): Promise<string> {
    if (this.closed) throw new Error("[claude-bridge] session is closed");

    if (this.bridgeMode() === "maw-hey") {
      try {
        return await this.askViaMawHey(prompt);
      } catch (error: any) {
        console.warn(
          `[claude-bridge] maw-hey failed, falling back to claude-p: ${error?.message ?? error}`,
        );
      }
    }

    return this.askViaClaudeP(prompt);
  }

  private bridgeMode(): BridgeMode {
    return process.env.BRIDGE_MODE === "maw-hey" ? "maw-hey" : "claude-p";
  }

  private async ensureMawSessionStarted(): Promise<void> {
    if (this.mawWakeAttempted) return;
    this.mawWakeAttempted = true;

    const target = process.env.MAW_TARGET ?? botName();
    try {
      const proc = Bun.spawn(["maw", "wake", target], {
        stdout: "ignore",
        stderr: "pipe",
        cwd: this.cwd(),
        env: process.env,
      });
      const timeout = new Promise<"timeout">((resolve) => {
        setTimeout(() => resolve("timeout"), 15_000);
      });
      const result = await Promise.race([proc.exited, timeout]);
      if (result === "timeout") {
        try {
          proc.kill();
        } catch {
          // already exited
        }
        console.warn(`[claude-bridge] maw wake timed out target=${target}`);
        return;
      }
      if (result !== 0) {
        const errorText = await new Response(proc.stderr).text();
        console.warn(
          `[claude-bridge] maw wake failed target=${target}: ${errorText.trim() || `exit ${result}`}`,
        );
      }
    } catch (error: any) {
      console.warn(
        `[claude-bridge] maw wake unavailable target=${target}: ${error?.message ?? error}`,
      );
    }
  }

  private cwd(): string {
    return this.options.cwd ?? process.env.ORACLE_REPO ?? process.cwd();
  }

  private channelRoot(): string {
    return join(this.cwd(), ".claude", "channels", botName());
  }

  private async askViaMawHey(prompt: string): Promise<string> {
    await this.ensureMawSessionStarted();

    const timeoutMs =
      this.options.timeoutMs ??
      (Number(process.env.CLAUDE_REPLY_TIMEOUT_MS) || 90_000);
    const requestId = crypto.randomUUID();
    const target = process.env.MAW_TARGET ?? botName();
    const root = this.channelRoot();
    const requestDir = join(root, "think-requests");
    const replyDir = join(root, "think-replies");
    const requestPath = join(requestDir, `${requestId}.json`);
    const replyPath = join(replyDir, `${requestId}.txt`);

    await mkdir(requestDir, { recursive: true });
    await mkdir(replyDir, { recursive: true });
    await writeFile(
      requestPath,
      `${JSON.stringify(
        {
          requestId,
          prompt,
          timestamp: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
    );

    const heyMessage =
      `Voice trigger: ${shortMessage(prompt)}. ` +
      `Read request at ${requestPath} and write reply to ${replyPath}`;
    console.log(
      `[claude-bridge] maw-hey request target=${target} request_id=${requestId}`,
    );

    const hey = Bun.spawn(["maw", "hey", target, heyMessage], {
      stdout: "ignore",
      stderr: "pipe",
      cwd: this.cwd(),
      env: process.env,
    });
    const [heyExit, heyError] = await Promise.all([
      hey.exited,
      new Response(hey.stderr).text(),
    ]);
    if (heyExit !== 0) {
      await Promise.all([
        rm(requestPath, { force: true }),
        rm(replyPath, { force: true }),
      ]).catch(() => undefined);
      throw new Error(`maw hey exited ${heyExit}: ${heyError.trim() || "no stderr"}`);
    }

    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (existsSync(replyPath)) {
        const reply = (await readFile(replyPath, "utf8")).trim();
        if (reply) {
          await Promise.all([
            rm(requestPath, { force: true }),
            rm(replyPath, { force: true }),
          ]).catch(() => undefined);
          return reply;
        }
      }
      await sleep(500);
    }

    await Promise.all([
      rm(requestPath, { force: true }),
      rm(replyPath, { force: true }),
    ]).catch(() => undefined);
    throw new Error(`maw-hey reply timed out request_id=${requestId}`);
  }

  private async askViaClaudeP(prompt: string): Promise<string> {
    const timeoutMs =
      this.options.timeoutMs ??
      (Number(process.env.CLAUDE_REPLY_TIMEOUT_MS) || 90_000);
    const command = this.options.command ?? process.env.CLAUDE_CMD ?? "claude";
    const firstCall = this.isFirstCall;
    const args = this.options.args
      ? normalizeClaudePrintArgs(this.options.args, this.sessionId, firstCall)
      : claudePrintArgs(this.sessionId, firstCall);
    const cwd = this.cwd();

    console.log(
      `[claude-bridge] claude -p request mode=${firstCall ? "session-id" : "continue"} label=${this.label} session_id=${this.sessionId} cwd=${cwd}`,
    );
    console.log(`[claude-bridge] args: ${[command, ...args].join(" ")}`);

    const proc = Bun.spawn([command, ...args], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      cwd,
      env: {
        ...process.env,
        VOICE_BOT_CLAUDE_SESSION_ID: this.sessionId,
        VOICE_BOT_CLAUDE_SESSION_LABEL: this.label,
      },
    });

    const stdout = new Response(proc.stdout).text();
    const stderr = new Response(proc.stderr).text();
    proc.stdin.write(prompt);
    proc.stdin.end();

    const timedOut = Symbol("timeout");
    const timeout = new Promise<typeof timedOut>((resolve) => {
      setTimeout(() => resolve(timedOut), timeoutMs);
    });

    const exitCode = await Promise.race([proc.exited, timeout]);
    if (exitCode === timedOut) {
      try {
        proc.kill();
      } catch {
        // already exited
      }
      throw new Error("[claude-bridge] Claude reply timed out");
    }

    const [reply, errorText] = await Promise.all([stdout, stderr]);
    if (exitCode !== 0) {
      throw new Error(
        `[claude-bridge] ${command} exited ${exitCode}: ${errorText.trim() || "no stderr"}`,
      );
    }

    const text = reply.trim();
    if (!text) throw new Error("[claude-bridge] empty Claude reply");
    this.isFirstCall = false;
    return text;
  }
}

function withToolInstructions(message: string, tools: ClaudeTool[]): string {
  if (tools.length === 0) return message;
  const manifest = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
  return (
    `${message}\n\n` +
    "Available Discord tools are registered for this session. " +
    "To call one, reply with exactly one line in this format:\n" +
    `TOOL_CALL {"name":"discord.reply","arguments":{"channelId":"...","text":"..."}}\n\n` +
    `Tools:\n${JSON.stringify(manifest, null, 2)}`
  );
}

function extractToolCall(reply: string): ToolCall | null {
  const line = reply
    .split("\n")
    .map((item) => item.trim())
    .find((item) => item.startsWith("TOOL_CALL "));
  if (line) return parseToolJson(line.slice("TOOL_CALL ".length));

  const fenced = reply.match(/```json\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    const parsed = parseToolJson(fenced[1]);
    if (parsed) return parsed;
  }

  return parseToolJson(reply);
}

function parseToolJson(raw: string): ToolCall | null {
  try {
    const value = JSON.parse(raw) as Partial<ToolCall>;
    if (typeof value.name !== "string") return null;
    return {
      name: value.name,
      arguments:
        value.arguments && typeof value.arguments === "object"
          ? value.arguments
          : {},
    };
  } catch {
    return null;
  }
}

export function createClaudeBridge(
  options: ClaudeBridgeOptions = {},
): ClaudeBridge {
  const session = new PersistentClaudeSession(options);
  return {
    ask(message: string): Promise<string> {
      return session.ask(message);
    },
    useSession(sessionId: string, label?: string): Promise<void> {
      return session.useSession(sessionId, label);
    },
    async close(): Promise<void> {
      await session.close();
    },
  };
}
