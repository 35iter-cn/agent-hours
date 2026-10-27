import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendLedger, buildOpenRecord, ledgerFilePath } from "../../src/ledger.mjs";
import { findOpenRun, buildSalvagedRecord, salvageStalledRun } from "../../src/salvage.mjs";
import { buildBeat, writeBeat, readBeat, clearBeat, beatIsStale, heartbeatFile, trimToLastBeat } from "../../src/heartbeat.mjs";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-ledger-"));
}

function seedOpen(dir, { sessionId, startedAtMs, source = "relay" }) {
  const open = buildOpenRecord({ sessionId, sessionFile: `/tmp/${sessionId}.jsonl`, source, startedAtMs });
  appendLedger(open, { dir });
  return open;
}

test("findOpenRun returns the latest run without a closing record", () => {
  const dir = tempDir();
  const sessionId = "fs-th-demo";
  seedOpen(dir, { sessionId, startedAtMs: 1_000 });
  appendLedger(
    { v: 1, id: `fs-th-demo:${new Date(1_000).toISOString()}`, sessionId, startedAt: new Date(1_000).toISOString(), durationMs: 5, userText: "x" },
    { dir },
  );
  const second = seedOpen(dir, { sessionId, startedAtMs: 2_000 });
  assert.equal(findOpenRun({ dir, sessionId }).id, second.id);
});

test("findOpenRun returns null when the ledger file is missing", () => {
  assert.equal(findOpenRun({ dir: tempDir(), sessionId: "nope" }), null);
});

test("a salvaged record keeps the open run id and stops at the last beat", () => {
  const open = { id: "fs-th-demo:start", sessionId: "fs-th-demo", sessionFile: "/tmp/s.jsonl", source: "relay", startedAt: new Date(10 * 60_000).toISOString() };
  const record = buildSalvagedRecord({ open, endedAtMs: 20 * 60_000, userText: "做点事", output: "做到一半" });
  assert.equal(record.id, open.id);
  assert.equal(record.durationMs, 10 * 60_000);
  assert.equal(record.salvaged, true);
  assert.equal(record.aborted, false);
  assert.equal(record.userText, "做点事");
});

test("salvageStalledRun writes once and then reports no open run", () => {
  const dir = tempDir();
  const sessionId = "fs-th-demo";
  seedOpen(dir, { sessionId, startedAtMs: 1_000 });
  const first = salvageStalledRun({ sessionId, endedAtMs: 61_000, userText: "做事", dir });
  assert.equal(first.durationMs, 60_000);
  assert.equal(salvageStalledRun({ sessionId, endedAtMs: 91_000, userText: "做事", dir }), null);
  const lines = fs.readFileSync(ledgerFilePath(dir, sessionId), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines.filter((line) => line.kind === "open").length, 1);
  assert.equal(lines.filter((line) => !line.kind).length, 1);
});

test("a beat is written atomically, read back and cleared", () => {
  const root = tempDir();
  const beat = buildBeat({ sessionId: "fs-th-demo", sessionFile: "/tmp/s.jsonl", source: "relay", startedAtMs: 1_000, userText: "hi", output: "ok" }, 31_000);
  const file = writeBeat(beat, { root });
  assert.equal(file, heartbeatFile("fs-th-demo", root));
  assert.equal(readBeat("fs-th-demo", { root }).output, "ok");
  assert.equal(fs.readdirSync(path.dirname(file)).filter((name) => name.includes(".tmp-")).length, 0);
  clearBeat("fs-th-demo", { root });
  assert.equal(readBeat("fs-th-demo", { root }), null);
});

test("beat staleness uses the ten minute window", () => {
  const beat = { at: new Date(1_000_000).toISOString() };
  assert.equal(beatIsStale(beat, { now: 1_000_000 + 5 * 60_000 }), false);
  assert.equal(beatIsStale(beat, { now: 1_000_000 + 10 * 60_000 }), true);
  assert.equal(beatIsStale(null), true);
});

test("trimToLastBeat cuts the dead tail and leaves a countable record", () => {
  const record = { startedAt: new Date(10 * 60_000).toISOString(), durationMs: 70 * 60_000, aborted: true };
  const trimmed = trimToLastBeat(record, 20 * 60_000);
  assert.equal(trimmed.durationMs, 10 * 60_000);
  assert.equal(trimmed.stalled, true);
  assert.equal(trimmed.aborted, true);
  assert.equal(trimToLastBeat(record, Number.NaN), record);
});
