import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { buildOpenRecord, buildRecord, appendLedger, defaultLedgerDir } from "../src/ledger.mjs";
import { createClockClient } from "../src/clock-client.mjs";
import { run } from "../src/hours.mjs";

const HOME = homedir();
const CFG = join(HOME, ".config/agent-hours");
const enabled = process.env.AGENT_HOURS_E2E === "1";

function envFile(file) {
  const out = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) out[match[1]] = match[2].trim();
  }
  return out;
}

function realConfig() {
  return JSON.parse(readFileSync(join(CFG, "config.json"), "utf8"));
}

test("integration: a ledger fixture is judged and written to clock, then removed", { skip: !enabled && "set AGENT_HOURS_E2E=1 to run against the real judge and clock api", timeout: 180_000 }, async () => {
  const cfgReal = realConfig();
  const clockEnv = envFile(join(CFG, "clock.env"));
  const api = createClockClient({ baseUrl: cfgReal.clock.baseUrl, apiKey: clockEnv.CLOCK_API_KEY ?? "" });
  const tz = cfgReal.timezone ?? "Asia/Shanghai";
  const dir = mkdtempSync(join(tmpdir(), "agent-hours-e2e-"));
  const ledgerDir = join(dir, "ledger");
  const now = Date.now();
  const windowFrom = now - 6 * 3_600_000;
  const windowTo = now + 3_600_000;
  const before = await api.list({ start: windowFrom, end: windowTo });
  assert.equal(before.ok, true, `clock list failed: ${before.code}`);
  const baseline = new Set((Array.isArray(before.data) ? before.data : before.data?.periods ?? []).map((row) => row.id));

  try {
    writeFileSync(join(dir, "config.json"), JSON.stringify({
      ...cfgReal,
      clock: { ...cfgReal.clock, enabled: true },
    }, null, 2));
    const sessionId = "e2e-fixture-session";
    const startedAt = now - 50 * 60_000;
    const endedAt = startedAt + 20 * 60_000;
    appendLedger(buildOpenRecord({ sessionId, sessionFile: join(dir, "session.jsonl"), source: "relay", startedAtMs: startedAt }), { dir: ledgerDir });
    appendLedger(buildRecord({
      sessionId,
      sessionFile: join(dir, "session.jsonl"),
      source: "relay",
      startedAtMs: startedAt,
      endedAtMs: endedAt,
      texts: ["修复 order 服务的 goroutine 泄漏，并跑通 go test ./..."],
      output: "泄漏修好了，go test 全绿",
    }), { dir: ledgerDir });

    const sent = [];
    const outcome = await run({
      dir,
      now,
      notify: true,
      notifyImpl: (text) => {
        sent.push(text);
        return { ok: true, chunks: 1, output: "" };
      },
      logDir: join(dir, "logs"),
    });

    assert.equal(outcome.units, 1, "exactly one unit should be built from the fixture");
    assert.equal(outcome.fresh.length, 1, "the fixture unit must be judged, not served from cache");
    assert.equal(outcome.delivered, true, "the report must be delivered through the injected reporter");
    assert.ok(sent.length >= 1, "the reporter must receive the report body");
    assert.match(sent.join("\n"), /分钟/, "the report must state the accounted minutes");

    const after = await api.list({ start: windowFrom, end: windowTo });
    assert.equal(after.ok, true, `clock list failed: ${after.code}`);
    const created = (Array.isArray(after.data) ? after.data : after.data?.periods ?? []).filter((row) => !baseline.has(row.id));
    assert.equal(created.length, 1, "the ledger unit must become exactly one clock period");
    const period = created[0];
    assert.equal(period.activityId, cfgReal.clock.activityId);
    const minutes = (Date.parse(period.end) - Date.parse(period.start)) / 60_000;
    assert.ok(Math.abs(minutes - 20) <= 1, `clock period should span 20 minutes, got ${minutes}`);

    const removed = await api.remove(period.id);
    assert.equal(removed.ok, true, `cleanup failed: ${removed.code}`);
    const final = await api.list({ start: windowFrom, end: windowTo });
    const rest = (Array.isArray(final.data) ? final.data : final.data?.periods ?? []).filter((row) => !baseline.has(row.id));
    assert.equal(rest.length, 0, "every test period must be deleted");
  } finally {
    const cleanup = await api.list({ start: windowFrom, end: windowTo });
    for (const row of (Array.isArray(cleanup.data) ? cleanup.data : cleanup.data?.periods ?? [])) {
      if (!baseline.has(row.id)) await api.remove(row.id);
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
