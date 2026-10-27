import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appendLedger,
  assistantText,
  buildOpenRecord,
  buildRecord,
  createRunTracker,
  detectSource,
  ledgerFilePath,
  normalizeSessionId,
  readRecords,
  serializeRecord,
  summarize,
  MAX_LINE_BYTES,
  STALE_RUN_MS,
  CONTEXT_LIMITS,
  normalizePaths,
} from "../../src/ledger.mjs";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-ledger-"));
}

function fixedClock(start = Date.parse("2026-10-24T01:00:00.000Z")) {
  let current = start;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
  };
}

test("normalizeSessionId keeps safe characters and replaces the rest", () => {
  assert.equal(normalizeSessionId("fs-th-om_x100b.628a"), "fs-th-om_x100b.628a");
  assert.equal(normalizeSessionId("fs-th/../../etc"), "fs-th_.._.._etc");
  assert.equal(normalizeSessionId(""), "unknown");
  assert.equal(normalizeSessionId(null), "unknown");
});

test("detectSource prefers an explicit ledger source, then relay platform, then interactive", () => {
  assert.equal(
    detectSource({ env: { AGENT_LEDGER_SOURCE: "automation", RELAY_PLATFORM: "feishu" } }),
    "automation",
  );
  assert.equal(detectSource({ env: { RELAY_PLATFORM: "feishu" } }), "relay");
  assert.equal(detectSource({ env: {} }), "interactive");
});

test("assistantText concatenates text parts and ignores other roles", () => {
  assert.equal(assistantText({ role: "assistant", content: "  hi  " }), "hi");
  assert.equal(
    assistantText({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "ignore" },
        { type: "text", text: "第一段" },
        { type: "text", text: "第二段" },
      ],
    }),
    "第一段第二段",
  );
  assert.equal(assistantText({ role: "assistant", content: [] }), "");
  assert.equal(assistantText({ role: "user", content: "nope" }), "");
  assert.equal(assistantText(null), "");
});

test("buildRecord produces the ten documented fields", () => {
  const record = buildRecord({
    sessionId: "fs-th-1",
    sessionFile: "/sessions/x_fs-th-1.jsonl",
    source: "relay",
    startedAtMs: Date.parse("2026-10-24T01:00:00.000Z"),
    endedAtMs: Date.parse("2026-10-24T01:03:04.000Z"),
    texts: ["做这个"],
    output: "做完了",
    aborted: false,
  });
  assert.deepEqual(Object.keys(record), [
    "v",
    "id",
    "sessionId",
    "sessionFile",
    "source",
    "startedAt",
    "durationMs",
    "userText",
    "output",
    "aborted",
  ]);
  assert.equal(record.id, "fs-th-1:2026-10-24T01:00:00.000Z");
  assert.equal(record.durationMs, 184_000);
  assert.equal(record.startedAt, "2026-10-24T01:00:00.000Z");
});

test("a run settles once with wall-clock duration and no truncation", () => {
  const clock = fixedClock();
  const tracker = createRunTracker({ now: clock.now, env: () => ({ RELAY_PLATFORM: "feishu" }) });
  tracker.begin("跑一下端到端测试");
  tracker.start();
  clock.advance(45 * 60_000);
  const record = tracker.drain({ sessionId: "fs-th-1", sessionFile: "/s/1_fs-th-1.jsonl" });
  assert.equal(record.durationMs, 45 * 60_000);
  assert.equal(record.source, "relay");
  assert.equal(record.userText, "跑一下端到端测试");
  assert.equal(tracker.drain({ sessionId: "fs-th-1" }), null);
});

test("a relay session file without any environment hint stays interactive", () => {
  const clock = fixedClock();
  const tracker = createRunTracker({ now: clock.now, env: () => ({}) });
  tracker.begin("只回复：ok");
  tracker.start();
  const record = tracker.drain({
    sessionId: "fs-th-om_1",
    sessionFile: "/sessions/dir/2026-10-23T10-11-58_fs-th-om_1.jsonl",
  });
  assert.equal(record.source, "interactive");
});

test("duration is measured from the first agent_start of a multi-run settle window", () => {
  const clock = fixedClock();
  const tracker = createRunTracker({ now: clock.now });
  tracker.begin("长任务");
  tracker.start();
  clock.advance(60_000);
  tracker.start();
  clock.advance(60_000);
  const record = tracker.drain({ sessionId: "s1" });
  assert.equal(record.durationMs, 120_000);
});

test("empty assistant text never overwrites a cached non-empty output", () => {
  const clock = fixedClock();
  const tracker = createRunTracker({ now: clock.now });
  tracker.begin("go");
  tracker.start();
  tracker.takeOutput({ role: "assistant", content: [{ type: "text", text: "改完了" }] });
  tracker.takeOutput({ role: "assistant", content: [] });
  const record = tracker.drain({ sessionId: "s1" });
  assert.equal(record.output, "改完了");
});

test("a mid-run user message is appended to the same record", () => {
  const clock = fixedClock();
  const tracker = createRunTracker({ now: clock.now });
  tracker.begin("第一句");
  tracker.start();
  clock.advance(5_000);
  tracker.begin("再补一句");
  const record = tracker.drain({ sessionId: "s1" });
  assert.equal(record.userText, "第一句\n---\n再补一句");
});

test("a prompt that never started a run yields no record", () => {
  const tracker = createRunTracker({ now: () => 0 });
  tracker.begin("/reload");
  assert.equal(tracker.drain({ sessionId: "s1" }), null);
  assert.equal(tracker.isEmpty(), true);
});

test("a stale active run is discarded when the next prompt arrives", () => {
  const clock = fixedClock();
  const tracker = createRunTracker({ now: clock.now });
  tracker.begin("老轮");
  tracker.start();
  clock.advance(STALE_RUN_MS + 1);
  tracker.begin("新轮");
  tracker.start();
  const record = tracker.drain({ sessionId: "s1" });
  assert.equal(record.userText, "新轮");
  assert.equal(record.durationMs, 0);
});

test("aborted runs are recorded with aborted=true", () => {
  const clock = fixedClock();
  const tracker = createRunTracker({ now: clock.now });
  tracker.begin("被打断");
  tracker.start();
  const record = tracker.drain({ sessionId: "s1", aborted: true });
  assert.equal(record.aborted, true);
});

test("userText and output are capped at 600 and 400 characters", () => {
  const record = buildRecord({
    sessionId: "s1",
    source: "interactive",
    startedAtMs: 0,
    endedAtMs: 1000,
    texts: ["字".repeat(900)],
    output: "答".repeat(900),
  });
  assert.equal(record.userText.length, 600);
  assert.equal(record.output.length, 400);
});

test("a pathological record still serializes under the append atomicity budget", () => {
  const record = buildRecord({
    sessionId: "s1",
    sessionFile: "/s/x.jsonl",
    source: "relay",
    startedAtMs: 0,
    endedAtMs: 1000,
    texts: ["\"\\".repeat(600)],
    output: "\"\\".repeat(400),
  });
  const line = serializeRecord(record);
  assert.ok(Buffer.byteLength(line) <= MAX_LINE_BYTES, `line was ${Buffer.byteLength(line)} bytes`);
  assert.ok(line.endsWith("\n"));
  assert.equal(JSON.parse(line).id, record.id);
});

test("appendLedger creates a 0700 directory, a 0600 file and appends one line per record", () => {
  const dir = path.join(tempDir(), "ledger");
  const record = buildRecord({
    sessionId: "fs-th/../x",
    source: "relay",
    startedAtMs: Date.parse("2026-10-24T01:00:00.000Z"),
    endedAtMs: Date.parse("2026-10-24T01:00:10.000Z"),
    texts: ["hi"],
    output: "ok",
  });
  appendLedger(record, { dir });
  appendLedger({ ...record, id: `${record.id}#2` }, { dir });
  const file = ledgerFilePath(dir, record.sessionId);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).sessionId, "fs-th_.._x");
});

test("readRecords skips unparsable lines and summarize groups by local day", () => {
  const dir = path.join(tempDir(), "ledger");
  fs.mkdirSync(dir, { recursive: true });
  const first = buildRecord({
    sessionId: "s1",
    source: "relay",
    startedAtMs: Date.parse("2026-10-24T01:00:00.000Z"),
    endedAtMs: Date.parse("2026-10-24T01:10:00.000Z"),
    texts: ["a"],
  });
  const second = buildRecord({
    sessionId: "s1",
    source: "interactive",
    startedAtMs: Date.parse("2026-10-23T12:00:00.000Z"),
    endedAtMs: Date.parse("2026-10-23T12:30:00.000Z"),
    texts: ["b"],
  });
  fs.writeFileSync(path.join(dir, "s1.jsonl"), `${JSON.stringify(first)}\nnot-json\n${JSON.stringify(second)}\n`);
  const records = readRecords(dir);
  assert.equal(records.length, 2);
  const daily = summarize(records, { tz: "Asia/Shanghai" });
  assert.deepEqual(
    daily.map((entry) => [entry.day, entry.runs, entry.minutes]),
    [
      ["2026-10-24", 1, 10],
      ["2026-10-23", 1, 30],
    ],
  );
});

test("agent_start yields one open record whose id matches the eventual closed record", () => {
  const clock = fixedClock();
  const tracker = createRunTracker({ now: clock.now, env: () => ({ RELAY_PLATFORM: "feishu" }) });
  tracker.begin("查一下工时");
  const opened = tracker.start();
  assert.deepEqual(Object.keys(opened), ["startedAtMs"]);
  assert.equal(tracker.start(), null);
  const open = buildOpenRecord({
    sessionId: "fs-th-1",
    sessionFile: "/s/1_fs-th-1.jsonl",
    source: "relay",
    startedAtMs: opened.startedAtMs,
  });
  assert.equal(open.kind, "open");
  assert.equal(open.durationMs, undefined);
  assert.equal(open.userText, undefined);
  assert.equal(open.output, undefined);
  clock.advance(90_000);
  const closed = tracker.drain({ sessionId: "fs-th-1", sessionFile: "/s/1_fs-th-1.jsonl" });
  assert.equal(open.id, closed.id);
});

test("readRecords drops open lines so summary counts stay unchanged", () => {
  const dir = path.join(tempDir(), "ledger");
  fs.mkdirSync(dir, { recursive: true });
  const startedAtMs = Date.parse("2026-10-24T01:00:00.000Z");
  const open = buildOpenRecord({ sessionId: "s1", sessionFile: "/s/1.jsonl", source: "relay", startedAtMs });
  const closed = buildRecord({
    sessionId: "s1",
    source: "relay",
    startedAtMs,
    endedAtMs: startedAtMs + 10 * 60_000,
    texts: ["a"],
  });
  fs.writeFileSync(path.join(dir, "s1.jsonl"), `${JSON.stringify(open)}\n${JSON.stringify(closed)}\n`);
  const records = readRecords(dir);
  assert.equal(records.length, 1);
  assert.equal(records[0].kind, undefined);
  assert.deepEqual(
    summarize(records, { tz: "Asia/Shanghai" }).map((entry) => [entry.day, entry.runs, entry.minutes]),
    [["2026-10-24", 1, 10]],
  );
});

test("normalizePaths keeps absolute unique paths in order within the limits", () => {
  const long = `/tmp/${"a".repeat(300)}`;
  const paths = normalizePaths([
    "/tmp/repo/a.mjs",
    "relative/b.mjs",
    "/tmp/repo/a.mjs",
    long,
    "/tmp/repo/c.mjs",
    "/tmp/repo/d.mjs",
    "/tmp/repo/e.mjs",
    "/tmp/repo/f.mjs",
  ]);
  assert.deepEqual(paths.slice(0, 3), ["/tmp/repo/a.mjs", long.slice(0, CONTEXT_LIMITS.pathLength), "/tmp/repo/c.mjs"]);
  assert.equal(paths.length, CONTEXT_LIMITS.paths);
  assert.equal(paths[1].length, CONTEXT_LIMITS.pathLength);
  assert.deepEqual(normalizePaths([]), []);
  assert.deepEqual(normalizePaths(undefined), []);
});

test("buildRecord carries cwd, sessionName and paths only when present", () => {
  const bare = buildRecord({ sessionId: "s1", source: "interactive", startedAtMs: 0, endedAtMs: 1000, texts: ["a"] });
  assert.equal(bare.cwd, undefined);
  assert.equal(bare.sessionName, undefined);
  assert.equal(bare.paths, undefined);
  const full = buildRecord({
    sessionId: "s1",
    source: "relay",
    startedAtMs: 0,
    endedAtMs: 1000,
    texts: ["a"],
    cwd: "/tmp/repo",
    sessionName: "修复 dry-run",
    paths: ["/tmp/repo/src/a.mjs"],
  });
  assert.equal(full.cwd, "/tmp/repo");
  assert.equal(full.sessionName, "修复 dry-run");
  assert.deepEqual(full.paths, ["/tmp/repo/src/a.mjs"]);
  assert.equal(full.v, 1);
});

test("buildOpenRecord carries cwd and the session name but never paths", () => {
  const open = buildOpenRecord({
    sessionId: "s1",
    sessionFile: "/s/1.jsonl",
    source: "relay",
    startedAtMs: 0,
    cwd: "/tmp/repo",
    sessionName: "修复 dry-run",
  });
  assert.equal(open.cwd, "/tmp/repo");
  assert.equal(open.sessionName, "修复 dry-run");
  assert.equal(open.paths, undefined);
});

test("the tracker collects touched paths and hands them to the closed record", () => {
  const clock = fixedClock();
  const tracker = createRunTracker({ now: clock.now, env: () => ({}) });
  tracker.begin("按 1 修");
  tracker.start();
  tracker.notePath("/tmp/repo/src/a.mjs");
  tracker.notePath("relative.mjs");
  tracker.notePath("/tmp/repo/src/a.mjs");
  clock.advance(1000);
  const record = tracker.drain({ sessionId: "s1", sessionFile: "/s/1.jsonl", cwd: "/tmp/repo", sessionName: "修复 dry-run" });
  assert.deepEqual(record.paths, ["/tmp/repo/src/a.mjs"]);
  assert.equal(record.cwd, "/tmp/repo");
  assert.equal(record.sessionName, "修复 dry-run");
});

test("a record over the byte budget drops paths before output", () => {
  const record = buildRecord({
    sessionId: "s1",
    sessionFile: "/s/x.jsonl",
    source: "relay",
    startedAtMs: 0,
    endedAtMs: 1000,
    texts: ["字".repeat(600)],
    output: "答".repeat(400),
    cwd: "/tmp/repo",
    sessionName: "修复 dry-run",
    paths: Array.from({ length: CONTEXT_LIMITS.paths }, (_, index) => `/tmp/repo/路径-${index}-${"长".repeat(140)}`),
  });
  const line = serializeRecord(record);
  assert.ok(Buffer.byteLength(line) <= MAX_LINE_BYTES, `line was ${Buffer.byteLength(line)} bytes`);
  const parsed = JSON.parse(line);
  assert.equal(parsed.paths, undefined);
  assert.equal(parsed.cwd, "/tmp/repo");
  assert.equal(parsed.sessionName, "修复 dry-run");
  assert.ok(parsed.output.length > 0);
});
