import fs from "node:fs";
import { appendLedger, ledgerFilePath, truncate, USER_TEXT_LIMIT, OUTPUT_LIMIT, defaultLedgerDir } from "./ledger.mjs";

export function findOpenRun({ dir = defaultLedgerDir(), sessionId, fsImpl = fs } = {}) {
  let raw;
  try {
    raw = fsImpl.readFileSync(ledgerFilePath(dir, sessionId), "utf8");
  } catch {
    return null;
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
  for (let i = opens.length - 1; i >= 0; i -= 1) {
    if (!closed.has(opens[i].id)) return opens[i];
  }
  return null;
}

export function buildSalvagedRecord({ open, endedAtMs, userText = "", output = "" }) {
  const startedAtMs = Date.parse(open.startedAt);
  return {
    v: 1,
    id: open.id,
    sessionId: open.sessionId,
    sessionFile: open.sessionFile,
    source: open.source,
    startedAt: open.startedAt,
    durationMs: Number.isFinite(startedAtMs) ? Math.max(0, endedAtMs - startedAtMs) : 0,
    userText: truncate(String(userText ?? ""), USER_TEXT_LIMIT),
    output: truncate(String(output ?? ""), OUTPUT_LIMIT),
    aborted: false,
    salvaged: true,
  };
}

export function salvageStalledRun({ sessionId, endedAtMs, userText = "", output = "", dir = defaultLedgerDir(), fsImpl = fs } = {}) {
  const open = findOpenRun({ dir, sessionId, fsImpl });
  if (!open) return null;
  const record = buildSalvagedRecord({ open, endedAtMs, userText, output });
  appendLedger(record, { dir, fsImpl });
  return record;
}
