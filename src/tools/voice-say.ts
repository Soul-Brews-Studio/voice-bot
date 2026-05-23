import { AudioPlayerStatus, createAudioPlayer, createAudioResource } from "@discordjs/voice";
import { deleteTtsFile, synthesizeTts } from "../tts/index.ts";
import { VoiceSession } from "../voice/voice-session.ts";
import type { VoiceProfile } from "../voice-config.ts";

export async function sayInVoice(
  session: VoiceSession,
  text: string,
  voiceProfile?: VoiceProfile,
): Promise<void> {
  const connection = session.connection;
  if (!connection) throw new Error("voice session is not connected");

  const ttsPath = await synthesizeTts(text, voiceProfile);
  const player = createAudioPlayer();
  connection.subscribe(player);

  await new Promise<void>((resolve, reject) => {
    player.once(AudioPlayerStatus.Idle, resolve);
    player.once("error", reject);
    player.play(createAudioResource(ttsPath));
  }).finally(() => deleteTtsFile(ttsPath));
}
