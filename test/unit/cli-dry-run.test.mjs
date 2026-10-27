import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appendLedger, buildOpenRecord } from "../../src/ledger.mjs";
import { buildBeat, writeBeat } from "../../src/heartbeat.mjs";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const BIN = join(ROOT, "bin/agent-hours.mjs");
const MIN = 60_000;

test("dry-run does not repair a row whose process may still be running", () => {
  const home = mkdtempSync(join(tmpdir(), "cli-dry-run-"));
  const dir = join(home, ".config/agent-hours");
  const ledgerDir = join(dir, "ledger");
  const file = join(ledgerDir, "live-session.jsonl");
  const startedAt = Date.now() - 30 * MIN;
  appendLedger(
    buildOpenRecord({ sessionId: "live-session", sessionFile: join(home, "s.jsonl"), source: "interactive", startedAtMs: startedAt }),
    { dir: ledgerDir },
  );
  writeBeat(
    buildBeat({ sessionId: "live-session", sessionFile: "", source: "interactive", startedAtMs: startedAt, userText: "做事", output: "" }, startedAt + MIN),
    { root: dir },
  );
  try {
    const run = spawnSync(process.execPath, [BIN, "--dry-run", "--no-notify"], { env: { ...process.env, HOME: home }, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /repair skipped by dry-run/);
    const rows = readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, "open");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
