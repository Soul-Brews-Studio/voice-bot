#!/usr/bin/env bun
import { ChannelType, type Client, type VoiceBasedChannel } from "discord.js";
import { createClaudeBridge, type ClaudeBridge } from "./claude-bridge.ts";
import {
  createDiscordClient,
  installDiscordEventHandlers,
} from "./discord-client.ts";
import {
  deregister,
  heartbeat,
  register,
  startHeartbeat,
  stopHeartbeat,
  type ChannelRef,
  type FollowRef,
} from "./register.ts";
import { leaveVoiceSession } from "../tools/voice-leave.ts";
import { sayInVoice } from "../tools/voice-say.ts";
import { setSpeakMode } from "../voice/speak-state.ts";
import { VoiceSession } from "../voice/voice-session.ts";
import {
  setActiveVoice,
  type VoiceProfile,
} from "../voice-config.ts";

type BotCommandAction =
  | "join"
  | "leave"
  | "mute"
  | "unmute"
  | "say"
  | "think"
  | "follow"
  | "unfollow";

interface BotCommand {
  action: BotCommandAction;
  guildId?: string;
  channelId?: string;
  targetUserId?: string;
  text?: string;
  message?: string;
}

interface BotConfig {
  botName: string;
  token: string;
  voiceProfile?: VoiceProfile;
  serverUrl: string;
  heartbeatMs: number;
  commandPort: number;
}

interface BotRuntime {
  config: BotConfig;
  client: Client;
  bridge: ClaudeBridge;
  commandServer: ReturnType<typeof Bun.serve>;
  sessions: Map<string, VoiceSession>;
  followTarget: FollowRef | null;
  shuttingDown: boolean;
}

const DEFAULT_SERVER_URL = "http://localhost:7799";

function parseConfig(): BotConfig {
  const token = process.env.DISCORD_TOKEN;
  if (!token) throw new Error("DISCORD_TOKEN is required");

  const voiceProfile = process.env.VOICE_PROFILE as VoiceProfile | undefined;
  if (voiceProfile) {
    const resolved = setActiveVoice(voiceProfile);
    if (resolved.backend === "edge") {
      process.env.TTS_VOICE = resolved.voice;
    }
  }

  return {
    botName: process.env.BOT_NAME ?? process.env.VOICE_BOT_NAME ?? "codey",
    token,
    voiceProfile,
    serverUrl: process.env.MAW_DISCORD_SERVER_URL ?? DEFAULT_SERVER_URL,
    heartbeatMs: Number(process.env.HEARTBEAT_MS) || 30_000,
    commandPort: Number(process.env.BOT_COMMAND_PORT) || 0,
  };
}

export async function startBotProcess(
  config: BotConfig = parseConfig(),
): Promise<BotRuntime> {
  const sessions = new Map<string, VoiceSession>();
  const bridge = createClaudeBridge();
  const client = createDiscordClient();
  const runtime: BotRuntime = {
    config,
    client,
    bridge,
    commandServer: undefined as never,
    sessions,
    followTarget: null,
    shuttingDown: false,
  };

  runtime.commandServer = startCommandServer(runtime);
  const commandUrl = runtime.commandServer.url.toString().replace(/\/$/, "");

  installDiscordEventHandlers(client, {
    bridge,
    onReady: async (readyClient) => {
      const guildIds = readyClient.guilds.cache.map((guild) => guild.id);
      await register(config.serverUrl, config.botName, guildIds, commandUrl).catch((error) => {
        console.warn(`[bot] register failed: ${error.message}`);
      });
      startHeartbeat(config.serverUrl, config.botName, config.heartbeatMs, () => ({
        guildIds,
        commandUrl,
        currentChannel: getCurrentChannel(runtime),
        followTarget: runtime.followTarget,
      }));
      await heartbeat(config.serverUrl, {
        botName: config.botName,
        guildIds,
        commandUrl,
        currentChannel: getCurrentChannel(runtime),
        followTarget: runtime.followTarget,
      }).catch((error) => {
        console.warn(`[bot] initial heartbeat failed: ${error.message}`);
      });
      console.log(
        `[bot] ${config.botName} ready as ${readyClient.user.tag}; commandUrl=${commandUrl}`,
      );
    },
  });

  installShutdownHandlers(runtime);
  await client.login(config.token);
  return runtime;
}

function startCommandServer(runtime: BotRuntime): ReturnType<typeof Bun.serve> {
  const server = Bun.serve({
    port: runtime.config.commandPort,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/health") {
        return json({ ok: true, botName: runtime.config.botName });
      }
      if (req.method !== "POST" || url.pathname !== "/command") {
        return json({ ok: false, error: "not found" }, 404);
      }

      try {
        const command = (await req.json()) as BotCommand;
        const result = await dispatchCommand(runtime, command);
        return json({ ok: true, result });
      } catch (error: any) {
        return json({ ok: false, error: error?.message ?? String(error) }, 500);
      }
    },
  });
  console.log(`[bot] command server listening on ${server.url}`);
  return server;
}

async function dispatchCommand(
  runtime: BotRuntime,
  command: BotCommand,
): Promise<unknown> {
  switch (command.action) {
    case "join":
      return joinVoice(runtime, command);
    case "leave":
      return leaveVoice(runtime, command.guildId);
    case "mute":
      return setMute(runtime, command.guildId, true);
    case "unmute":
      return setMute(runtime, command.guildId, false);
    case "say":
      if (!command.text) throw new Error("say requires text");
      return speak(runtime, command.guildId, command.text);
    case "think":
      return think(runtime, command);
    case "follow":
      if (!command.guildId || !command.targetUserId) {
        throw new Error("follow requires guildId and targetUserId");
      }
      runtime.followTarget = {
        guildId: command.guildId,
        targetUserId: command.targetUserId,
      };
      return { followTarget: runtime.followTarget };
    case "unfollow":
      runtime.followTarget = null;
      return { followTarget: null };
    default:
      throw new Error(`unsupported command: ${(command as BotCommand).action}`);
  }
}

async function joinVoice(runtime: BotRuntime, command: BotCommand): Promise<ChannelRef> {
  if (!command.channelId) throw new Error("join requires channelId");
  const channel = await runtime.client.channels.fetch(command.channelId);
  if (!channel || !isVoiceChannel(channel)) {
    throw new Error(`channel ${command.channelId} is not a voice channel`);
  }

  const guildId = command.guildId ?? channel.guild.id;
  let session = runtime.sessions.get(guildId);
  if (session && session.state !== "idle") {
    await session.leave({ saveTranscript: false });
  }

  session = new VoiceSession();
  runtime.sessions.set(guildId, session);
  await session.connect({
    channelId: channel.id,
    guildId,
    channelName: channel.name,
    adapterCreator: channel.guild.voiceAdapterCreator,
    guild: channel.guild,
  });

  return { id: channel.id, name: channel.name, guildId };
}

async function leaveVoice(
  runtime: BotRuntime,
  guildId?: string,
): Promise<{ transcriptPath: string | null }> {
  const session = resolveSession(runtime, guildId);
  if (!session) return { transcriptPath: null };
  const transcriptPath = await leaveVoiceSession(session);
  return { transcriptPath };
}

function setMute(
  runtime: BotRuntime,
  guildId: string | undefined,
  mute: boolean,
): { muted: boolean } {
  const session = resolveSession(runtime, guildId);
  if (!session?.guildId || !session.channelId) {
    throw new Error("no active voice session");
  }
  setSpeakMode(session.guildId, !mute);
  session.connection?.rejoin({
    channelId: session.channelId,
    selfDeaf: false,
    selfMute: mute,
  });
  return { muted: mute };
}

async function speak(
  runtime: BotRuntime,
  guildId: string | undefined,
  text: string,
): Promise<{ spoken: true }> {
  const session = resolveSession(runtime, guildId);
  if (!session) throw new Error("no active voice session");
  await sayInVoice(session, text);
  return { spoken: true };
}

async function think(
  runtime: BotRuntime,
  command: BotCommand,
): Promise<{ reply: string }> {
  const message = command.message ?? command.text;
  if (!message) throw new Error("think requires message");
  const reply = await runtime.bridge.ask(message);

  const session = resolveSession(runtime, command.guildId);
  if (session?.connection) {
    await sayInVoice(session, reply);
  }

  return { reply };
}

function resolveSession(
  runtime: BotRuntime,
  guildId?: string,
): VoiceSession | undefined {
  if (guildId) return runtime.sessions.get(guildId);
  return Array.from(runtime.sessions.values()).find((session) => session.state !== "idle");
}

function getCurrentChannel(runtime: BotRuntime): ChannelRef | null {
  const active = Array.from(runtime.sessions.values()).find(
    (session) => session.state !== "idle" && session.channelId,
  );
  if (!active?.channelId) return null;
  return {
    id: active.channelId,
    name: active.channelName,
    guildId: active.guildId,
  };
}

function isVoiceChannel(channel: unknown): channel is VoiceBasedChannel {
  return Boolean(
    channel &&
      typeof channel === "object" &&
      "type" in channel &&
      ((channel as { type: ChannelType }).type === ChannelType.GuildVoice ||
        (channel as { type: ChannelType }).type === ChannelType.GuildStageVoice),
  );
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function shutdown(runtime: BotRuntime): Promise<void> {
  if (runtime.shuttingDown) return;
  runtime.shuttingDown = true;
  stopHeartbeat();

  await deregister(runtime.config.serverUrl, runtime.config.botName).catch((error) => {
    console.warn(`[bot] deregister failed: ${error.message}`);
  });

  await Promise.all(
    Array.from(runtime.sessions.values()).map((session) =>
      session.leave().catch((error) => {
        console.warn(`[bot] voice leave failed: ${error.message}`);
      }),
    ),
  );

  await runtime.bridge.close();
  runtime.client.destroy();
  runtime.commandServer.stop(true);
}

function installShutdownHandlers(runtime: BotRuntime): void {
  const handle = (signal: NodeJS.Signals) => {
    console.log(`[bot] received ${signal}, shutting down`);
    shutdown(runtime)
      .catch((error) => console.warn(`[bot] shutdown failed: ${error.message}`))
      .finally(() => process.exit(0));
  };
  process.once("SIGINT", handle);
  process.once("SIGTERM", handle);
}

if (import.meta.main) {
  startBotProcess().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
