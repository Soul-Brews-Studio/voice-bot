export interface ClaudeBridge {
  ask(message: string): Promise<string>;
  close(): Promise<void>;
}

export function createClaudeBridge(): ClaudeBridge {
  return {
    async ask(message: string): Promise<string> {
      throw new Error(
        `Claude bridge is not implemented yet; received ${message.length} chars`,
      );
    },
    async close(): Promise<void> {
      // no-op until Phase 2 wires the Claude Code session.
    },
  };
}
