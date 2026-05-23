import { VoiceSession } from "../voice/voice-session.ts";

export async function leaveVoiceSession(
  session: VoiceSession,
): Promise<string | null> {
  return session.leave();
}
