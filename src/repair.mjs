import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeSessionId } from "./ledger.mjs";
import { readBeat } from "./heartbeat.mjs";
import { salvageStalledRun } from "./salvage.mjs";

export const STALE_MINUTES = 60;
export const MAX_CLOSES_PER_SESSION = 4;

export function openRows(file) {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const opens = [];
  const closed = new Set();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.kind === "open") opens.push(record);
    else if (record.id) closed.add(record.id);
  }
  return opens.filter((row) => !closed.has(row.id));
}

export function endForOpen({ row, beat, now, staleMinutes = STALE_MINUTES }) {
  const startedAt = Date.parse(row?.startedAt ?? "");
  if (!Number.isFinite(startedAt)) return null;
  const beatAt = Date.parse(beat?.at ?? "");
  if (Number.isFinite(beatAt) && beatAt >= startedAt) return Math.min(beatAt, now);
  if (now - startedAt < staleMinutes * 60_000) return null;
  return startedAt;
}

export function repairLedger({ dir, now = Date.now(), staleMinutes = STALE_MINUTES, fsImpl = null } = {}) {
  const ledgerDir = join(dir, "ledger");
  let names;
  try {
    names = readdirSync(ledgerDir).filter((name) => name.endsWith(".jsonl")).sort();
  } catch {
    return { closed: [], sessions: 0 };
  }
  const closed = [];
  for (const name of names) {
    const sessionId = normalizeSessionId(name.replace(/\.jsonl$/, ""));
    for (let round = 0; round < MAX_CLOSES_PER_SESSION; round += 1) {
      const opens = openRows(join(ledgerDir, name));
      if (!opens.length) break;
      const row = opens[opens.length - 1];
      const beat = readBeat(sessionId, { root: dir });
      const endedAtMs = endForOpen({ row, beat, now, staleMinutes });
      if (endedAtMs === null) break;
      const record = salvageStalledRun({
        sessionId,
        endedAtMs,
        userText: beat?.userText ?? "",
        output: beat?.output ?? "",
        dir: ledgerDir,
        ...(fsImpl ? { fsImpl } : {}),
      });
      if (!record) break;
      closed.push({ sessionId, id: record.id, durationMs: record.durationMs, endedAt: new Date(endedAtMs).toISOString() });
    }
  }
  return { closed, sessions: names.length };
}
