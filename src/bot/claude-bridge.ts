import {
  callDiscordTool,
  discordTools,
  type ClaudeTool,
} from "../tools/index.ts";

export interface ClaudeBridge {
  ask(message: string): Promise<string>;
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

interface PendingRequest {
  resolve: (reply: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_CLAUDE_PERSISTENT_ARGS = [
  "--model",
  "sonnet",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
  "--dangerously-skip-permissions",
];

function parseArgs(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return raw.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((part) =>
    part.replace(/^["']|["']$/g, ""),
  ) ?? [];
}

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

function ensureFlag(args: string[], flag: string): string[] {
  return args.includes(flag) ? args : [...args, flag];
}

function sessionLabel(): string {
  const botName = process.env.BOT_NAME ?? process.env.VOICE_BOT_NAME ?? "voice-bot";
  const d = new Date();
  const stamp =
    `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}` +
    `-${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;
  return `${botName}-${stamp}`;
}

function persistentArgs(sessionId: string, label: string): string[] {
  const configured = process.env.CLAUDE_PERSISTENT_ARGS;
  let args = configured?.trim()
    ? parseArgs(configured)
    : [...DEFAULT_CLAUDE_PERSISTENT_ARGS];

  // Do not inherit CLAUDE_ARGS here. It is often "-p --model sonnet" for
  // one-shot calls and lacks the stream-json protocol needed for queued asks.
  args = removeFlag(args, "-p");
  args = removeFlag(args, "--print");
  args = setFlag(args, "--input-format", "stream-json");
  args = setFlag(args, "--output-format", "stream-json");
  args = ensureFlag(args, "--verbose");
  args = ensureFlag(args, "--dangerously-skip-permissions");
  args = setFlag(args, "--session-id", sessionId);
  args = setFlag(args, "--name", label);

  // Claude Code requires print mode for stream-json I/O, but with
  // --input-format=stream-json the process remains alive until stdin closes.
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
  private proc?: any;
  private pending?: PendingRequest;
  private queue: Promise<void> = Promise.resolve();
  private stderr = "";
  private closed = false;
  private readonly sessionId = crypto.randomUUID();
  private readonly label = sessionLabel();

  constructor(private readonly options: ClaudeBridgeOptions = {}) {}

  ask(message: string): Promise<string> {
    const run = this.queue
      .catch(() => undefined)
      .then(() => this.askWithTools(message));
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  async close(): Promise<void> {
    this.closed = true;
    const proc = this.proc;
    if (!proc) return;

    try {
      proc.stdin.end();
    } catch {
      // already closed
    }

    await Promise.race([
      proc.exited.catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);

    if (proc.exitCode === null) {
      try {
        proc.kill();
      } catch {
        // already exited
      }
    }
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

  private askOnce(prompt: string): Promise<string> {
    if (this.closed) throw new Error("[claude-bridge] session is closed");
    this.ensureStarted();
    if (!this.proc) throw new Error("[claude-bridge] Claude process did not start");
    if (this.pending) throw new Error("[claude-bridge] request already in flight");

    const timeoutMs =
      this.options.timeoutMs ??
      (Number(process.env.CLAUDE_REPLY_TIMEOUT_MS) || 90_000);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = undefined;
        try {
          this.proc?.kill();
        } catch {
          // already exited
        }
        reject(new Error("[claude-bridge] Claude reply timed out"));
      }, timeoutMs);

      this.pending = { resolve, reject, timer };
      const payload = {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "text", text: prompt }],
        },
      };
      try {
        this.proc!.stdin.write(`${JSON.stringify(payload)}\n`);
      } catch (error: any) {
        clearTimeout(timer);
        this.pending = undefined;
        reject(new Error(`[claude-bridge] stdin write failed: ${error?.message ?? error}`));
      }
    });
  }

  private ensureStarted(): void {
    if (this.proc) return;

    const command = this.options.command ?? process.env.CLAUDE_CMD ?? "claude";
    const args = this.options.args ?? persistentArgs(this.sessionId, this.label);
    const cwd = this.options.cwd ?? process.env.ORACLE_REPO ?? process.cwd();
    this.proc = Bun.spawn([command, ...args], {
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
    this.proc.unref?.();
    this.readStdout(this.proc.stdout);
    this.readStderr(this.proc.stderr);
    this.proc.exited.then((code: number) => {
      this.proc = undefined;
      const pending = this.pending;
      if (!pending) return;
      this.pending = undefined;
      clearTimeout(pending.timer);
      pending.reject(
        new Error(
          `[claude-bridge] ${command} exited ${code}: ${this.stderr.trim() || "no stderr"}`,
        ),
      );
    });
    console.log(
      `[claude-bridge] persistent Claude session started label=${this.label} session_id=${this.sessionId} cwd=${cwd}`,
    );
  }

  private async readStdout(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) this.handleOutputLine(line);
          newline = buffer.indexOf("\n");
        }
      }
      const rest = buffer.trim();
      if (rest) this.handleOutputLine(rest);
    } catch (error: any) {
      console.warn(`[claude-bridge] stdout read failed: ${error?.message ?? error}`);
    }
  }

  private async readStderr(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        this.stderr += decoder.decode(value, { stream: true });
      }
    } catch {
      // stderr reader is best-effort
    }
  }

  private handleOutputLine(line: string): void {
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      console.log(`[claude-bridge] ${line}`);
      return;
    }

    if (event.type === "system" && event.subtype === "init") {
      console.log(`[claude-bridge] session_id=${event.session_id}`);
      return;
    }

    if (event.type !== "result") return;

    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    clearTimeout(pending.timer);

    if (event.is_error) {
      pending.reject(new Error(`[claude-bridge] ${event.result ?? "Claude error"}`));
      return;
    }

    const reply = String(event.result ?? "").trim();
    if (!reply) {
      pending.reject(new Error("[claude-bridge] empty Claude reply"));
      return;
    }
    pending.resolve(reply);
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
    async close(): Promise<void> {
      await session.close();
    },
  };
}
