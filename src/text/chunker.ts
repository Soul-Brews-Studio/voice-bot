const DISCORD_MESSAGE_LIMIT = 2_000;

export function chunkDiscordMessage(
  text: string,
  limit = DISCORD_MESSAGE_LIMIT,
): string[] {
  if (limit <= 0) throw new Error("chunk limit must be positive");
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > limit) {
    const splitAt = findSplitPoint(remaining, limit);
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

function findSplitPoint(text: string, limit: number): number {
  const newline = text.lastIndexOf("\n", limit);
  if (newline > limit * 0.5) return newline + 1;
  const space = text.lastIndexOf(" ", limit);
  if (space > limit * 0.5) return space + 1;
  return limit;
}
