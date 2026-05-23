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

function parseArgs(raw: string | undefined): string[] {
  if (!raw?.trim()) return ["-p"];
  return raw.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((part) =>
    part.replace(/^["']|["']$/g, ""),
  ) ?? [];
}

export async function sendToClaude(
  message: string,
  options: ClaudeBridgeOptions = {},
): Promise<string> {
  const tools = options.tools ?? discordTools;
  const maxToolRounds = options.maxToolRounds ?? 2;
  let prompt = withToolInstructions(message, tools);
  for (let round = 0; round <= maxToolRounds; round++) {
    const reply = await runClaudePrompt(prompt, options);
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

async function runClaudePrompt(
  prompt: string,
  options: ClaudeBridgeOptions,
): Promise<string> {
  const command = options.command ?? process.env.CLAUDE_CMD ?? "claude";
  const args = options.args ?? parseArgs(process.env.CLAUDE_ARGS);
  const timeoutMs =
    options.timeoutMs ??
    (Number(process.env.CLAUDE_REPLY_TIMEOUT_MS) || 90_000);

  const proc = Bun.spawn([command, ...args], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd: options.cwd ?? process.cwd(),
    env: process.env,
  });

  const timeout = setTimeout(() => {
    try {
      proc.kill();
    } catch {
      // process already exited
    }
  }, timeoutMs);

  try {
    proc.stdin.write(prompt);
    proc.stdin.end();

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (exitCode !== 0) {
      throw new Error(
        `[claude-bridge] ${command} exited ${exitCode}: ${stderr.trim() || "no stderr"}`,
      );
    }

    const reply = stdout.trim();
    if (!reply) throw new Error("[claude-bridge] empty Claude reply");
    return reply;
  } finally {
    clearTimeout(timeout);
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
  return {
    ask(message: string): Promise<string> {
      return sendToClaude(message, options);
    },
    async close(): Promise<void> {
      // Subprocess mode is per request, so there is no persistent handle.
    },
  };
}
