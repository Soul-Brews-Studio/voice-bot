import mqtt, { type MqttClient } from "mqtt";
import type { TranscriptSegment } from "./transcript-writer.ts";

export interface SegmentPublishContext {
  channel?: string;
  guild?: string;
}

let client: MqttClient | null = null;
let connectStarted = false;

function topic(): string {
  return process.env.MQTT_TOPIC || "sbs/acc3";
}

export function connectMqttPublisher(): void {
  const url = process.env.MQTT_URL;
  if (!url || connectStarted) return;

  connectStarted = true;
  client = mqtt.connect(url, {
    username: process.env.MQTT_USER,
    password: process.env.MQTT_PASS,
  });

  client.on("connect", () => {
    console.log(`[mqtt] connected ${url} topic=${topic()}`);
  });
  client.on("error", (error) => {
    console.warn(`[mqtt] error: ${error.message}`);
  });
  client.on("close", () => {
    console.log("[mqtt] disconnected");
  });
}

export function publishSegment(
  segment: TranscriptSegment,
  context: SegmentPublishContext = {},
): Promise<void> {
  if (!client || !process.env.MQTT_URL) return Promise.resolve();

  const payload = {
    bot: process.env.BOT_NAME ?? process.env.VOICE_BOT_NAME ?? "codey",
    speaker: segment.speaker,
    text: segment.text,
    timestamp: new Date(segment.startedAt).toISOString(),
    channel: context.channel,
    guild: context.guild,
  };

  return new Promise((resolve, reject) => {
    client!.publish(topic(), JSON.stringify(payload), { qos: 0 }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export function disconnectMqttPublisher(): Promise<void> {
  if (!client) return Promise.resolve();
  const active = client;
  client = null;
  connectStarted = false;
  return new Promise((resolve) => {
    active.end(false, {}, () => resolve());
  });
}
