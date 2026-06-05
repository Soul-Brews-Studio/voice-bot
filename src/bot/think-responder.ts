import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";

export interface ThinkRequest {
  requestId: string;
  prompt: string;
  timestamp?: string;
  sessionId?: string;
  sessionLabel?: string;
  firstCall?: boolean;
}

interface ThinkResponderState {
  seenSessionIds: Set<string>;
}

export interface ThinkResponderOptions {
  cwd?: string;
  botName?: string;
  timeoutMs?: number;
  command?: string;
  args?: string[];
  runner?: ThinkRunner;
  pollDelayMs?: number;
  log?: Pick<Console, "error" | "log" | "warn">;
  state?: ThinkResponderState;
}

export type ThinkRunner = (
  prompt: string,
  request: ThinkRequest,
  options: Required<Pick<ThinkResponderOptions, "cwd" | "timeoutMs">> &
    Pick<ThinkResponderOptions, "args" | "command">,
) => Promise<string>;

function envBotName(): string {
  return process.env.BOT_NAME ?? process.env.VOICE_BOT_NAME ?? "voice-bot";
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

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function normalizeClaudeArgs(args: string[], request: ThinkRequest): string[] {
  args = removeFlag(args, "-p");
  args = removeFlag(args, "--print");
  args = removeFlag(args, "--input-format", true);
  args = removeFlag(args, "--session-id", true);
  args = removeFlag(args, "--continue");
  if (!hasFlag(args, "--model")) {
    args = setFlag(args, "--model", process.env.CLAUDE_MODEL ?? "sonnet");
  }
  args = setFlag(args, "--output-format", "text");
  return ["-p", ...withSessionArgs(args, request)];
}

function defaultClaudeArgs(request: ThinkRequest): string[] {
  let args = ["-p", "--model", process.env.CLAUDE_MODEL ?? "sonnet", "--output-format", "text"];
  args = withSessionArgs(args, request);
  if (process.env.CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS === "1") {
    args = ensureFlag(args, "--dangerously-skip-permissions");
  }
  return args;
}

function withSessionArgs(args: string[], request: ThinkRequest): string[] {
  if (request.firstCall !== false && request.sessionId) {
    return setFlag(args, "--session-id", request.sessionId);
  }
  return ensureFlag(args, "--continue");
}

function channelRoot(cwd: string, botName: string): string {
  return join(cwd, ".claude", "channels", botName);
}

function requestDirs(cwd: string, botName: string): {
  requestDir: string;
  replyDir: string;
} {
  const root = channelRoot(cwd, botName);
  return {
    requestDir: join(root, "think-requests"),
    replyDir: join(root, "think-replies"),
  };
}

async function readRequest(path: string): Promise<ThinkRequest> {
  const raw = await readFile(path, "utf8");
  const value = JSON.parse(raw) as Partial<ThinkRequest>;
  if (typeof value.requestId !== "string" || !value.requestId) {
    throw new Error(`missing requestId in ${path}`);
  }
  if (typeof value.prompt !== "string" || !value.prompt.trim()) {
    throw new Error(`missing prompt in ${path}`);
  }
  return {
    requestId: value.requestId,
    prompt: value.prompt,
    timestamp: value.timestamp,
    sessionId: value.sessionId,
    sessionLabel: value.sessionLabel,
  };
}

function resolveRequestSession(
  request: ThinkRequest,
  state: ThinkResponderState,
): ThinkRequest {
  const sessionId = request.sessionId ?? process.env.VOICE_BOT_CLAUDE_SESSION_ID;
  const sessionLabel =
    request.sessionLabel ?? process.env.VOICE_BOT_CLAUDE_SESSION_LABEL;
  return {
    ...request,
    sessionId,
    sessionLabel,
    firstCall: sessionId ? !state.seenSessionIds.has(sessionId) : false,
  };
}

async function writeReplyAtomic(replyPath: string, text: string): Promise<void> {
  const reply = text.trim();
  if (!reply) throw new Error("[think-responder] empty Claude reply");
  const tmpPath = `${replyPath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmpPath, `${reply}\n`);
  await rename(tmpPath, replyPath);
}

async function defaultRunner(
  prompt: string,
  request: ThinkRequest,
  options: Required<Pick<ThinkResponderOptions, "cwd" | "timeoutMs">> &
    Pick<ThinkResponderOptions, "args" | "command">,
): Promise<string> {
  const command = options.command ?? process.env.CLAUDE_CMD ?? "claude";
  const args = options.args
    ? normalizeClaudeArgs(options.args, request)
    : defaultClaudeArgs(request);

  const proc = Bun.spawn([command, ...args], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd: options.cwd,
    env: {
      ...process.env,
      ...(request.sessionId
        ? { VOICE_BOT_CLAUDE_SESSION_ID: request.sessionId }
        : {}),
      ...(request.sessionLabel
        ? { VOICE_BOT_CLAUDE_SESSION_LABEL: request.sessionLabel }
        : {}),
    },
  });

  const stdout = new Response(proc.stdout).text();
  const stderr = new Response(proc.stderr).text();
  proc.stdin.write(prompt);
  proc.stdin.end();

  const timedOut = Symbol("timeout");
  const timeout = new Promise<typeof timedOut>((resolve) => {
    setTimeout(() => resolve(timedOut), options.timeoutMs);
  });

  const exitCode = await Promise.race([proc.exited, timeout]);
  if (exitCode === timedOut) {
    try {
      proc.kill();
    } catch {
      // already exited
    }
    throw new Error("[think-responder] Claude reply timed out");
  }

  const [reply, errorText] = await Promise.all([stdout, stderr]);
  if (exitCode !== 0) {
    throw new Error(
      `[think-responder] ${command} exited ${exitCode}: ${errorText.trim() || "no stderr"}`,
    );
  }
  return reply;
}

export async function processPendingThinkRequests(
  options: ThinkResponderOptions = {},
): Promise<number> {
  const cwd = options.cwd ?? process.env.ORACLE_REPO ?? process.cwd();
  const name = options.botName ?? envBotName();
  const timeoutMs =
    options.timeoutMs ?? (Number(process.env.CLAUDE_REPLY_TIMEOUT_MS) || 90_000);
  const runner = options.runner ?? defaultRunner;
  const log = options.log ?? console;
  const state = options.state ?? { seenSessionIds: new Set<string>() };
  const { requestDir, replyDir } = requestDirs(cwd, name);

  await mkdir(requestDir, { recursive: true });
  await mkdir(replyDir, { recursive: true });

  const entries = await readdir(requestDir);
  let processed = 0;
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".json")) continue;
    const requestPath = join(requestDir, entry);
    try {
      const request = resolveRequestSession(await readRequest(requestPath), state);
      const replyPath = join(replyDir, `${request.requestId}.txt`);
      if (existsSync(replyPath)) continue;
      const reply = await runner(request.prompt, request, {
        cwd,
        timeoutMs,
        command: options.command,
        args: options.args,
      });
      await writeReplyAtomic(replyPath, reply);
      if (request.sessionId) state.seenSessionIds.add(request.sessionId);
      processed++;
      log.log(`[think-responder] replied request_id=${request.requestId}`);
    } catch (error: any) {
      log.warn(`[think-responder] skipped ${requestPath}: ${error?.message ?? error}`);
    }
  }
  return processed;
}

export async function startThinkResponder(
  options: ThinkResponderOptions = {},
): Promise<{ close: () => void }> {
  const cwd = options.cwd ?? process.env.ORACLE_REPO ?? process.cwd();
  const name = options.botName ?? envBotName();
  const log = options.log ?? console;
  const pollDelayMs = options.pollDelayMs ?? 50;
  const state = options.state ?? { seenSessionIds: new Set<string>() };
  const { requestDir } = requestDirs(cwd, name);

  await mkdir(requestDir, { recursive: true });

  let closed = false;
  let scheduled: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> = Promise.resolve();
  const schedule = (): void => {
    if (closed || scheduled) return;
    scheduled = setTimeout(() => {
      scheduled = undefined;
      running = running
        .catch(() => undefined)
        .then(async () => {
          await processPendingThinkRequests({ ...options, cwd, botName: name, state });
        })
        .catch((error: any) => {
          log.error(`[think-responder] scan failed: ${error?.message ?? error}`);
        });
    }, pollDelayMs);
  };

  const watcher: FSWatcher = watch(requestDir, schedule);
  log.log(`[think-responder] watching ${requestDir}`);
  await processPendingThinkRequests({ ...options, cwd, botName: name, state });

  return {
    close(): void {
      closed = true;
      if (scheduled) clearTimeout(scheduled);
      watcher.close();
    },
  };
}

if (import.meta.main) {
  const responder = await startThinkResponder();
  const close = (): void => {
    responder.close();
    process.exit(0);
  };
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
}
