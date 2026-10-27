import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendLedger, buildOpenRecord } from "../../src/ledger.mjs";
import { buildBeat, writeBeat } from "../../src/heartbeat.mjs";
import { repairLedger } from "../../src/repair.mjs";
import { readRecords } from "../../src/hours.mjs";

const MIN = 60_000;

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "repair-"));
  const ledgerDir = join(dir, "ledger");
  const startedAt = Date.now() - 90 * MIN;
  const open = buildOpenRecord({ sessionId: "crash-session", sessionFile: join(dir, "s.jsonl"), source: "relay", startedAtMs: startedAt });
  appendLedger(open, { dir: ledgerDir });
  return { dir, ledgerDir, open, startedAt };
}

test("a killed run is closed at its last heartbeat, not at the repair moment", () => {
  const { dir, startedAt } = fixture();
  try {
    const beatAt = startedAt + 35 * MIN;
    const beat = buildBeat({ sessionId: "crash-session", sessionFile: "", source: "relay", startedAtMs: startedAt, userText: "做事", output: "做完了" }, beatAt);
    writeBeat(beat, { root: dir });
    const result = repairLedger({ dir, now: Date.now() });
    assert.equal(result.closed.length, 1);
    assert.equal(result.closed[0].durationMs, 35 * MIN);
    const rows = readRecords(join(dir, "ledger"), { now: Date.now() });
    const closed = rows.find((row) => !row.kind);
    assert.equal(closed.salvaged, true);
    assert.equal(closed.userText, "做事");
    assert.equal(closed.output, "做完了");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a run with no heartbeat is closed at zero instead of inventing hours, and a second pass is a no-op", () => {
  const { dir, startedAt } = fixture();
  try {
    const fresh = buildOpenRecord({ sessionId: "live-session", sessionFile: "", source: "relay", startedAtMs: Date.now() - 5 * MIN });
    appendLedger(fresh, { dir: join(dir, "ledger") });
    const first = repairLedger({ dir, now: Date.now() });
    assert.equal(first.closed.length, 1, "only the run past the stale window is closed");
    const second = repairLedger({ dir, now: Date.now() });
    assert.equal(second.closed.length, 0, "a second pass must not add another row");
    const rows = readRecords(join(dir, "ledger"), { now: Date.now() });
    assert.equal(rows.filter((row) => !row.kind).length, 1);
    assert.equal(second.closed.length + first.closed.length, 1);
    assert.ok(startedAt < Date.now());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
