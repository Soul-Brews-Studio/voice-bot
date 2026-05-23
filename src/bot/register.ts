export interface BotRegistration {
  botName: string;
  guildIds: string[];
  status: "online" | "offline";
  currentChannel?: string;
  followTarget?: string;
}

export interface BotRegistryClient {
  register(registration: BotRegistration): Promise<void>;
  deregister(botName: string): Promise<void>;
  heartbeat(registration: BotRegistration): Promise<void>;
}

export function createRegistryClient(
  serverUrl = process.env.MAW_DISCORD_SERVER_URL ?? "http://127.0.0.1:3737",
): BotRegistryClient {
  async function post(path: string, body: unknown): Promise<void> {
    const res = await fetch(new URL(path, serverUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`[bot-register] ${path} HTTP ${res.status}: ${text}`);
    }
  }

  return {
    register: (registration) => post("/register", registration),
    deregister: (botName) => post("/deregister", { botName }),
    heartbeat: (registration) => post("/heartbeat", registration),
  };
}
