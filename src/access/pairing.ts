import { addUser, isOwner } from "./allowlist.ts";

interface PendingPair {
  userId: string;
  requestedAt: number;
}

const PAIR_TTL_MS = 10 * 60 * 1000;
const CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export const pendingPairs = new Map<string, PendingPair>();

export function generatePairCode(): string {
  let code = "";
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  for (const byte of bytes) {
    code += CHARS[byte % CHARS.length];
  }
  return code;
}

export function requestPair(userId: string): string {
  expirePendingPairs();
  let code = generatePairCode();
  while (pendingPairs.has(code)) code = generatePairCode();
  pendingPairs.set(code, { userId, requestedAt: Date.now() });
  return code;
}

export function confirmPair(code: string, ownerId: string): boolean {
  expirePendingPairs();
  if (!isOwner(ownerId)) return false;
  const normalized = code.trim().toUpperCase();
  const pending = pendingPairs.get(normalized);
  if (!pending) return false;
  addUser(pending.userId);
  pendingPairs.delete(normalized);
  return true;
}

export function expirePendingPairs(now = Date.now()): void {
  for (const [code, pending] of pendingPairs) {
    if (now - pending.requestedAt > PAIR_TTL_MS) {
      pendingPairs.delete(code);
    }
  }
}
