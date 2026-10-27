import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  acquireLock,
  buildUnits,
  chunkMessage,
  clearOverride,
  decideUnit,
  formatDuration,
  formatReport,
  humanCoverage,
  listReviews,
  planOperations,
  readDecisions,
  readLedger,
  readOpenRuns,
  readRecords,
  dedupeRuns,
  readDayTotal,
  formatDelta,
  run,
  runHash,
  runState,
  setOverride,
  unitHash,
  unitState,
  hydrateContext,
  repoRoot,
  reposOf,
  sessionContext,
  DEFAULTS,
} from "../../src/hours.mjs";

const MINUTE = 60_000;

function rec(startIso, minutes, extra = {}) {
  return {
    v: 1,
    id: `${extra.sessionId ?? "s1"}:${startIso}`,
    sessionId: extra.sessionId ?? "s1",
    sessionFile: "/s/x.jsonl",
    source: extra.source ?? "interactive",
    startedAt: startIso,
    durationMs: minutes * MINUTE,
    userText: extra.userText ?? "干点活",
    output: extra.output ?? "干完了",
    aborted: extra.aborted ?? false,
    cwd: extra.cwd ?? "",
    sessionName: extra.sessionName ?? "",
    paths: extra.paths ?? [],
  };
}

function fakeJudge(answers) {
  const calls = [];
  return {
    calls,
    async judgeChoice({ id, state }) {
      calls.push({ id, state });
      const answer = answers.shift();
      return answer ?? { choice: null, confidence: null, probabilities: null, fallback: "error" };
    },
  };
}

test("units merge when the gap from the previous end is 14 minutes and split at 16", () => {
  const units = buildUnits([
    rec("2026-10-24T01:00:00.000Z", 10),
    rec("2026-10-24T01:24:00.000Z", 10),
    rec("2026-10-24T01:50:00.000Z", 10),
  ]);
  assert.equal(units.length, 2);
  assert.equal(units.find((unit) => unit.runs.length === 2).runs.length, 2);
});

test("gap is measured from the previous end, not the previous start", () => {
  const units = buildUnits([rec("2026-10-24T01:00:00.000Z", 45), rec("2026-10-24T01:50:00.000Z", 5)]);
  assert.equal(units.length, 1);
});

test("overlapping runs in one session stay in the same unit and do not break later ones", () => {
  const units = buildUnits([
    rec("2026-10-24T01:00:00.000Z", 5),
    rec("2026-10-24T01:00:07.000Z", 5),
    rec("2026-10-24T01:30:00.000Z", 5),
  ]);
  assert.deepEqual(units.map((unit) => unit.runs.length), [1, 2]);
});

test("units never cross sessions", () => {
  const units = buildUnits([
    rec("2026-10-24T01:00:00.000Z", 5, { sessionId: "a" }),
    rec("2026-10-24T01:05:00.000Z", 5, { sessionId: "b" }),
  ]);
  assert.equal(units.length, 2);
});

test("automation, aborted and empty-prompt runs are dropped before units are built", () => {
  const units = buildUnits([
    rec("2026-10-24T01:00:00.000Z", 5, { source: "automation" }),
    rec("2026-10-24T01:00:00.000Z", 5, { aborted: true }),
    rec("2026-10-24T01:00:00.000Z", 5, { userText: "   " }),
  ]);
  assert.equal(units.length, 0);
});

test("unit key is the session id plus the first run start", () => {
  const [unit] = buildUnits([rec("2026-10-24T01:00:00.000Z", 5), rec("2026-10-24T01:06:00.000Z", 5)]);
  assert.equal(unit.key, "s1:2026-10-24T01:00:00.000Z");
  assert.equal(unit.runs.length, 2);
});

test("unit state carries requests then outputs and truncates each to 1200 chars", () => {
  const [unit] = buildUnits([rec("2026-10-24T01:00:00.000Z", 5, { userText: "字".repeat(2000), output: "答".repeat(2000) })]);
  const state = unitState(unit);
  assert.ok(state.startsWith("【用户请求】\n"));
  assert.ok(state.includes("\n\n【agent 产出】\n"));
  assert.ok(state.length <= 1200 * 2 + 40);
});

test("unit hash changes when a new run joins the unit", () => {
  const base = buildUnits([rec("2026-10-24T01:00:00.000Z", 5)])[0];
  const grown = buildUnits([rec("2026-10-24T01:00:00.000Z", 5), rec("2026-10-24T01:06:00.000Z", 5)])[0];
  assert.notEqual(unitHash(base), unitHash(grown));
  assert.equal(base.key, grown.key);
});

test("a confident probability split counts, an inverted one skips", async () => {
  const [unit] = buildUnits([rec("2026-10-24T01:00:00.000Z", 5)]);
  const judge = fakeJudge([
    { choice: "count", confidence: 0.9, probabilities: { count: 0.9, skip: 0.1 }, fallback: null },
    { choice: "skip", confidence: 0.9, probabilities: { count: 0.1, skip: 0.9 }, fallback: null },
  ]);
  assert.equal((await decideUnit(unit, { judge })).kind, "count");
  assert.equal((await decideUnit(unit, { judge })).kind, "skip");
});

test("a single run unit is never split, even when the verdict is low margin", async () => {
  const [unit] = buildUnits([rec("2026-10-24T01:00:00.000Z", 5)]);
  const lowMargin = fakeJudge([
    { choice: "count", confidence: 0.55, probabilities: { count: 0.54, skip: 0.46 }, fallback: null },
  ]);
  const result = await decideUnit(unit, { judge: lowMargin });
  assert.equal(result.kind, "review");
  assert.equal(result.reason, "low-margin");
  assert.equal(result.runs, null);
  assert.equal(lowMargin.calls.length, 1);

  const failed = fakeJudge([{ choice: null, confidence: null, probabilities: null, fallback: "timeout" }]);
  const failedResult = await decideUnit(unit, { judge: failed });
  assert.equal(failedResult.kind, "review");
  assert.equal(failedResult.reason, "timeout");

  const [longUnit] = buildUnits([rec("2026-10-24T01:00:00.000Z", 5 * 60)]);
  const longJudge = fakeJudge([]);
  const longResult = await decideUnit(longUnit, { judge: longJudge });
  assert.equal(longResult.reason, "long-run");
  assert.equal(longJudge.calls.length, 0);
});

test("a cached verdict is reused without calling the judge again", async () => {
  const [unit] = buildUnits([rec("2026-10-24T01:00:00.000Z", 5)]);
  const judge = fakeJudge([{ choice: "count", confidence: 0.9, probabilities: { count: 0.9, skip: 0.1 }, fallback: null }]);
  const first = await decideUnit(unit, { judge });
  const cache = { [unit.key]: { hash: unitHash(unit), result: first, notifiedHash: null } };
  const second = await decideUnit(unit, { judge, cache });
  assert.equal(second.cached, true);
  assert.equal(judge.calls.length, 1);
});

test("messages are chunked on block boundaries under the card limit", () => {
  const blocks = Array.from({ length: 5 }, (_, index) => `块 ${index} ${"字".repeat(800)}`);
  const chunks = chunkMessage(blocks.join("\n\n"), 2400);
  assert.ok(chunks.length >= 2);
  for (const chunk of chunks) assert.ok(chunk.length <= 2400);
  assert.equal(chunks.join("\n\n").replace(/\s+/g, ""), blocks.join("\n\n").replace(/\s+/g, ""));
});

function sandbox() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agent-hours-"));
  mkdirSync(path.join(dir, "ledger"), { recursive: true });
  const now = Date.parse("2026-10-24T02:00:00.000Z");
  const ledgerFile = path.join(dir, "ledger", "s1.jsonl");
  writeFileSync(
    ledgerFile,
    `${JSON.stringify(rec("2026-10-24T01:00:00.000Z", 5))}\n${JSON.stringify(rec("2026-10-24T01:10:00.000Z", 5))}\n`,
  );
  const stamp = now / 1000;
  utimesSync(ledgerFile, stamp, stamp);
  return { dir, now };
}

test("a run judges, notifies once and records the notified hash", async () => {
  const { dir, now } = sandbox();
  const judge = fakeJudge([{ choice: "count", confidence: 0.9, probabilities: { count: 0.9, skip: 0.1 }, fallback: null }]);
  const sent = [];
  const first = await run({ now, dir, judge, notifyImpl: (text) => (sent.push(text), { ok: true }) });
  assert.equal(first.fresh.length, 1);
  assert.equal(first.delivered, true);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /\*\*工时\*\*/);

  const decisions = JSON.parse(readFileSync(path.join(dir, "decisions.json"), "utf8"));
  assert.equal(decisions.version, 2);
  const entry = Object.values(decisions.units)[0];
  assert.equal(entry.result.kind, "count");
  assert.equal(typeof entry.notifiedSig, "string");
  assert.ok(existsSync(path.join(dir, "digest")));

  const second = await run({ now: now + 30 * MINUTE, dir, judge, notifyImpl: (text) => (sent.push(text), { ok: true }) });
  assert.equal(second.fresh.length, 0);
  assert.equal(sent.length, 1);
  assert.equal(judge.calls.length, 1);
});

function fakeClock({ totals = [] } = {}) {
  const state = { periods: [], listed: [], patches: [], removed: [] };
  const client = {
    async daily() {
      return { ok: true, data: totals };
    },
    async list({ start, end }) {
      const rows = [...state.listed, ...state.periods]
        .filter((item) => item.end > start && item.start < end)
        .map((item) => ({ id: item.id, activityId: "a1", start: new Date(item.start).toISOString(), end: new Date(item.end).toISOString() }));
      return { ok: true, data: { periods: rows, hasMore: false } };
    },
    async activities() {
      return { ok: true, data: [{ id: "a1", name: "clock" }] };
    },
    async create({ start, end }) {
      const id = `p${state.periods.length + 1}`;
      state.periods.push({ id, start, end });
      return { ok: true, data: { id } };
    },
    async patch(id, { start, end }) {
      state.patches.push({ id, start, end });
      return { ok: true, data: { id } };
    },
    async remove(id) {
      state.removed.push(id);
      state.periods = state.periods.filter((item) => item.id !== id);
      return { ok: true };
    },
  };
  return { client, state };
}

function clockSandbox(clock = { enabled: true, activityId: "a1", activityName: "clock" }) {
  const box = sandbox();
  writeFileSync(path.join(box.dir, "config.json"), JSON.stringify({ clock }));
  return box;
}

const TODAY_TOTAL = [{ date: "2026-10-24", totalDuration: 15 * MINUTE, periodCount: 1 }];

test("a clock write notifies once and a quiet round stays silent", async () => {
  const { dir, now } = clockSandbox();
  const judge = fakeJudge([{ choice: "count", confidence: 0.9, probabilities: { count: 0.9, skip: 0.1 }, fallback: null }]);
  const { client, state } = fakeClock({ totals: TODAY_TOTAL });
  const sent = [];
  const notifyImpl = (text) => (sent.push(text), { ok: true });

  const first = await run({ now, dir, judge, clockClient: client, notifyImpl });
  assert.equal(state.periods.length, 1);
  assert.equal(first.clock.created, 1);
  assert.equal(first.delivered, true);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /Clock 新增 1 段/);

  const quiet = await run({ now: now + 30 * MINUTE, dir, judge, clockClient: client, notifyImpl });
  assert.equal(quiet.fresh.length, 0);
  assert.equal(quiet.clock.created, 0);
  assert.equal(quiet.delivered, false);
  assert.equal(sent.length, 1);
  assert.match(readFileSync(path.join(dir, "digest", "2026-10-24.md"), "utf8"), /未发（clock 无变更）/);
});

test("new units without any clock change stay silent", async () => {
  const { dir, now } = clockSandbox({ enabled: true, activityId: "a1", activityName: "clock", minSegmentMinutes: 60 });
  const judge = fakeJudge([{ choice: "count", confidence: 0.9, probabilities: { count: 0.9, skip: 0.1 }, fallback: null }]);
  const { client, state } = fakeClock({ totals: TODAY_TOTAL });
  const sent = [];
  const outcome = await run({ now, dir, judge, clockClient: client, notifyImpl: (text) => (sent.push(text), { ok: true }) });
  assert.equal(outcome.fresh.length, 1);
  assert.equal(state.periods.length, 0);
  assert.equal(outcome.clock.created, 0);
  assert.equal(outcome.delivered, false);
  assert.equal(sent.length, 0);
});

test("a clock-only round still produces a report", () => {
  const report = formatReport([], {
    tz: DEFAULTS.tz,
    now: Date.parse("2026-10-24T13:00:00.000Z"),
    clock: { created: 0, patched: 2, deleted: 1, conflict: 0, conflictMinutes: 0, failed: 0, blocked: [] },
  });
  assert.match(report, /本轮无新增单元/);
  assert.match(report, /Clock 改 2 段 · 删 1 段/);
  assert.equal(formatReport([], { tz: DEFAULTS.tz }), "");
});

test("review units are queued and a failed notify leaves them un-notified", async () => {
  const { dir, now } = sandbox();
  const judge = fakeJudge([{ choice: null, confidence: null, probabilities: null, fallback: "http_429" }]);
  const outcome = await run({ now, dir, judge, notifyImpl: () => ({ ok: false, output: "boom" }) });
  assert.equal(outcome.delivered, false);
  const reviewFile = path.join(dir, "review", "2026-10-24.jsonl");
  assert.ok(existsSync(reviewFile));
  const entry = JSON.parse(readFileSync(reviewFile, "utf8").trim().split("\n")[0]);
  assert.equal(entry.reason, "http_429");
  const decisions = JSON.parse(readFileSync(path.join(dir, "decisions.json"), "utf8"));
  assert.equal(Object.values(decisions.units)[0].notifiedSig, null);
});

test("units that ended inside the settle window are left for the next run", async () => {
  const { dir, now } = sandbox();
  const judge = fakeJudge([{ choice: "count", confidence: 0.9, probabilities: { count: 0.9, skip: 0.1 }, fallback: null }]);
  const outcome = await run({ now: Date.parse("2026-10-24T01:18:00.000Z"), dir, judge, notifyImpl: () => ({ ok: true }) });
  assert.equal(outcome.units, 0);
  assert.equal(judge.calls.length, 0);
});

function readEvents(dir, day = "2026-10-24") {
  return readFileSync(path.join(dir, "logs", `${day}.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

test("a run writes one event stream with unit, notify and round lines", async () => {
  const { dir, now } = sandbox();
  const judge = fakeJudge([{ choice: "count", confidence: 0.9, attempts: 1, elapsedMs: 1200, probabilities: { count: 0.9, skip: 0.1 }, fallback: null }]);
  await run({ now, dir, judge, notifyImpl: () => ({ ok: true, output: "sent" }) });
  const events = readEvents(dir);
  assert.deepEqual(events.map((event) => event.event), ["unit", "notify", "round"]);
  const [unit, notify, round] = events;
  assert.equal(unit.kind, "count");
  assert.equal(unit.review, false);
  assert.equal(unit.confidence, 0.9);
  assert.equal(unit.attempts, 1);
  assert.equal(unit.elapsedMs, 1200);
  assert.deepEqual(unit.span, ["2026-10-24T01:00:00.000Z", "2026-10-24T01:15:00.000Z"]);
  assert.equal(unit.key.startsWith("s1:"), true);
  assert.equal(unit.session, "s1");
  assert.equal(unit.source, "interactive");
  assert.equal(notify.ok, true);
  assert.equal(notify.units, 1);
  assert.equal(round.units, 1);
  assert.equal(round.processed, 1);
  assert.equal(round.leftover, 0);
  assert.equal(typeof round.calls, "number");
  assert.deepEqual(round.counts, { count: 1 });
});

test("review units carry the flag, reason and the request/output excerpts in the same stream", async () => {
  const { dir, now } = sandbox();
  const judge = fakeJudge([{ choice: null, confidence: null, attempts: 3, elapsedMs: 90000, probabilities: null, fallback: "timeout" }]);
  await run({ now, dir, judge, notifyImpl: () => ({ ok: true, output: "sent" }) });
  const [unit] = readEvents(dir);
  assert.equal(unit.review, true);
  assert.equal(unit.kind, "review");
  assert.equal(unit.reason, "timeout");
  assert.equal(unit.attempts, 3);
  assert.equal(unit.requests.length, 2);
  assert.equal(unit.outputs.length, 2);
});

test("unchanged units are not re-appended to the stream on a later round", async () => {
  const { dir, now } = sandbox();
  const judge = fakeJudge([{ choice: "count", confidence: 0.9, probabilities: { count: 0.9, skip: 0.1 }, fallback: null }]);
  await run({ now, dir, judge, notifyImpl: () => ({ ok: true, output: "sent" }) });
  await run({ now: now + 30 * MINUTE, dir, judge, notifyImpl: () => ({ ok: true, output: "sent" }) });
  const events = readEvents(dir);
  assert.equal(events.filter((event) => event.event === "unit").length, 1);
  assert.equal(events.filter((event) => event.event === "round").length, 2);
});

test("dry run writes nothing and leaves a v1 cache untouched", async () => {
  const { dir, now } = sandbox();
  const unit = SANDBOX_UNIT();
  const v1 = { [unit.key]: { hash: "stale", result: { kind: "review", reason: "low-confidence" }, notifiedHash: null, judgedAt: "2026-10-24T01:20:00.000Z" } };
  writeFileSync(path.join(dir, "decisions.json"), JSON.stringify(v1));
  const judge = fakeJudge([
    { choice: null, confidence: 0.12, probabilities: { count: 0.44, skip: 0.56 }, fallback: "low-confidence" },
    { choice: "count", confidence: 0.9, probabilities: { count: 0.9, skip: 0.1 }, fallback: null },
    { choice: "count", confidence: 0.9, probabilities: { count: 0.9, skip: 0.1 }, fallback: null },
  ]);
  const outcome = await run({ now, dir, judge, dryRun: true, notifyImpl: () => ({ ok: true }) });
  assert.equal(outcome.fresh.length, 1);
  assert.ok(outcome.report.includes("**工时**"));
  assert.equal(readFileSync(path.join(dir, "decisions.json"), "utf8"), JSON.stringify(v1));
  assert.equal(existsSync(path.join(dir, "decisions.v1.bak.json")), false);
  assert.equal(existsSync(path.join(dir, "digest")), false);
  assert.equal(existsSync(path.join(dir, "logs")), false);
});

test("ledger reader keeps every record of a file whose mtime is inside the window", () => {
  const { dir, now } = sandbox();
  const fresh = readLedger(path.join(dir, "ledger"), { now });
  assert.equal(fresh.length, 2);
  const stale = readLedger(path.join(dir, "ledger"), { now: now + 4 * 24 * 60 * MINUTE });
  assert.equal(stale.length, 0);
});

test("unit keys do not drift when a head run falls out of the startedAt window", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agent-hours-"));
  mkdirSync(path.join(dir, "ledger"), { recursive: true });
  const now = Date.now();
  const head = new Date(now - 71.5 * 3_600_000).toISOString();
  const tail = new Date(now - 71.5 * 3_600_000 + 12 * MINUTE).toISOString();
  writeFileSync(path.join(dir, "ledger", "s1.jsonl"), `${JSON.stringify(rec(head, 10))}\n${JSON.stringify(rec(tail, 10))}\n`);
  const keysAt = (time) => buildUnits(readLedger(path.join(dir, "ledger"), { now: time }), {}).map((unit) => unit.key);
  const before = keysAt(now);
  assert.equal(before.length, 1);
  assert.deepEqual(keysAt(now + 2 * 3_600_000), before);
});

test("units that ended before the window are dropped before judging", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agent-hours-"));
  mkdirSync(path.join(dir, "ledger"), { recursive: true });
  const now = Date.now();
  const old = new Date(now - 73 * 3_600_000).toISOString();
  writeFileSync(path.join(dir, "ledger", "s1.jsonl"), `${JSON.stringify(rec(old, 5))}\n`);
  const judge = fakeJudge([{ choice: "count", confidence: 0.9, probabilities: { count: 0.9, skip: 0.1 }, fallback: null }]);
  const outcome = await run({ now, dir, judge, notifyImpl: () => ({ ok: true }) });
  assert.equal(outcome.units, 0);
  assert.equal(judge.calls.length, 0);
});

test("a second round cannot take the lock and a released one can", () => {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), "agent-hours-")), ".lock");
  const first = acquireLock(file);
  assert.equal(typeof first, "function");
  assert.equal(acquireLock(file), null);
  first();
  const second = acquireLock(file);
  assert.equal(typeof second, "function");
  second();
});

test("a stale lock is taken over instead of blocking forever", () => {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), "agent-hours-")), ".lock");
  writeFileSync(file, JSON.stringify({ pid: process.pid, ts: Date.now() - 60 * MINUTE }));
  const release = acquireLock(file);
  assert.equal(typeof release, "function");
  release();
});

test("the round budget stops judging and leaves the rest for the next round", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agent-hours-"));
  mkdirSync(path.join(dir, "ledger"), { recursive: true });
  writeFileSync(
    path.join(dir, "ledger", "s1.jsonl"),
    `${JSON.stringify(rec("2026-10-24T01:00:00.000Z", 5))}\n${JSON.stringify(rec("2026-10-24T02:00:00.000Z", 5))}\n`,
  );
  const slow = {
    async judgeChoice() {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { choice: "count", confidence: 0.9, probabilities: { count: 0.9, skip: 0.1 }, fallback: null };
    },
  };
  const outcome = await run({ now: Date.parse("2026-10-24T02:30:00.000Z"), dir, judge: slow, budgetMs: 10, notifyImpl: () => ({ ok: true }) });
  assert.equal(outcome.units, 2);
  assert.equal(outcome.fresh.length, 1);
  const round = readEvents(dir).find((event) => event.event === "round");
  assert.equal(round.leftover, 1);
  assert.equal(round.processed, 1);
});

test("report is a summary: verdict counts, counted minutes and where the review units sit", () => {
  const units = buildUnits([
    rec("2026-10-24T01:00:00.000Z", 10, { sessionId: "a" }),
    rec("2026-10-24T01:00:00.000Z", 5, { sessionId: "b" }),
  ]);
  const report = formatReport(
    [
      { unit: units[0], result: { kind: "count", p: { count: 0.9 }, margin: 0.8 } },
      { unit: units[1], result: { kind: "review", reason: "low-margin", p: { count: 0.52 }, margin: 0.04 } },
    ],
    { tz: DEFAULTS.tz, now: Date.parse("2026-10-24T02:00:00.000Z") },
  );
  const lines = report.split("\n");
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^\*\*工时\*\* 2026-10-24 10:00$/);
  assert.match(lines[1], /新增 2 单元 · 计入 1 · 不计 0 · 待确认 1/);
  assert.match(lines[2], /计入时长 10 分钟/);
});

test("durations switch to hours once they pass an hour", () => {
  assert.equal(formatDuration(0), "0 分钟");
  assert.equal(formatDuration(59), "59 分钟");
  assert.equal(formatDuration(60), "1 小时");
  assert.equal(formatDuration(66), "1.1 小时");
  assert.equal(formatDuration(90), "1.5 小时");
  assert.equal(formatDuration(167), "2.8 小时");
});

test("a report longer than an hour shows hours instead of raw minutes", () => {
  const units = buildUnits([
    rec("2026-10-24T01:00:00.000Z", 50, { sessionId: "a" }),
    rec("2026-10-24T02:00:00.000Z", 20, { sessionId: "b" }),
  ]);
  const report = formatReport(
    units.map((unit) => ({ unit, result: { kind: "count", p: { count: 0.9 }, margin: 0.8 } })),
    {
      tz: DEFAULTS.tz,
      now: Date.parse("2026-10-24T13:00:00.000Z"),
      clock: { created: 1, patched: 0, deleted: 0, conflict: 1, conflictMinutes: 75, failed: 0, blocked: [] },
    },
  );
  assert.match(report, /计入时长 1\.2 小时/);
  assert.match(report, /冲突 1\.3 小时/);
});

test("a report without review units omits the review count and adds the clock summary", () => {
  const units = buildUnits([rec("2026-10-24T01:00:00.000Z", 10)]);
  const report = formatReport(
    [{ unit: units[0], result: { kind: "count", p: { count: 0.9 }, margin: 0.8 } }],
    {
      tz: DEFAULTS.tz,
      now: Date.parse("2026-10-24T13:00:00.000Z"),
      clock: { created: 1, patched: 2, deleted: 0, conflict: 1, conflictMinutes: 29, failed: 0, blocked: [] },
    },
  );
  const lines = report.split("\n");
  assert.equal(lines.length, 4);
  assert.match(lines[0], /2026-10-24 21:00/);
  assert.doesNotMatch(lines[1], /待确认/);
  assert.equal(lines[3], "Clock 新增 1 段 · 改 2 段 · 冲突 29 分钟");
});

test("a manual override wins over both the cached verdict and a fresh judge call", async () => {
  const { dir, now } = sandbox();
  const judge = fakeJudge([{ choice: null, confidence: null, probabilities: { count: 0.73, skip: 0.27 }, fallback: "low-confidence" }]);
  await run({ now, dir, judge, notifyImpl: () => ({ ok: true }) });
  const key = Object.keys(JSON.parse(readFileSync(path.join(dir, "decisions.json"), "utf8")).units)[0];

  setOverride({ dir, key, kind: "count", note: "项目事务（PR 审批状态确认），人工裁定计入", now });
  const second = fakeJudge([]);
  const outcome = await run({ now, dir, judge: second, notifyImpl: () => ({ ok: true }) });
  assert.equal(outcome.fresh.length, 1);
  assert.equal(outcome.fresh[0].result.kind, "count");
  assert.equal(outcome.fresh[0].result.overridden, true);
  assert.equal(second.calls.length, 0);

  const decisions = JSON.parse(readFileSync(path.join(dir, "decisions.json"), "utf8"));
  assert.equal(decisions.units[key].result.kind, "count");
  assert.equal(decisions.units[key].override.kind, "count");
  const override = readEvents(dir).find((event) => event.event === "override");
  assert.equal(override.kind, "count");
  assert.equal(override.previous, "review");
});

test("an override survives a changed input hash and re-judging is skipped", async () => {
  const { dir, now } = sandbox();
  const judge = fakeJudge([{ choice: null, confidence: null, probabilities: null, fallback: "timeout" }]);
  await run({ now, dir, judge, notifyImpl: () => ({ ok: true }) });
  const key = Object.keys(JSON.parse(readFileSync(path.join(dir, "decisions.json"), "utf8")).units)[0];
  setOverride({ dir, key, kind: "count" });

  writeFileSync(
    path.join(dir, "ledger", "s1.jsonl"),
    `${JSON.stringify(rec("2026-10-24T01:00:00.000Z", 5, { userText: "换了请求" }))}\n`,
  );
  const grown = fakeJudge([]);
  const outcome = await run({ now, dir, judge: grown, notifyImpl: () => ({ ok: true }) });
  assert.equal(grown.calls.length, 0);
  assert.equal(outcome.fresh.length, 1);
  const decisions = JSON.parse(readFileSync(path.join(dir, "decisions.json"), "utf8"));
  assert.equal(decisions.units[key].override.kind, "count");
});

test("clearing an override sends the unit back to the judge", async () => {
  const { dir, now } = sandbox();
  const judge = fakeJudge([{ choice: null, confidence: null, probabilities: null, fallback: "timeout" }]);
  await run({ now, dir, judge, notifyImpl: () => ({ ok: true }) });
  const key = Object.keys(JSON.parse(readFileSync(path.join(dir, "decisions.json"), "utf8")).units)[0];
  setOverride({ dir, key, kind: "skip" });
  assert.equal(clearOverride({ dir, key }).kind, "skip");
  assert.equal(clearOverride({ dir, key }), null);

  const back = fakeJudge([{ choice: "count", confidence: 0.9, probabilities: { count: 0.9, skip: 0.1 }, fallback: null }]);
  const outcome = await run({ now, dir, judge: back, notifyImpl: () => ({ ok: true }) });
  assert.equal(back.calls.length, 1);
  assert.equal(outcome.fresh[0].result.kind, "count");
  assert.equal(outcome.fresh[0].result.overridden, undefined);
});

test("listReviews shows the review queue with the override state", async () => {
  const { dir, now } = sandbox();
  const judge = fakeJudge([{ choice: null, confidence: null, probabilities: { count: 0.73, skip: 0.27 }, fallback: "low-confidence" }]);
  await run({ now, dir, judge, notifyImpl: () => ({ ok: true }) });
  const key = Object.keys(JSON.parse(readFileSync(path.join(dir, "decisions.json"), "utf8")).units)[0];
  const before = listReviews({ dir });
  assert.equal(before.length, 1);
  assert.equal(before[0].key, key);
  assert.equal(before[0].reason, "pending");
  assert.equal(before[0].override, null);
  setOverride({ dir, key, kind: "count" });
  assert.equal(listReviews({ dir })[0].override, "count");
});

test("setOverride rejects unknown units and unknown kinds", () => {
  const { dir } = sandbox();
  assert.throws(() => setOverride({ dir, key: "nope", kind: "count" }), /unknown unit/);
  const judge = fakeJudge([]);
  assert.equal(typeof judge, "object");
});

test("units that hit the cache are kept in the round even past the judge quota", async () => {
  const { dir, now } = sandbox();
  const judge = fakeJudge([{ choice: "count", confidence: 0.9, probabilities: { count: 0.9, skip: 0.1 }, fallback: null }]);
  await run({ now, dir, judge, notifyImpl: () => ({ ok: true }) });
  writeFileSync(path.join(dir, "config.json"), JSON.stringify({ maxJudgeCallsPerRun: 0 }));
  const second = fakeJudge([]);
  await run({ now: now + 30 * MINUTE, dir, judge: second, notifyImpl: () => ({ ok: true }) });
  assert.equal(second.calls.length, 0);
  const round = readEvents(dir).filter((event) => event.event === "round").pop();
  assert.equal(round.leftover, 0);
  assert.equal(round.processed, 1);
});

test("a unit that needs judging is deferred, not dropped, when the quota is spent", async () => {
  const { dir, now } = sandbox();
  const judge = fakeJudge([{ choice: "count", confidence: 0.9, probabilities: { count: 0.9, skip: 0.1 }, fallback: null }]);
  writeFileSync(
    path.join(dir, "ledger", "s2.jsonl"),
    `${JSON.stringify(rec("2026-10-24T01:40:00.000Z", 5, { sessionId: "s2" }))}\n`,
  );
  writeFileSync(path.join(dir, "config.json"), JSON.stringify({ maxJudgeCallsPerRun: 1 }));
  const outcome = await run({ now, dir, judge, notifyImpl: () => ({ ok: true }) });
  assert.equal(outcome.units, 2);
  const round = readEvents(dir).filter((event) => event.event === "round").pop();
  assert.equal(round.leftover, 1);
  assert.equal(round.processed, 1);
});

test("a run hash carries the prompt version and the run text", () => {
  const [unit] = buildUnits([rec("2026-10-24T01:00:00.000Z", 5)]);
  const run0 = unit.runs[0];
  const first = runHash(run0);
  assert.equal(first.length, 16);
  assert.notEqual(first, runHash({ ...run0, userText: "换了请求" }));
  assert.equal(first, runHash({ ...run0 }));
  assert.match(runState(run0), /【用户请求】/);
});

const SPLIT_ROWS = () => [
  rec("2026-10-24T01:00:00.000Z", 5, { userText: "客户 PR 评审", output: "批注三条" }),
  rec("2026-10-24T01:10:00.000Z", 5, { userText: "relay 标记实现", output: "改了 core.mjs" }),
];

function splitSandbox() {
  const sandboxDir = sandbox();
  writeFileSync(
    path.join(sandboxDir.dir, "ledger", "s1.jsonl"),
    `${SPLIT_ROWS().map((row) => JSON.stringify(row)).join("\n")}\n`,
  );
  return sandboxDir;
}

const SANDBOX_UNIT = () => buildUnits(SPLIT_ROWS())[0];

function singleSandbox() {
  const box = sandbox();
  writeFileSync(path.join(box.dir, "ledger", "s1.jsonl"), `${JSON.stringify(rec("2026-10-24T01:00:00.000Z", 5))}\n`);
  return box;
}

test("a v1 decisions file is migrated in place and its low confidence units split", async () => {
  const { dir, now } = splitSandbox();
  const unit = SANDBOX_UNIT();
  writeFileSync(
    path.join(dir, "decisions.json"),
    JSON.stringify({ [unit.key]: { hash: unitHash(unit), result: { kind: "review", reason: "low-confidence", p: { count: 0.5, skip: 0.5 } }, notifiedHash: null, judgedAt: "2026-10-24T01:20:00.000Z" } }),
  );
  const judge = fakeJudge([
    { choice: null, confidence: 0.2, probabilities: { count: 0.5, skip: 0.5 }, fallback: "low-confidence" },
    { choice: "count", confidence: 0.9, probabilities: { count: 0.9, skip: 0.1 }, fallback: null },
    { choice: "skip", confidence: 0.9, probabilities: { count: 0.1, skip: 0.9 }, fallback: null },
  ]);
  const outcome = await run({ now, dir, judge, notifyImpl: () => ({ ok: true }) });
  const cache = readDecisions(path.join(dir, "decisions.json"));
  assert.equal(cache.version, 2);
  assert.equal(Object.keys(cache.splits).length, 2);
  assert.equal(cache.units[unit.key].result.kind, "count");
  assert.equal(cache.units[unit.key].result.split, true);
  assert.equal(outcome.fresh[0].result.kind, "count");
  assert.ok(existsSync(path.join(dir, "decisions.v1.bak.json")));
  assert.equal(judge.calls.length, 3);
});

test("low confidence splits into runs, caches them and writes only the counted ones", async () => {
  const { dir, now } = splitSandbox();
  const judge = fakeJudge([
    { choice: null, confidence: 0.12, probabilities: { count: 0.44, skip: 0.56 }, fallback: "low-confidence" },
    { choice: "count", confidence: 0.78, probabilities: { count: 0.78, skip: 0.22 }, fallback: null },
    { choice: "skip", confidence: 0.86, probabilities: { count: 0.07, skip: 0.93 }, fallback: null },
  ]);
  const outcome = await run({ now, dir, judge, notifyImpl: () => ({ ok: true }) });
  assert.equal(outcome.fresh.length, 1);
  assert.equal(outcome.fresh[0].result.kind, "count");
  assert.equal(outcome.fresh[0].result.split, true);
  assert.equal(outcome.fresh[0].result.runs.length, 2);
  assert.deepEqual(outcome.fresh[0].result.runs.map((item) => item.kind), ["count", "skip"]);

  const again = fakeJudge([]);
  const round = await run({ now: now + 30 * MINUTE, dir, judge: again, notifyImpl: () => ({ ok: true }) });
  assert.equal(again.calls.length, 0);
  assert.equal(round.fresh.length, 0);
});

test("a pending verdict turns into a verdict once and is not re-announced while pending", async () => {
  const { dir, now } = sandbox();
  const timeoutJudge = fakeJudge([{ choice: null, confidence: null, probabilities: null, fallback: "timeout" }]);
  const first = await run({ now, dir, judge: timeoutJudge, notifyImpl: () => ({ ok: true }) });
  assert.equal(first.fresh[0].result.kind, "review");
  assert.equal(first.fresh[0].result.reason, "timeout");

  const stillDown = fakeJudge([{ choice: null, confidence: null, probabilities: null, fallback: "timeout" }]);
  const second = await run({ now: now + 30 * MINUTE, dir, judge: stillDown, notifyImpl: () => ({ ok: true }) });
  assert.equal(stillDown.calls.length, 1);
  assert.equal(second.fresh.length, 0);

  const back = fakeJudge([{ choice: "count", confidence: 0.9, probabilities: { count: 0.9, skip: 0.1 }, fallback: null }]);
  const third = await run({ now: now + 60 * MINUTE, dir, judge: back, notifyImpl: () => ({ ok: true }) });
  assert.equal(third.fresh.length, 1);
  assert.equal(third.fresh[0].result.kind, "count");
});

test("a pending run inside a split unit keeps the settled runs and retries only the open one", async () => {
  const { dir, now } = splitSandbox();
  const judge = fakeJudge([
    { choice: null, confidence: 0.12, probabilities: { count: 0.44, skip: 0.56 }, fallback: "low-confidence" },
    { choice: "count", confidence: 0.9, probabilities: { count: 0.9, skip: 0.1 }, fallback: null },
    { choice: null, confidence: null, probabilities: null, fallback: "circuit" },
  ]);
  const outcome = await run({ now, dir, judge, notifyImpl: () => ({ ok: true }) });
  const result = outcome.fresh[0].result;
  assert.equal(result.kind, "count");
  assert.equal(result.reason, "partial");
  assert.deepEqual(result.runs.map((item) => item.kind), ["count", "review"]);

  const cache = readDecisions(path.join(dir, "decisions.json"));
  assert.equal(Object.keys(cache.splits).length, 1);
  const retry = fakeJudge([{ choice: "skip", confidence: 0.9, probabilities: { count: 0.1, skip: 0.9 }, fallback: null }]);
  await run({ now: now + 30 * MINUTE, dir, judge: retry, notifyImpl: () => ({ ok: true }) });
  assert.equal(retry.calls.length, 1);
});

test("the judge quota counts every split call", async () => {
  const { dir, now } = splitSandbox();
  writeFileSync(path.join(dir, "config.json"), JSON.stringify({ maxJudgeCallsPerRun: 2 }));
  const judge = fakeJudge([
    { choice: null, confidence: 0.12, probabilities: { count: 0.44, skip: 0.56 }, fallback: "low-confidence" },
    { choice: "count", confidence: 0.9, probabilities: { count: 0.9, skip: 0.1 }, fallback: null },
    { choice: "count", confidence: 0.9, probabilities: { count: 0.9, skip: 0.1 }, fallback: null },
  ]);
  await run({ now, dir, judge, notifyImpl: () => ({ ok: true }) });
  const round = readEvents(dir).filter((event) => event.event === "round").pop();
  assert.equal(round.calls, 2);
});

test("a single run unit with low confidence keeps its reason, caches it and is not re-judged", async () => {
  const { dir, now } = singleSandbox();
  const single = fakeJudge([{ choice: null, confidence: 0.12, probabilities: { count: 0.44, skip: 0.56 }, fallback: "low-confidence" }]);
  const first = await run({ now, dir, judge: single, notifyImpl: () => ({ ok: true }) });
  assert.equal(first.fresh[0].result.kind, "review");
  assert.equal(first.fresh[0].result.reason, "low-confidence");
  assert.equal(single.calls.length, 1);
  const cache = readDecisions(path.join(dir, "decisions.json"));
  assert.equal(Object.keys(cache.splits).length, 0);

  const again = fakeJudge([]);
  await run({ now: now + 30 * MINUTE, dir, judge: again, notifyImpl: () => ({ ok: true }) });
  assert.equal(again.calls.length, 0);
});

test("plan operations free space before creating finer segments", () => {
  const plan = {
    remove: ["stale"],
    patch: [{ id: "coarse", start: 0, end: 5 * MINUTE }],
    create: [
      { start: 6 * MINUTE, end: 10 * MINUTE },
      { start: 11 * MINUTE, end: 15 * MINUTE },
    ],
  };
  const ops = planOperations(plan, { budget: 10 });
  assert.deepEqual(ops.map((op) => op.op), ["remove", "patch", "create", "create"]);
  assert.deepEqual(planOperations(plan, { budget: 2 }).map((op) => op.op), ["remove", "patch"]);
});

test("human coverage keeps only foreign periods of the same activity", () => {
  const periods = [
    { id: "own", activityId: "activity_work_001", start: 0, end: 10 * MINUTE },
    { id: "user", activityId: "activity_work_001", start: 20 * MINUTE, end: 30 * MINUTE },
    { id: "break", activityId: "activity_break_001", start: 40 * MINUTE, end: 50 * MINUTE },
  ];
  const covered = humanCoverage(periods, { ownIds: new Set(["own"]), activityId: "activity_work_001" });
  assert.deepEqual(covered, [{ start: 20 * MINUTE, end: 30 * MINUTE }]);
});

function openRec(startedAt, sessionId = "s1") {
  return {
    v: 1,
    kind: "open",
    id: `${sessionId}:${startedAt}`,
    sessionId,
    sessionFile: "/s/x.jsonl",
    source: "interactive",
    startedAt,
  };
}

function addOpen(dir, record) {
  appendFileSync(path.join(dir, "ledger", `${record.sessionId}.jsonl`), `${JSON.stringify(record)}\n`);
}

function readRoundEvents(dir, day = "2026-10-24") {
  const file = path.join(dir, "logs", `${day}.jsonl`);
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((event) => event.event === "round");
}

test("settle rides on gapMinutes: 14:59 waits, 15:00 releases", async () => {
  const { dir } = sandbox();
  const lastEnd = Date.parse("2026-10-24T01:15:00.000Z");
  const early = fakeJudge([{ choice: "count", confidence: 0.9, probabilities: { count: 0.9, skip: 0.1 }, fallback: null }]);
  const waited = await run({ now: lastEnd + 15 * MINUTE - 1_000, dir, judge: early, notifyImpl: () => ({ ok: true }) });
  assert.equal(waited.units, 0);
  assert.equal(early.calls.length, 0);

  const onTime = fakeJudge([{ choice: "count", confidence: 0.9, probabilities: { count: 0.9, skip: 0.1 }, fallback: null }]);
  const released = await run({ now: lastEnd + 15 * MINUTE, dir, judge: onTime, notifyImpl: () => ({ ok: true }) });
  assert.equal(released.units, 1);
  assert.equal(onTime.calls.length, 1);
});

test("a session with an unclosed open run is skipped and counted as openSkipped", async () => {
  const { dir, now } = sandbox();
  addOpen(dir, openRec("2026-10-24T01:58:00.000Z"));
  const judge = fakeJudge([]);
  const outcome = await run({ now, dir, judge, notifyImpl: () => ({ ok: true }) });
  assert.equal(outcome.units, 0);
  assert.equal(judge.calls.length, 0);
  const rounds = readRoundEvents(dir);
  assert.ok(rounds.at(-1).openSkipped >= 1);
});

test("an open run in one session does not block judgments in another", async () => {
  const { dir, now } = sandbox();
  addOpen(dir, openRec("2026-10-24T01:58:00.000Z", "s1"));
  appendFileSync(
    path.join(dir, "ledger", "s2.jsonl"),
    `${JSON.stringify(rec("2026-10-24T01:00:00.000Z", 5, { sessionId: "s2" }))}\n`,
  );
  const judge = fakeJudge([{ choice: "count", confidence: 0.9, probabilities: { count: 0.9, skip: 0.1 }, fallback: null }]);
  const outcome = await run({ now, dir, judge, notifyImpl: () => ({ ok: true }) });
  assert.equal(outcome.units, 1);
  assert.equal(outcome.fresh.length, 1);
  assert.equal(outcome.fresh[0].unit.sessionId, "s2");
  const rounds = readRoundEvents(dir);
  assert.equal(rounds.at(-1).openSkipped, 1);
});

test("a stale open run older than four hours no longer blocks judgment", async () => {
  const { dir, now } = sandbox();
  const stale = new Date(now - 5 * 60 * MINUTE).toISOString();
  addOpen(dir, openRec(stale));
  const rows = readRecords(path.join(dir, "ledger"), { now });
  assert.equal(rows.filter((row) => row.kind === "open").length, 1);
  assert.equal(readOpenRuns(rows, { now }).size, 0);
  const judge = fakeJudge([{ choice: "count", confidence: 0.9, probabilities: { count: 0.9, skip: 0.1 }, fallback: null }]);
  const outcome = await run({ now, dir, judge, notifyImpl: () => ({ ok: true }) });
  assert.equal(outcome.units, 1);
});

test("one unit is judged exactly once across the open to closed transition", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agent-hours-open-"));
  mkdirSync(path.join(dir, "ledger"), { recursive: true });
  const startedAt = "2026-10-24T01:58:00.000Z";
  const ledgerFile = path.join(dir, "ledger", "s1.jsonl");
  writeFileSync(ledgerFile, `${JSON.stringify(openRec(startedAt))}\n`);

  const whileRunning = fakeJudge([{ choice: "count", confidence: 0.9, probabilities: { count: 0.9, skip: 0.1 }, fallback: null }]);
  const skipped = await run({ now: Date.parse("2026-10-24T02:00:00.000Z"), dir, judge: whileRunning, notifyImpl: () => ({ ok: true }) });
  assert.equal(skipped.units, 0);
  assert.equal(whileRunning.calls.length, 0);

  appendFileSync(ledgerFile, `${JSON.stringify(rec(startedAt, 5))}\n`);
  const settled = fakeJudge([{ choice: "count", confidence: 0.9, probabilities: { count: 0.9, skip: 0.1 }, fallback: null }]);
  const first = await run({ now: Date.parse("2026-10-24T02:18:00.000Z"), dir, judge: settled, notifyImpl: () => ({ ok: true }) });
  assert.equal(first.units, 1);
  assert.equal(settled.calls.length, 1);
  const unitEvents = readEvents(dir).filter((event) => event.event === "unit");
  assert.equal(unitEvents.length, 1);
  assert.equal(unitEvents[0].span[1], "2026-10-24T02:03:00.000Z");

  const before = JSON.parse(readFileSync(path.join(dir, "decisions.json"), "utf8"));
  const again = fakeJudge([]);
  const second = await run({ now: Date.parse("2026-10-24T02:30:00.000Z"), dir, judge: again, notifyImpl: () => ({ ok: true }) });
  assert.equal(second.fresh.length, 0);
  assert.equal(again.calls.length, 0);
  const after = JSON.parse(readFileSync(path.join(dir, "decisions.json"), "utf8"));
  assert.deepEqual(Object.values(after.units).map((entry) => entry.hash), Object.values(before.units).map((entry) => entry.hash));
});

test("readDayTotal reads today's total from the daily endpoint", async () => {
  const now = Date.parse("2026-10-24T05:00:00.000Z");
  const calls = [];
  const client = {
    async daily(args) {
      calls.push(args);
      return { ok: true, data: [{ date: "2026-10-24", totalDuration: 158 * MINUTE, periodCount: 8 }] };
    },
  };
  const total = await readDayTotal(client, { now, tz: "Asia/Shanghai" });
  assert.deepEqual(total, { minutes: 158, segments: 8 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tz, "Asia/Shanghai");

  const empty = { async daily() { return { ok: true, data: [{ date: "2026-10-23", totalDuration: 10 * MINUTE, periodCount: 1 }] }; } };
  assert.deepEqual(await readDayTotal(empty, { now, tz: "Asia/Shanghai" }), { minutes: 0, segments: 0 });

  const broken = { async daily() { return { ok: false, code: "server" }; } };
  assert.equal(await readDayTotal(broken, { now, tz: "Asia/Shanghai" }), null);
});

test("the report leads with today's total and this round's delta", () => {
  const now = Date.parse("2026-10-24T05:00:00.000Z");
  const fresh = [{ unit: buildUnits([rec("2026-10-24T01:00:00.000Z", 5)])[0], result: { kind: "count" } }];
  const report = formatReport(fresh, {
    tz: "Asia/Shanghai",
    now,
    clock: { minutes: 158, created: 2, patched: 5, deleted: 0 },
    today: { before: { minutes: 122, segments: 6 }, after: { minutes: 158, segments: 8 } },
  });
  assert.match(report, /今日累计 2\.6 小时（8 段）/);
  assert.match(report, /本轮 \+36 分钟/);
  assert.doesNotMatch(report, /计入时长/);

  const dropped = formatReport(fresh, {
    tz: "Asia/Shanghai",
    now,
    clock: { minutes: 158, created: 0, patched: 1, deleted: 0 },
    today: { before: { minutes: 158, segments: 8 }, after: { minutes: 146, segments: 7 } },
  });
  assert.match(dropped, /本轮 −12 分钟/);

  const flat = formatReport(fresh, {
    tz: "Asia/Shanghai",
    now,
    clock: { minutes: 158, created: 0, patched: 0, deleted: 0 },
    today: { before: { minutes: 158, segments: 8 }, after: { minutes: 158, segments: 8 } },
  });
  assert.match(flat, /本轮 ±0 分钟/);

  const noClock = formatReport(fresh, { tz: "Asia/Shanghai", now });
  assert.doesNotMatch(noClock, /今日累计/);
  assert.match(noClock, /计入时长/);
  assert.equal(formatDelta(-12), "−12 分钟");
});

test("TC-S1 a salvaged record wins once the real closing record arrives", () => {
  const sameId = "fs-th-demo:2026-10-26T07:10:00.000Z";
  const salvaged = { id: sameId, sessionId: "fs-th-demo", startedAt: "2026-10-26T07:10:00.000Z", durationMs: 10 * MINUTE, userText: "做事", aborted: false, salvaged: true };
  const real = { ...salvaged, durationMs: 70 * MINUTE, salvaged: undefined };
  assert.deepEqual(dedupeRuns([salvaged, real]).map((record) => record.durationMs), [70 * MINUTE]);
  assert.deepEqual(dedupeRuns([real, salvaged]).map((record) => record.durationMs), [70 * MINUTE]);
  assert.deepEqual(dedupeRuns([salvaged]).map((record) => record.durationMs), [10 * MINUTE]);
  assert.equal(dedupeRuns([salvaged, real]).length, 1);
});

test("TC-S2 a stalled run counts, a plain aborted run does not", () => {
  const base = { sessionId: "fs-th-demo", startedAt: "2026-10-26T07:10:00.000Z", durationMs: 10 * MINUTE, userText: "做事", output: "" };
  const stalled = { ...base, id: "a", aborted: true, stalled: true };
  const aborted = { ...base, id: "b", startedAt: "2026-10-26T08:10:00.000Z", aborted: true };
  const units = buildUnits([stalled, aborted], { gapMs: 15 * MINUTE });
  assert.equal(units.length, 1);
  assert.equal(units[0].runs.length, 1);
  assert.equal(units[0].runs[0].startedAt, Date.parse(stalled.startedAt));
});

function tempRepo() {
  const root = mkdtempSync(path.join(os.tmpdir(), "agent-hours-repo-"));
  const repo = path.join(root, "repo");
  mkdirSync(path.join(repo, "src"), { recursive: true });
  mkdirSync(path.join(repo, ".git"));
  return { root, repo, file: path.join(repo, "src", "a.mjs") };
}

test("repoRoot walks up to .git and caches the answer per directory", () => {
  const { root, repo, file } = tempRepo();
  assert.equal(repoRoot(path.dirname(file)), repo);
  rmSync(path.join(repo, ".git"), { recursive: true, force: true });
  assert.equal(repoRoot(path.dirname(file)), repo);
  assert.equal(repoRoot(root), null);
});

test("reposOf dedupes repositories from touched paths and falls back to cwd", () => {
  const first = tempRepo();
  const second = tempRepo();
  assert.deepEqual(reposOf([first.file, second.file, first.file], ""), [first.repo, second.repo]);
  assert.deepEqual(reposOf([], first.repo), [first.repo]);
  assert.deepEqual(reposOf(["/tmp/no-repo-here/a.mjs"], ""), []);
});

test("sessionContext renders name, repos, paths and source without a working-directory line", () => {
  const { repo, file } = tempRepo();
  const context = sessionContext({ sessionName: "修复 dry-run", cwd: "/home/someone", paths: [file], source: "relay" });
  assert.ok(context.startsWith("【会话上下文】\n"));
  assert.ok(context.includes("会话名：修复 dry-run"));
  assert.ok(context.includes(`涉及仓库：${repo}`));
  assert.ok(context.includes(`涉及路径：${file}`));
  assert.equal(context.includes("工作目录"), false);
  assert.equal(context.includes("来源"), false);
  assert.equal(sessionContext({}), "");
  assert.equal(sessionContext({ sessionName: "只有名字" }), "【会话上下文】\n会话名：只有名字");
});

test("sessionContext drops paths before exceeding the 400 character budget", () => {
  const context = sessionContext({
    sessionName: "名".repeat(60),
    paths: ["/tmp/路径".concat("长".repeat(150)), "/tmp/另一条".concat("多".repeat(150)), "/tmp/第三条".concat("字".repeat(150))],
    source: "relay",
  });
  assert.ok(context.length <= 400, `context was ${context.length}`);
  assert.equal(context.includes("涉及路径"), false);
});

test("hydrateContext backfills cwd and session name from the session file", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agent-hours-session-"));
  const file = path.join(dir, "s.jsonl");
  writeFileSync(
    file,
    [
      JSON.stringify({ type: "session", version: 3, id: "s", timestamp: "2026-10-27T10:00:00.000Z", cwd: "/tmp/agent-hours-session-cwd" }),
      JSON.stringify({ type: "session_info", id: "x", timestamp: "2026-10-27T10:01:00.000Z", name: "修复 dry-run 跳过账本" }),
    ].join("\n"),
  );
  const hydrated = hydrateContext({ sessionFile: file, userText: "按 1 修" });
  assert.equal(hydrated.cwd, "/tmp/agent-hours-session-cwd");
  assert.equal(hydrated.sessionName, "修复 dry-run 跳过账本");
  assert.equal(hydrated.userText, "按 1 修");
  assert.deepEqual(hydrateContext({ sessionFile: path.join(dir, "missing.jsonl"), userText: "x" }), { sessionFile: path.join(dir, "missing.jsonl"), userText: "x" });
  assert.deepEqual(hydrateContext({ cwd: "/kept", sessionName: "kept" }), { cwd: "/kept", sessionName: "kept" });
});

test("unit state appends the session context and keeps the hashed part unchanged", () => {
  const { file } = tempRepo();
  const records = [rec("2026-10-24T01:00:00.000Z", 5, { paths: [file], sessionName: "修复 dry-run" })];
  const [unit] = buildUnits(records);
  const state = unitState(unit);
  assert.ok(state.includes("\n\n【会话上下文】\n会话名：修复 dry-run"));
  assert.equal(state.includes("来源："), false);
  const bare = buildUnits([rec("2026-10-24T01:00:00.000Z", 5)])[0];
  assert.equal(unitState(bare).includes("会话名"), false);
  assert.equal(unitHash(unit), unitHash(bare));
});
