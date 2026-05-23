const DISCORD_MESSAGE_LIMIT = 2_000;

export function splitMessage(
  text: string,
  maxLength = DISCORD_MESSAGE_LIMIT,
): string[] {
  if (maxLength <= 0) throw new Error("maxLength must be positive");

  const chunks: string[] = [];
  let current = "";

  for (const line of text.split("\n")) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length <= maxLength) {
      current = candidate;
      continue;
    }

    if (current) {
      chunks.push(current);
      current = "";
    }

    for (const wordChunk of splitLine(line, maxLength)) {
      if (wordChunk.length <= maxLength && !current) {
        current = wordChunk;
      } else if (`${current} ${wordChunk}`.trim().length <= maxLength) {
        current = `${current} ${wordChunk}`.trim();
      } else {
        if (current) chunks.push(current);
        current = wordChunk;
      }
    }
  }

  if (current) chunks.push(current);
  return chunks.filter((chunk) => chunk.length > 0);
}

function splitLine(line: string, maxLength: number): string[] {
  const chunks: string[] = [];
  let current = "";

  for (const word of line.split(/\s+/).filter(Boolean)) {
    if (word.length > maxLength) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      chunks.push(word.slice(0, maxLength));
      let rest = word.slice(maxLength);
      while (rest.length > maxLength) {
        chunks.push(rest.slice(0, maxLength));
        rest = rest.slice(maxLength);
      }
      current = rest;
      continue;
    }

    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxLength) {
      current = candidate;
    } else {
      if (current) chunks.push(current);
      current = word;
    }
  }

  if (current || line === "") chunks.push(current);
  return chunks;
}

export const chunkDiscordMessage = splitMessage;
