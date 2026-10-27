import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendLedger, buildOpenRecord, createRunTracker, defaultLedgerDir, detectSource } from "./ledger.mjs";
import { STALL_MS, startHeartbeat, trimToLastBeat } from "./heartbeat.mjs";

export default function (pi: ExtensionAPI) {
  const tracker = createRunTracker();
  const ledgerDir = defaultLedgerDir();
  let heartbeat: ReturnType<typeof startHeartbeat> | null = null;

  const flush = (ctx: any, aborted: boolean) => {
    try {
      const record = tracker.drain({
        sessionId: ctx.sessionManager.getSessionId(),
        sessionFile: ctx.sessionManager.getSessionFile(),
        aborted,
      });
      const lastBeatAt = heartbeat?.lastBeatAt() ?? null;
      const trimmed = lastBeatAt && Date.now() - lastBeatAt >= STALL_MS ? trimToLastBeat(record, lastBeatAt) : record;
      if (trimmed) appendLedger(trimmed, { dir: ledgerDir });
    } catch (error) {
      process.stderr.write(`[agent-ledger] ${(error as Error)?.message ?? error}\n`);
    }
    heartbeat?.stop();
    heartbeat = null;
  };

  pi.on("input", (event) => {
    try {
      tracker.begin(event.text);
    } catch {
      return;
    }
  });

  pi.on("agent_start", (_event, ctx) => {
    try {
      const track = tracker.start();
      if (!track) return;
      const sessionId = ctx.sessionManager.getSessionId();
      const sessionFile = ctx.sessionManager.getSessionFile();
      const source = detectSource({ env: process.env });
      appendLedger(buildOpenRecord({ sessionId, sessionFile, source, startedAtMs: track.startedAtMs }), { dir: ledgerDir });
      heartbeat?.stop();
      heartbeat = startHeartbeat({
        sessionId,
        sessionFile,
        source,
        startedAtMs: track.startedAtMs,
        snapshot: () => tracker.snapshot() ?? { userText: "", output: "" },
      });
    } catch {
      return;
    }
  });

  pi.on("message_end", (event) => {
    try {
      tracker.takeOutput(event.message);
    } catch {
      return;
    }
  });

  pi.on("agent_settled", (event, ctx) => {
    flush(ctx, event.aborted);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (tracker.isEmpty()) {
      heartbeat?.stop();
      heartbeat = null;
      return;
    }
    flush(ctx, false);
  });
}
