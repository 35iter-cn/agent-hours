import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const SCHEMA_VERSION = 1;
export const USER_TEXT_LIMIT = 600;
export const OUTPUT_LIMIT = 400;
export const MAX_LINE_BYTES = 3800;
export const STALE_RUN_MS = 4 * 60 * 60 * 1000;

export function truncate(value, limit) {
  const text = typeof value === "string" ? value : "";
  return text.length > limit ? text.slice(0, limit) : text;
}

export function normalizeSessionId(value) {
  const safe = String(value ?? "").replace(/[^A-Za-z0-9_.-]/g, "_");
  return safe || "unknown";
}

export function detectSource({ env = {} } = {}) {
  if (env.AGENT_LEDGER_SOURCE) return String(env.AGENT_LEDGER_SOURCE);
  if (env.RELAY_PLATFORM) return "relay";
  return "interactive";
}

export function assistantText(message) {
  if (!message || message.role !== "assistant") return "";
  const content = message.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const part of content) {
    if (part && part.type === "text" && typeof part.text === "string") parts.push(part.text);
  }
  return parts.join("").trim();
}

export function buildRecord({
  sessionId,
  sessionFile,
  source,
  startedAtMs,
  endedAtMs,
  texts = [],
  output = "",
  aborted = false,
}) {
  const normalized = normalizeSessionId(sessionId);
  return {
    v: SCHEMA_VERSION,
    id: `${normalized}:${new Date(startedAtMs).toISOString()}`,
    sessionId: normalized,
    sessionFile: String(sessionFile ?? ""),
    source,
    startedAt: new Date(startedAtMs).toISOString(),
    durationMs: Math.max(0, endedAtMs - startedAtMs),
    userText: truncate(texts.join("\n---\n"), USER_TEXT_LIMIT),
    output: truncate(output, OUTPUT_LIMIT),
    aborted: Boolean(aborted),
  };
}

export function buildOpenRecord({ sessionId, sessionFile, source, startedAtMs }) {
  const normalized = normalizeSessionId(sessionId);
  return {
    v: SCHEMA_VERSION,
    kind: "open",
    id: `${normalized}:${new Date(startedAtMs).toISOString()}`,
    sessionId: normalized,
    sessionFile: String(sessionFile ?? ""),
    source,
    startedAt: new Date(startedAtMs).toISOString(),
  };
}

export function createRunTracker({ now = () => Date.now(), env = () => process.env } = {}) {
  let active = null;

  function ensure() {
    if (!active) active = { startedAtMs: null, texts: [], output: "" };
    return active;
  }

  return {
    begin(text) {
      const piece = truncate(text, USER_TEXT_LIMIT).trim();
      const current = ensure();
      if (current.startedAtMs !== null && now() - current.startedAtMs > STALE_RUN_MS) {
        active = { startedAtMs: null, texts: [], output: "" };
        if (piece) active.texts = [piece];
        return;
      }
      if (current.startedAtMs === null) {
        current.texts = piece ? [piece] : [];
        return;
      }
      if (piece) current.texts.push(piece);
    },

    start() {
      const current = ensure();
      if (current.startedAtMs !== null) return null;
      current.startedAtMs = now();
      return { startedAtMs: current.startedAtMs };
    },

    takeOutput(message) {
      if (!active) return;
      const text = assistantText(message);
      if (text) active.output = truncate(text, OUTPUT_LIMIT);
    },

    drain({ sessionId, sessionFile, aborted = false, env: envOverride } = {}) {
      if (!active || active.startedAtMs === null) {
        active = null;
        return null;
      }
      const startedAtMs = active.startedAtMs;
      const record = buildRecord({
        sessionId,
        sessionFile,
        source: detectSource({ env: envOverride ?? env() }),
        startedAtMs,
        endedAtMs: now(),
        texts: active.texts,
        output: active.output,
        aborted,
      });
      active = null;
      return record;
    },

    isEmpty() {
      return !active || active.startedAtMs === null;
    },

    snapshot() {
      if (!active || active.startedAtMs === null) return null;
      return {
        startedAtMs: active.startedAtMs,
        userText: active.texts.join("\n---\n"),
        output: active.output,
      };
    },
  };
}

export function defaultLedgerDir(env = process.env) {
  const root = env.AGENT_HOURS_DIR || path.join(os.homedir(), ".config", "agent-hours");
  return path.join(root, "ledger");
}

export function ledgerFilePath(dir, sessionId) {
  return path.join(dir, `${normalizeSessionId(sessionId)}.jsonl`);
}

export function serializeRecord(record) {
  let candidate = { ...record };
  let line = `${JSON.stringify(candidate)}\n`;
  if (Buffer.byteLength(line) <= MAX_LINE_BYTES) return line;
  candidate.output = "";
  line = `${JSON.stringify(candidate)}\n`;
  if (Buffer.byteLength(line) <= MAX_LINE_BYTES) return line;
  candidate.userText = truncate(candidate.userText, 200);
  line = `${JSON.stringify(candidate)}\n`;
  if (Buffer.byteLength(line) <= MAX_LINE_BYTES) return line;
  candidate.userText = "";
  return `${JSON.stringify(candidate)}\n`;
}

export function appendLedger(record, { dir = defaultLedgerDir(), fsImpl = fs } = {}) {
  const file = ledgerFilePath(dir, record.sessionId);
  fsImpl.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fsImpl.writeFileSync(file, serializeRecord(record), { encoding: "utf8", mode: 0o600, flag: "a" });
  return file;
}

export function readRecords(dir = defaultLedgerDir(), { fsImpl = fs } = {}) {
  let names;
  try {
    names = fsImpl.readdirSync(dir);
  } catch {
    return [];
  }
  const records = [];
  for (const name of names.filter((entry) => entry.endsWith(".jsonl")).sort()) {
    const file = path.join(dir, name);
    let raw;
    try {
      raw = fsImpl.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        if (record?.kind === "open") continue;
        records.push(record);
      } catch {
        continue;
      }
    }
  }
  return records;
}

export function summarize(records, { tz = process.env.TZ || "Asia/Shanghai", days = 7 } = {}) {
  const byDay = new Map();
  for (const record of records) {
    if (!record || typeof record.startedAt !== "string") continue;
    const day = localDay(record.startedAt, tz);
    if (!day) continue;
    const entry = byDay.get(day) ?? { day, runs: 0, durationMs: 0, sources: new Map(), sessions: new Set() };
    entry.runs += 1;
    entry.durationMs += Number(record.durationMs) || 0;
    entry.sources.set(record.source ?? "unknown", (entry.sources.get(record.source ?? "unknown") ?? 0) + 1);
    entry.sessions.add(record.sessionId ?? "unknown");
    byDay.set(day, entry);
  }
  return [...byDay.values()]
    .sort((a, b) => b.day.localeCompare(a.day))
    .slice(0, days)
    .map((entry) => ({
      day: entry.day,
      runs: entry.runs,
      minutes: Math.round(entry.durationMs / 60_000),
      sessions: entry.sessions.size,
      sources: Object.fromEntries([...entry.sources.entries()].sort()),
    }));
}

function localDay(iso, tz) {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(ms));
  const pick = (type) => parts.find((part) => part.type === type)?.value ?? "";
  const year = pick("year");
  const month = pick("month");
  const day = pick("day");
  if (!year || !month || !day) return null;
  return `${year}-${month}-${day}`;
}
