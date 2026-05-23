import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export type AccessPolicy = "pairing" | "allowlist" | "disabled" | "open";

export interface ChannelAccess {
  enabled?: boolean;
  requiresMention?: boolean;
}

export interface AccessConfig {
  policy: AccessPolicy;
  users: string[];
  guilds: Record<
    string,
    {
      channels?: Record<string, ChannelAccess>;
    }
  >;
}

const DEFAULT_CONFIG: AccessConfig = {
  policy: "pairing",
  users: [],
  guilds: {},
};

function botName(): string {
  return process.env.BOT_NAME ?? process.env.VOICE_BOT_NAME ?? "codey";
}

export function accessPath(name = botName()): string {
  return join(homedir(), ".claude", "channels", name, "access.json");
}

export function loadAccessConfig(name = botName()): AccessConfig {
  const path = accessPath(name);
  if (!existsSync(path)) return structuredClone(DEFAULT_CONFIG);
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<AccessConfig>;
    return {
      policy: raw.policy ?? DEFAULT_CONFIG.policy,
      users: Array.isArray(raw.users) ? raw.users : [],
      guilds: raw.guilds && typeof raw.guilds === "object" ? raw.guilds : {},
    };
  } catch (error: any) {
    console.warn(`[access] failed to read ${path}: ${error?.message ?? error}`);
    return structuredClone(DEFAULT_CONFIG);
  }
}

export function saveAccessConfig(config: AccessConfig, name = botName()): void {
  const path = accessPath(name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}

export function ownerIds(): Set<string> {
  return new Set(
    (process.env.DC_OWNER_IDS ?? process.env.OWNER_IDS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

export function isOwner(userId: string): boolean {
  const owners = ownerIds();
  return owners.size > 0 && owners.has(userId);
}

export function isAllowed(userId: string): boolean {
  const config = loadAccessConfig();
  if (config.policy === "open") return true;
  if (config.policy === "disabled") return false;
  if (isOwner(userId)) return true;
  return config.users.includes(userId);
}

export function addUser(userId: string): void {
  const config = loadAccessConfig();
  if (!config.users.includes(userId)) {
    config.users.push(userId);
    saveAccessConfig(config);
  }
}

export function removeUser(userId: string): void {
  const config = loadAccessConfig();
  config.users = config.users.filter((id) => id !== userId);
  saveAccessConfig(config);
}

export function accessPolicy(): AccessPolicy {
  return loadAccessConfig().policy;
}
