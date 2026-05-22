/**
 * Auto-shutdown after voice-channel leave.
 *
 * Voice-bot is spawned on demand by the poller when /join arrives. Once the
 * user runs /yl (or any leave path fires — Discord slash, alone-timeout,
 * silence-timeout, stay-expired), we want the process to exit so it isn't
 * idling in the background.
 *
 * Sequence on arm:
 *   1. Wait for any pending VPS-archive POST (up to ARCHIVE_WAIT_MS).
 *   2. Sleep GRACE_MS so the poller's voice-result-watcher can pick up the
 *      result JSON we just wrote.
 *   3. Send SIGTERM to self — index.ts's existing handler does the actual
 *      graceful tear-down (whisper-server, ui-server, discord client, PID
 *      file cleanup).
 *
 * Idempotent: armAutoShutdown() is a no-op on second call.
 */
const ARCHIVE_WAIT_MS = 30_000;
const GRACE_MS = 2_000;

let pendingArchive: Promise<unknown> | null = null;
let armed = false;

export function trackPendingArchive(p: Promise<unknown>): void {
  pendingArchive = p.catch((e) => {
    console.warn(`[auto-shutdown] tracked archive rejected: ${e?.message ?? e}`);
  });
}

export function armAutoShutdown(reason: string): void {
  if (armed) {
    console.log(`[auto-shutdown] already armed — ignoring "${reason}"`);
    return;
  }
  armed = true;
  console.log(`[auto-shutdown] armed — ${reason}`);
  void runShutdown();
}

async function runShutdown(): Promise<void> {
  if (pendingArchive) {
    console.log(
      `[auto-shutdown] awaiting pending archive (timeout ${ARCHIVE_WAIT_MS}ms)...`,
    );
    try {
      await Promise.race([
        pendingArchive,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error(`archive wait timeout after ${ARCHIVE_WAIT_MS}ms`)),
            ARCHIVE_WAIT_MS,
          ),
        ),
      ]);
      console.log("[auto-shutdown] archive done");
    } catch (e: any) {
      console.warn(`[auto-shutdown] archive wait: ${e?.message ?? e}`);
    }
  }
  console.log(`[auto-shutdown] grace ${GRACE_MS}ms (poller delivery)...`);
  await new Promise((r) => setTimeout(r, GRACE_MS));
  console.log("[auto-shutdown] sending SIGTERM to self");
  try {
    process.kill(process.pid, "SIGTERM");
  } catch (e: any) {
    console.warn(`[auto-shutdown] self-SIGTERM failed: ${e?.message ?? e}`);
    process.exit(0);
  }
}
