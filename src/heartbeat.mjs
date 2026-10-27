import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeSessionId, truncate, USER_TEXT_LIMIT, OUTPUT_LIMIT } from "./ledger.mjs";

export const BEAT_INTERVAL_MS = 30_000;
export const STALL_MS = 10 * 60_000;

export function defaultAgentHoursDir(env = process.env) {
  return env.AGENT_HOURS_DIR || path.join(os.homedir(), ".config", "agent-hours");
}

export function heartbeatDir(root = defaultAgentHoursDir()) {
  return path.join(root, "heartbeat");
}

export function heartbeatFile(sessionId, root = defaultAgentHoursDir()) {
  return path.join(heartbeatDir(root), `${normalizeSessionId(sessionId)}.json`);
}

export function buildBeat({ sessionId, sessionFile, source, startedAtMs, userText = "", output = "" }, atMs) {
  return {
    v: 1,
    sessionId: normalizeSessionId(sessionId),
    sessionFile: String(sessionFile ?? ""),
    source,
    startedAt: new Date(startedAtMs).toISOString(),
    at: new Date(atMs).toISOString(),
    userText: truncate(userText, USER_TEXT_LIMIT),
    output: truncate(output, OUTPUT_LIMIT),
  };
}

export function writeBeat(beat, { root = defaultAgentHoursDir(), fsImpl = fs, now = Date.now } = {}) {
  const dir = heartbeatDir(root);
  fsImpl.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = heartbeatFile(beat.sessionId, root);
  const tmp = `${file}.tmp-${process.pid}`;
  fsImpl.writeFileSync(tmp, `${JSON.stringify(beat)}\n`, { encoding: "utf8", mode: 0o600 });
  fsImpl.renameSync(tmp, file);
  return file;
}

export function readBeat(sessionId, { root = defaultAgentHoursDir(), fsImpl = fs } = {}) {
  try {
    const parsed = JSON.parse(fsImpl.readFileSync(heartbeatFile(sessionId, root), "utf8"));
    if (!parsed || typeof parsed.at !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearBeat(sessionId, { root = defaultAgentHoursDir(), fsImpl = fs } = {}) {
  try {
    fsImpl.rmSync(heartbeatFile(sessionId, root), { force: true });
    return true;
  } catch {
    return false;
  }
}

export function beatIsStale(beat, { now = Date.now(), stallMs = STALL_MS } = {}) {
  const at = Date.parse(beat?.at ?? "");
  if (Number.isNaN(at)) return true;
  return now - at >= stallMs;
}

export function trimToLastBeat(record, lastBeatAt) {
  const endedAt = Number(lastBeatAt);
  const startedAt = Date.parse(record?.startedAt ?? "");
  if (!Number.isFinite(endedAt) || !Number.isFinite(startedAt)) return record;
  return { ...record, durationMs: Math.max(0, endedAt - startedAt), stalled: true };
}

export function startHeartbeat({ sessionId, sessionFile, source, startedAtMs, snapshot, root, now = Date.now }) {
  let lastBeatAt = startedAtMs;
  const tick = () => {
    try {
      const state = snapshot();
      lastBeatAt = now();
      writeBeat(buildBeat({ sessionId, sessionFile, source, startedAtMs, userText: state.userText, output: state.output }, lastBeatAt), { root });
    } catch {}
  };
  tick();
  const timer = setInterval(tick, BEAT_INTERVAL_MS);
  timer.unref?.();
  return {
    stop() {
      clearInterval(timer);
      clearBeat(sessionId, { root });
    },
    lastBeatAt() {
      return lastBeatAt;
    },
  };
}
