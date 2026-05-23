export interface ChannelRef {
  id: string;
  name?: string;
  guildId?: string;
}

export interface FollowRef {
  targetUserId: string;
  guildId: string;
}

export interface RegistrationPayload {
  botName: string;
  guildIds: string[];
  commandUrl: string;
  currentChannel?: ChannelRef | null;
  followTarget?: FollowRef | null;
}

export interface HeartbeatPayload {
  botName: string;
  guildIds?: string[];
  currentChannel?: ChannelRef | null;
  followTarget?: FollowRef | null;
  commandUrl?: string;
}

export type HeartbeatSnapshot = () => Omit<HeartbeatPayload, "botName">;

let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

async function postJson(
  serverUrl: string,
  path: string,
  body: unknown,
): Promise<void> {
  const res = await fetch(new URL(path, serverUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${path} HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
}

export async function register(
  serverUrl: string,
  botName: string,
  guildIds: string[],
  commandUrl: string,
): Promise<void> {
  await postJson(serverUrl, "/register", { botName, guildIds, commandUrl });
}

export async function deregister(
  serverUrl: string,
  botName: string,
): Promise<void> {
  await postJson(serverUrl, "/deregister", { botName });
}

export async function heartbeat(
  serverUrl: string,
  payload: HeartbeatPayload,
): Promise<void> {
  await postJson(serverUrl, "/heartbeat", payload);
}

export function startHeartbeat(
  serverUrl: string,
  botName: string,
  intervalMs: number,
  snapshot: HeartbeatSnapshot = () => ({}),
): ReturnType<typeof setInterval> {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    heartbeat(serverUrl, { botName, ...snapshot() }).catch((error) => {
      console.warn(`[bot-register] heartbeat failed: ${error.message}`);
    });
  }, intervalMs);
  heartbeatTimer.unref?.();
  return heartbeatTimer;
}

export function stopHeartbeat(): void {
  if (!heartbeatTimer) return;
  clearInterval(heartbeatTimer);
  heartbeatTimer = undefined;
}
