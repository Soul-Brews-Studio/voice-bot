export interface ClaudeBridge {
  ask(message: string): Promise<string>;
  close(): Promise<void>;
}

export interface ClaudeBridgeOptions {
  command?: string;
  args?: string[];
  timeoutMs?: number;
  cwd?: string;
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
    proc.stdin.write(message);
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
