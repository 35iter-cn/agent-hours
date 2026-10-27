#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { buildPlan, CLOCK_DEFAULTS, dayKey, groupByDay, pruneMissing, pruneSynced } from "./clock.mjs";
import { createClockClient, pickActivity } from "./clock-client.mjs";

const HOME = process.env.HOME ?? homedir();
const ROOT = dirname(fileURLToPath(import.meta.url));
const BUN_BIN = process.env.AGENT_HOURS_BUN ?? (typeof Bun !== "undefined" ? process.execPath : "bun");
const NOTIFY_CHUNK_CHARS = 2400;
const CFG_DIR = join(HOME, ".config/agent-hours");
const LEDGER_DIR = join(CFG_DIR, "ledger");
const DECISIONS_FILE = join(CFG_DIR, "decisions.json");
const REVIEW_DIR = join(CFG_DIR, "review");
const DIGEST_DIR = join(CFG_DIR, "digest");
const LOG_DIR = join(HOME, ".config/taskradar/logs/hours");
const RELAY_CONFIG_DIR = process.env.AGENT_RELAY_CONFIG_DIR ?? join(HOME, ".config/agent-relay");
const JEV_ENV = existsSync(join(RELAY_CONFIG_DIR, "jev.env")) ? join(RELAY_CONFIG_DIR, "jev.env") : join(HOME, ".config/taskradar/jev.env");
const CLOCK_ENV = join(HOME, ".config/agent-hours/clock.env");
const RELAY_HOME = process.env.AGENT_RELAY_HOME ?? join(HOME, "code/agent-relay");
const RELAY_ENTRY = join(RELAY_HOME, "src/cli.mjs");

async function loadJudge() {
  const { createJev } = await import(join(RELAY_HOME, "src/judgment/jev.mjs"));
  return createJev({ env: { ...process.env, ...readEnvFile(JEV_ENV) } });
}

export const DEFAULTS = {
  tz: "Asia/Shanghai",
  gapMinutes: 15,
  countMinP: 0.5,
  marginMin: 0.1,
  reviewLongRunHours: 4,
  maxJudgeCallsPerRun: 60,
  notify: { platform: "feishu", enabled: true },
  clock: { ...CLOCK_DEFAULTS },
};

export const LEDGER_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
const ROUND_BUDGET_MS = 10 * 60 * 1000;
const LOCK_STALE_MS = 10 * 60 * 1000;
const USER_TEXT_LIMIT = 1200;
const OUTPUT_LIMIT = 1200;
const DECISIONS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DECISIONS_VERSION = 2;

export const SPLIT_REASONS = new Set(["low-confidence", "low-margin", "no-probability"]);
export const PENDING_REASONS = new Set(["nokey", "circuit", "timeout", "http_429", "http_402", "error"]);
const REQUEST_PREVIEW = 60;
const OUTPUT_PREVIEW = 100;

export const JUDGE_INSTRUCTIONS =
  "判产出物的归属，不判有没有动手、也不判产出量大小。" +
  "计入：改 MagicDoor 仓库的代码或配置、跑它的测试、查它的数据与日志、操作客户内部系统、" +
  "写 MagicDoor 的方案 / 计划 / 评估 / 文档。" +
  "不计入：个人事务、闲聊、只复述上下文或只确认状态；以及自家工具与基建的维护" +
  "（relay、intake loop、工时账本、Pi 插件、taskradar）和环境搭建 / 排障，" +
  "即使这一轮交付了一段能跑的代码或一份文档。" +
  "判定看产出物归谁，不看消息是发给谁、也不看改了几行。";

export const JUDGE_CRITERIA = {
  count: "产出物属于 MagicDoor 客户项目，应当计入工时",
  skip: "产出物不归客户项目：无实质产出、个人事务、闲聊，或自家工具 / 基建维护与环境排障",
};

export function loadConfig(dir = CFG_DIR) {
  const file = join(dir, "config.json");
  if (!existsSync(file)) return { ...DEFAULTS, clock: { ...DEFAULTS.clock } };
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  return {
    ...DEFAULTS,
    ...parsed,
    notify: { ...DEFAULTS.notify, ...(parsed.notify ?? {}) },
    clock: { ...DEFAULTS.clock, ...(parsed.clock ?? {}) },
  };
}

export function readRecords(dir = LEDGER_DIR, { now = Date.now(), windowMs = LEDGER_WINDOW_MS } = {}) {
  if (!existsSync(dir)) return [];
  const records = [];
  for (const name of readdirSync(dir).filter((entry) => entry.endsWith(".jsonl"))) {
    const file = join(dir, name);
    if (now - statSync(file).mtimeMs > windowMs) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        if (Number.isNaN(Date.parse(record.startedAt))) continue;
        records.push(record);
      } catch {
        continue;
      }
    }
  }
  return records;
}

export function readLedger(dir = LEDGER_DIR, options = {}) {
  return dedupeRuns(readRecords(dir, options).filter((record) => !record.kind));
}

export function dedupeRuns(records) {
  const byId = new Map();
  for (const record of records) {
    const key = record.id ?? `${record.sessionId}:${record.startedAt}`;
    const current = byId.get(key);
    if (!current) {
      byId.set(key, record);
      continue;
    }
    byId.set(key, preferRun(current, record));
  }
  return [...byId.values()];
}

function preferRun(a, b) {
  if (Boolean(a.salvaged) !== Boolean(b.salvaged)) return a.salvaged ? b : a;
  return (Number(b.durationMs) || 0) > (Number(a.durationMs) || 0) ? b : a;
}

export const OPEN_STALE_MS = 4 * 60 * 60 * 1000;

export function readOpenRuns(records, { now = Date.now() } = {}) {
  const closed = new Set(records.filter((record) => record.kind !== "open").map((record) => record.id));
  const sessions = new Set();
  for (const record of records) {
    if (record.kind !== "open") continue;
    if (closed.has(record.id)) continue;
    const startedAt = Date.parse(record.startedAt);
    if (!Number.isFinite(startedAt) || now - startedAt > OPEN_STALE_MS) continue;
    sessions.add(record.sessionId);
  }
  return sessions;
}

export function buildUnits(records, { gapMs = DEFAULTS.gapMinutes * 60_000 } = {}) {
  const bySession = new Map();
  for (const record of records) {
    if (record.source === "automation") continue;
    if (record.aborted && !record.stalled) continue;
    if (!String(record.userText ?? "").trim()) continue;
    const startedAt = Date.parse(record.startedAt);
    if (Number.isNaN(startedAt)) continue;
    const run = { startedAt, durationMs: Number(record.durationMs) || 0, userText: record.userText, output: record.output ?? "", source: record.source ?? null };
    run.endedAt = startedAt + run.durationMs;
    const bucket = bySession.get(record.sessionId) ?? [];
    bucket.push(run);
    bySession.set(record.sessionId, bucket);
  }

  const units = [];
  for (const [sessionId, runs] of bySession) {
    runs.sort((a, b) => a.startedAt - b.startedAt);
    let unit = null;
    for (const run of runs) {
      const gap = unit ? run.startedAt - unit.lastEnd : Infinity;
      if (gap > gapMs) {
        if (unit) units.push(unit);
        unit = { key: `${sessionId}:${new Date(run.startedAt).toISOString()}`, sessionId, startedAt: run.startedAt, lastEnd: run.endedAt, runs: [] };
      }
      unit.runs.push(run);
      unit.lastEnd = Math.max(unit.lastEnd, run.endedAt);
    }
    if (unit) units.push(unit);
  }
  return units.sort((a, b) => b.startedAt - a.startedAt);
}

export function unitState(unit) {
  const requests = unit.runs.map((run) => String(run.userText ?? "").trim()).filter(Boolean).join("\n---\n").slice(0, USER_TEXT_LIMIT);
  const outputs = unit.runs.map((run) => String(run.output ?? "").trim()).filter(Boolean).join("\n---\n").slice(0, OUTPUT_LIMIT);
  return `【用户请求】\n${requests}\n\n【agent 产出】\n${outputs || "(无)"}`;
}

export function unitHash(unit) {
  const requests = unit.runs.map((run) => String(run.userText ?? "")).join("\n\u0000\n");
  const outputs = unit.runs.map((run) => String(run.output ?? "")).join("\n\u0000\n");
  return createHash("sha1").update(`${requests}\u0001${outputs}`).digest("hex").slice(0, 16);
}

export function promptsVersion() {
  return createHash("sha1").update(`${JUDGE_INSTRUCTIONS}\u0000${JSON.stringify(JUDGE_CRITERIA)}`).digest("hex").slice(0, 8);
}

export function runState(run) {
  const request = String(run.userText ?? "").trim().slice(0, USER_TEXT_LIMIT);
  const output = String(run.output ?? "").trim().slice(0, OUTPUT_LIMIT);
  return `【用户请求】\n${request}\n\n【agent 产出】\n${output || "(无)"}`;
}

export function runHash(run) {
  const material = `${promptsVersion()}\u0000${run.userText ?? ""}\u0000${run.output ?? ""}`;
  return createHash("sha1").update(material).digest("hex").slice(0, 16);
}

export function notifiedSig(unit, result) {
  const runs = (result?.runs ?? []).map((item) => `${item.runHash}:${item.kind}:${item.reason ?? ""}`).join("|");
  return createHash("sha1").update(`${unitHash(unit)}\u0000${result?.kind ?? ""}\u0000${result?.reason ?? ""}\u0000${runs}`).digest("hex").slice(0, 16);
}

function overrideResult(cached) {
  return {
    kind: cached.override.kind,
    reason: "override",
    p: cached.result?.p ?? null,
    margin: cached.result?.margin ?? null,
    cached: true,
    overridden: true,
    notifiedSig: cached.notifiedSig ?? null,
    runs: cached.result?.runs ?? null,
    split: cached.result?.split ?? false,
  };
}

export function setOverride({ dir = CFG_DIR, key, kind, note = "", now = Date.now(), tz = DEFAULTS.tz } = {}) {
  if (kind !== "count" && kind !== "skip") throw new Error(`override kind must be count or skip, got ${kind}`);
  const file = join(dir, "decisions.json");
  const cache = readDecisions(file);
  const entry = cache.units[key];
  if (!entry) throw new Error(`unknown unit: ${key}`);
  entry.override = { kind, note: String(note).trim(), at: new Date(now).toISOString() };
  entry.notifiedSig = null;
  writeDecisions(file, cache);
  appendEvent(
    { event: "override", key, kind, note: entry.override.note, previous: entry.result?.kind ?? null, previousReason: entry.result?.reason ?? null },
    { dir: join(dir, "logs"), now, tz },
  );
  return entry;
}

export function clearOverride({ dir = CFG_DIR, key, now = Date.now(), tz = DEFAULTS.tz } = {}) {
  const file = join(dir, "decisions.json");
  const cache = readDecisions(file);
  const entry = cache.units[key];
  if (!entry?.override) return null;
  const removed = entry.override;
  delete entry.override;
  delete entry.hash;
  delete entry.result?.runs;
  entry.notifiedSig = null;
  writeDecisions(file, cache);
  appendEvent({ event: "override_cleared", key, kind: removed.kind, note: removed.note }, { dir: join(dir, "logs"), now, tz });
  return removed;
}

export function listReviews({ dir = CFG_DIR } = {}) {
  const reviewDir = join(dir, "review");
  if (!existsSync(reviewDir)) return [];
  const file = join(dir, "decisions.json");
  const cache = readDecisions(file);
  const latest = new Map();
  for (const name of readdirSync(reviewDir).filter((entry) => entry.endsWith(".jsonl")).sort()) {
    for (const line of readFileSync(join(reviewDir, name), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const item = JSON.parse(line);
        latest.set(item.key, { ...item, day: name.slice(0, -6) });
      } catch {
        continue;
      }
    }
  }
  return [...latest.values()].map((item) => ({
    key: item.key,
    day: item.day,
    reason: item.reason,
    p: item.p ?? null,
    span: item.span ?? null,
    requests: item.requests ?? [],
    override: cache.units[item.key]?.override?.kind ?? null,
    current: cache.units[item.key]?.result?.kind ?? null,
    split: cache.units[item.key]?.result?.runs ?? null,
  }));
}

export function readDecisions(file) {
  if (!existsSync(file)) return { version: DECISIONS_VERSION, units: {}, splits: {} };
  let parsed = null;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { version: DECISIONS_VERSION, units: {}, splits: {} };
  }
  if (!parsed || typeof parsed !== "object") return { version: DECISIONS_VERSION, units: {}, splits: {} };
  if (parsed.version) return { version: DECISIONS_VERSION, units: parsed.units ?? {}, splits: parsed.splits ?? {} };
  return { version: DECISIONS_VERSION, units: parsed, splits: {} };
}

export function writeDecisions(file, cache) {
  if (existsSync(file)) {
    const backup = file.replace(/\.json$/, ".v1.bak.json");
    try {
      const current = JSON.parse(readFileSync(file, "utf8"));
      if (!current?.version && !existsSync(backup)) writeFileSync(backup, `${JSON.stringify(current, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    } catch {
      // 保留损坏文件，不覆盖备份
    }
  }
  writeJsonAtomic(file, { version: DECISIONS_VERSION, units: cache.units ?? {}, splits: cache.splits ?? {} });
}

export function verdictToResult(verdict, cfg = DEFAULTS) {
  const probabilities = verdict.probabilities ?? null;
  const count = probabilities?.count;
  const skip = probabilities?.skip;
  const margin = typeof count === "number" && typeof skip === "number" ? Math.abs(count - skip) : null;
  const meta = { p: probabilities, margin, confidence: verdict.confidence ?? null, attempts: verdict.attempts ?? null, elapsedMs: verdict.elapsedMs ?? null };
  if (verdict.fallback) return { kind: "review", reason: verdict.fallback, cached: false, ...meta };
  if (typeof count !== "number" || margin === null) return { kind: "review", reason: "no-probability", cached: false, ...meta };
  if (margin < cfg.marginMin) return { kind: "review", reason: "low-margin", cached: false, ...meta };
  return { kind: count >= cfg.countMinP ? "count" : "skip", reason: null, cached: false, ...meta };
}

export function isPending(result) {
  return Boolean(result) && result.kind === "review" && PENDING_REASONS.has(result.reason);
}

export function hasOpenRun(result) {
  return Boolean(result?.runs?.some((item) => item.kind === "review" && PENDING_REASONS.has(item.reason)));
}

export function aggregateSplit(unit, runs) {
  const counted = runs.filter((item) => item.kind === "count").length;
  const unsettled = runs.some((item) => item.kind === "review");
  if (counted === 0) return { kind: unsettled ? "review" : "skip", reason: unsettled ? "pending" : null, split: true };
  return { kind: "count", reason: unsettled ? "partial" : null, split: true };
}

async function splitUnit(unit, { judge, cfg, splits, calls, now, maxCalls }) {
  const runs = [];
  for (const run of unit.runs) {
    const key = runHash(run);
    const cached = splits[key];
    if (cached) {
      runs.push({ runHash: key, kind: cached.kind, reason: cached.reason ?? null, start: run.startedAt, end: run.endedAt });
      continue;
    }
    if (calls.n >= maxCalls) {
      runs.push({ runHash: key, kind: "review", reason: "deferred", start: run.startedAt, end: run.endedAt });
      continue;
    }
    calls.n += 1;
    const verdict = await judge.judgeChoice({
      id: `hours:run:${key}`,
      state: runState(run),
      instructions: JUDGE_INSTRUCTIONS,
      criteria: JUDGE_CRITERIA,
    });
    const result = verdictToResult(verdict, cfg);
    if (!(result.kind === "review" && PENDING_REASONS.has(result.reason))) {
      splits[key] = {
        kind: result.kind,
        reason: result.reason ?? null,
        p: result.p ?? null,
        margin: result.margin ?? null,
        confidence: result.confidence ?? null,
        judgedAt: new Date(now).toISOString(),
      };
    }
    runs.push({ runHash: key, kind: result.kind, reason: result.reason ?? null, start: run.startedAt, end: run.endedAt });
  }
  return runs;
}

export async function decideUnit(unit, { judge, cfg = DEFAULTS, now = Date.now(), cache = {}, calls = { n: 0 } } = {}) {
  const units = cache.units ?? cache;
  const splits = cache.splits ?? {};
  const hash = unitHash(unit);
  const cached = units[unit.key];
  if (cached?.override) return overrideResult(cached);
  const splittable = unit.runs.length > 1;
  const needsSplit = splittable && cached && SPLIT_REASONS.has(cached.result?.reason) && !cached.result?.runs;
  const reopen = cached && cached.hash === hash && !needsSplit && hasOpenRun(cached.result);
  if (cached && cached.hash === hash && !needsSplit && !reopen && !isPending(cached.result)) {
    return { ...cached.result, cached: true, notifiedSig: cached.notifiedSig ?? null };
  }

  if (reopen) {
    const runs = await splitUnit(unit, { judge, cfg, splits, calls, now, maxCalls: cfg.maxJudgeCallsPerRun });
    return {
      ...aggregateSplit(unit, runs),
      p: cached.result.p,
      margin: cached.result.margin,
      confidence: cached.result.confidence,
      attempts: cached.result.attempts,
      elapsedMs: cached.result.elapsedMs,
      cached: false,
      runs,
    };
  }

  const longest = unit.runs.reduce((max, run) => Math.max(max, run.durationMs), 0);
  if (longest >= cfg.reviewLongRunHours * 3600 * 1000) {
    return { kind: "review", reason: "long-run", p: null, margin: null, cached: false, confidence: null, attempts: null, elapsedMs: null, runs: null };
  }

  calls.n += 1;
  const verdict = await judge.judgeChoice({
    id: `hours:${unit.key}`,
    state: unitState(unit),
    instructions: JUDGE_INSTRUCTIONS,
    criteria: JUDGE_CRITERIA,
  });
  const result = verdictToResult(verdict, cfg);
  if (result.kind !== "review" || !SPLIT_REASONS.has(result.reason) || !splittable) return { ...result, runs: null };

  const runs = await splitUnit(unit, { judge, cfg, splits, calls, now, maxCalls: cfg.maxJudgeCallsPerRun });
  const aggregate = aggregateSplit(unit, runs);
  return { ...aggregate, p: result.p, margin: result.margin, confidence: result.confidence, attempts: result.attempts, elapsedMs: result.elapsedMs, cached: false, runs };
}

export function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, file);
}

export function pruneDecisions(cache, { now = Date.now(), ttlMs = DECISIONS_TTL_MS } = {}) {
  const units = {};
  for (const [key, entry] of Object.entries(cache.units ?? {})) {
    const judgedAt = Date.parse(entry.judgedAt ?? "");
    if (Number.isNaN(judgedAt) || now - judgedAt <= ttlMs) units[key] = entry;
  }
  const splits = {};
  for (const [key, entry] of Object.entries(cache.splits ?? {})) {
    const judgedAt = Date.parse(entry.judgedAt ?? "");
    if (Number.isNaN(judgedAt) || now - judgedAt <= ttlMs) splits[key] = entry;
  }
  return { version: DECISIONS_VERSION, units, splits };
}

export function formatClock(ms, tz) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(ms));
  const pick = (type) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${pick("hour")}:${pick("minute")}`;
}

export function formatDay(ms, tz) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(ms));
  const pick = (type) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
}

function preview(text, limit) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

const BADGE = { count: "计入", skip: "不计", review: "待确认" };

export function formatDuration(minutes) {
  const total = Math.max(0, Math.round(Number(minutes) || 0));
  if (total < 60) return `${total} 分钟`;
  const hours = Math.round((total / 60) * 10) / 10;
  return `${hours.toFixed(1).replace(/\.0$/, "")} 小时`;
}

export function formatDelta(minutes) {
  const total = Math.round(Number(minutes) || 0);
  if (total === 0) return "±0 分钟";
  return total > 0 ? `+${formatDuration(total)}` : `−${formatDuration(-total)}`;
}

export function formatEntry(unit, result, { tz }) {
  const span = `${formatClock(unit.startedAt, tz)}–${formatClock(unit.lastEnd, tz)}`;
  const head = `${BADGE[result.kind]} ${span} · ${formatDuration((unit.lastEnd - unit.startedAt) / 60_000)} · ${unit.runs.length} 轮 · ${unit.sessionId.slice(0, 18)}`;
  const prob = result.p ? ` · p=${Number(result.p.count).toFixed(2)}` : "";
  const reason = result.kind === "review" ? ` · ${result.reason}` : "";
  const last = unit.runs.at(-1);
  const lines = [`${head}${prob}${reason}`];
  lines.push(`  问：${preview(last.userText, REQUEST_PREVIEW)}`);
  if (String(last.output ?? "").trim()) lines.push(`  答：${preview(last.output, OUTPUT_PREVIEW)}`);
  return lines.join("\n");
}

export function formatReport(fresh, { tz, now = Date.now(), clock = null, today = null } = {}) {
  if (!fresh.length && !clock) return "";
  const counts = fresh.reduce((acc, item) => {
    acc[item.result.kind] = (acc[item.result.kind] ?? 0) + 1;
    return acc;
  }, {});
  const splitCount = fresh.filter((item) => item.result.split).length;
  const countedMinutes = typeof clock?.minutes === "number"
    ? clock.minutes
    : fresh
      .filter((item) => item.result.kind === "count")
      .reduce((sum, item) => {
        const runs = item.result.split
          ? item.unit.runs.filter((run, index) => item.result.runs?.[index]?.kind === "count")
          : item.unit.runs;
        return sum + runs.reduce((inner, run) => inner + run.durationMs / 60_000, 0);
      }, 0);
  const lines = [`**工时** ${formatDay(now, tz)} ${formatClock(now, tz)}`];
  const after = today?.after ?? null;
  const before = today?.before ?? null;
  if (after) {
    lines.push(`今日累计 ${formatDuration(after.minutes)}（${after.segments} 段）`);
    if (before) lines.push(`本轮 ${formatDelta(after.minutes - before.minutes)}`);
  }
  if (fresh.length) {
    lines.push(`新增 ${fresh.length} 单元 · 计入 ${counts.count ?? 0} · 不计 ${counts.skip ?? 0}${counts.review ? ` · 待确认 ${counts.review}` : ""}${splitCount ? ` · 拆分 ${splitCount}` : ""}`);
  } else {
    lines.push("本轮无新增单元");
  }
  if (!after && fresh.length) lines.push(`计入时长 ${formatDuration(countedMinutes)}`);
  if (clock) {
    const bits = [];
    if (clock.created) bits.push(`新增 ${clock.created} 段`);
    if (clock.patched) bits.push(`改 ${clock.patched} 段`);
    if (clock.deleted) bits.push(`删 ${clock.deleted} 段`);
    if (clock.covered) bits.push(`人工已记 ${formatDuration(clock.coveredMinutes)}`);
    if (clock.conflict) bits.push(`冲突 ${formatDuration(clock.conflictMinutes)}`);
    if (clock.failed) bits.push(`失败 ${clock.failed}`);
    if (clock.blocked?.length) bits.push(`超限跳过 ${clock.blocked.length} 天`);
    if (bits.length) lines.push(`Clock ${bits.join(" · ")}`);
  }
  return lines.join("\n");
}

function notifyFeishu(text, { platform }) {
  const chunks = chunkMessage(text);
  const results = chunks.map((chunk) =>
    spawnSync(BUN_BIN, [RELAY_ENTRY, "notice", "emit", "--platform", platform, "--text", chunk], { encoding: "utf8", timeout: 30_000 }),
  );
  const failed = results.find((result) => result.status !== 0);
  return {
    ok: !failed,
    chunks: chunks.length,
    output: failed ? `${failed.stdout ?? ""}${failed.stderr ?? ""}`.trim() : "",
  };
}

export function chunkMessage(text, limit = NOTIFY_CHUNK_CHARS) {
  const blocks = String(text ?? "").split("\n\n");
  const chunks = [];
  let buffer = "";
  for (const block of blocks) {
    if (buffer && buffer.length + block.length + 2 > limit) {
      chunks.push(buffer);
      buffer = block;
    } else {
      buffer = buffer ? `${buffer}\n\n${block}` : block;
    }
    while (buffer.length > limit) {
      chunks.push(buffer.slice(0, limit));
      buffer = buffer.slice(limit);
    }
  }
  if (buffer) chunks.push(buffer);
  return chunks.length ? chunks : [];
}

export function acquireLock(file, { now = Date.now(), staleMs = LOCK_STALE_MS, pid = process.pid } = {}) {
  mkdirSync(dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(file, JSON.stringify({ pid, ts: now }), { flag: "wx", mode: 0o600 });
      return () => rmSync(file, { force: true });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const held = readLock(file);
      if (held && isAlive(held.pid) && now - held.ts <= staleMs) return null;
      rmSync(file, { force: true });
    }
  }
  return null;
}

function readLock(file) {
  try {
    const held = JSON.parse(readFileSync(file, "utf8"));
    return typeof held?.ts === "number" ? held : null;
  } catch {
    return null;
  }
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function appendDigest(line, { dir = CFG_DIR, now, tz }) {
  const digestDir = join(dir, "digest");
  mkdirSync(digestDir, { recursive: true });
  appendFileSync(join(digestDir, `${formatDay(now, tz)}.md`), `${line}\n`);
}

function appendEvent(record, { dir = LOG_DIR, now, tz } = {}) {
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, `${formatDay(now, tz)}.jsonl`), `${JSON.stringify({ ts: new Date(now).toISOString(), ...record })}\n`);
}

function reviewSummary(unit) {
  return {
    requests: unit.runs.map((run) => preview(run.userText, 200)),
    outputs: unit.runs.map((run) => preview(run.output, 200)),
  };
}

function appendReview(day, payload, { dir = CFG_DIR } = {}) {
  const reviewDir = join(dir, "review");
  mkdirSync(reviewDir, { recursive: true });
  appendFileSync(join(reviewDir, `${day}.jsonl`), `${JSON.stringify(payload)}\n`);
}

function readEnvFile(file) {
  const out = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) out[match[1]] = match[2].trim();
  }
  return out;
}

export async function run({
  now = Date.now(),
  dir = CFG_DIR,
  judge = null,
  dryRun = false,
  notify = true,
  notifyImpl = notifyFeishu,
  logDir = join(dir, "logs"),
  budgetMs = ROUND_BUDGET_MS,
  dryRunClock = false,
  clockClient = null,
  log = (line) => process.stderr.write(`${line}\n`),
} = {}) {
  const cfg = loadConfig(dir);
  const decisionsFile = join(dir, "decisions.json");
  const cache = readDecisions(decisionsFile);
  const engine = judge ?? (await loadJudge());

  const windowStart = now - LEDGER_WINDOW_MS;
  const rows = readRecords(join(dir, "ledger"), { now });
  const closedRows = rows.filter((row) => !row.kind);
  const openSessions = readOpenRuns(rows, { now });
  const allUnits = buildUnits(closedRows);
  const candidates = allUnits
    .filter((unit) => unit.lastEnd >= windowStart)
    .filter((unit) => now - unit.lastEnd >= cfg.gapMinutes * 60_000 && !openSessions.has(unit.sessionId));
  const openSkipped = allUnits.filter((unit) => unit.lastEnd >= windowStart && openSessions.has(unit.sessionId)).length;
  const units = candidates;
  const roundStartedAt = Date.now();
  const needsJudge = (unit) => {
    const cached = cache.units[unit.key];
    if (cached?.override) return false;
    if (!cached || cached.hash !== unitHash(unit)) return true;
    if (isPending(cached.result) || hasOpenRun(cached.result)) return true;
    return unit.runs.length > 1 && SPLIT_REASONS.has(cached.result?.reason) && !cached.result?.runs;
  };

  const fresh = [];
  const judged = [];
  let leftover = 0;
  const calls = { n: 0 };
  for (const unit of units) {
    if (needsJudge(unit) && (calls.n >= cfg.maxJudgeCallsPerRun || Date.now() - roundStartedAt >= budgetMs)) {
      leftover += 1;
      log(`[hours] ${unit.key} left for the next round`);
      continue;
    }
    const result = await decideUnit(unit, { judge: engine, cfg, now, cache, calls });
    const previous = cache.units[unit.key];
    const previousSig = previous?.notifiedSig ?? null;
    const hash = unitHash(unit);
    const sig = notifiedSig(unit, result);
    const override = previous?.override ?? null;
    const changed =
      !previous ||
      previous.hash !== hash ||
      previousSig !== sig ||
      (override?.kind ?? null) !== (result.overridden ? result.kind : null);
    if (changed) {
      cache.units[unit.key] = { hash, result, notifiedSig: previousSig, judgedAt: new Date(now).toISOString(), ...(override ? { override } : {}) };
    }
    if (!dryRun && changed) {
      const event = {
        event: "unit",
        key: unit.key,
        session: unit.sessionId,
        source: unit.runs[0]?.source ?? null,
        span: [new Date(unit.startedAt).toISOString(), new Date(unit.lastEnd).toISOString()],
        durationMs: unit.lastEnd - unit.startedAt,
        kind: result.kind,
        reason: result.reason,
        overridden: Boolean(result.overridden),
        p: result.p,
        margin: result.margin,
        confidence: result.confidence ?? null,
        attempts: result.attempts ?? null,
        elapsedMs: result.elapsedMs ?? null,
        review: result.kind === "review",
        split: Boolean(result.split),
        ...(result.runs ? { runs: result.runs.map((item) => ({ runHash: item.runHash, kind: item.kind, reason: item.reason, start: item.start, end: item.end })) } : {}),
        ...(result.kind === "review" ? reviewSummary(unit) : {}),
      };
      appendEvent(event, { dir: logDir, now, tz: cfg.tz });
      if (result.kind === "review") {
        appendReview(formatDay(unit.startedAt, cfg.tz), {
          key: unit.key,
          reason: result.reason,
          span: event.span,
          p: result.p,
          ...reviewSummary(unit),
        }, { dir });
      }
    }
    judged.push({ unit, result });
    if (previousSig !== sig) fresh.push({ unit, result, sig });
  }

  const clockOutcome = await syncClock({ judged, now, cfg, dir, logDir, dryRun, planOnly: dryRunClock, client: clockClient, log });

  const clockSummary = clockOutcome?.summary ?? null;
  const clockChanged = Boolean(clockSummary && (clockSummary.created ?? 0) + (clockSummary.patched ?? 0) + (clockSummary.deleted ?? 0) > 0);
  const report = formatReport(fresh, { tz: cfg.tz, now, clock: clockSummary, today: clockOutcome && clockOutcome.todayAfter ? { before: clockOutcome.todayBefore, after: clockOutcome.todayAfter } : null });
  const worthNotifying = clockSummary ? clockChanged : fresh.length > 0;
  let delivered = false;
  if (!dryRun) {
    writeDecisions(decisionsFile, pruneDecisions(cache, { now }));
    if (report && notify && cfg.notify.enabled && worthNotifying) {
      const sent = notifyImpl(report, { platform: cfg.notify.platform });
      delivered = sent.ok;
      appendEvent({ event: "notify", platform: cfg.notify.platform, ok: sent.ok, chars: report.length, units: fresh.length, ...(sent.ok ? {} : { output: String(sent.output ?? "") }) }, { dir: logDir, now, tz: cfg.tz });
      if (!sent.ok) log(`[error] notify: ${sent.output}`);
      else {
        for (const item of fresh) cache.units[item.unit.key].notifiedSig = item.sig;
        writeDecisions(decisionsFile, pruneDecisions(cache, { now }));
      }
    }
    const counts = fresh.reduce((acc, item) => {
      acc[item.result.kind] = (acc[item.result.kind] ?? 0) + 1;
      return acc;
    }, {});
    const notifyLabel = report ? (delivered ? "已发" : clockChanged ? "未发" : "未发（clock 无变更）") : "无新增";
    appendDigest(
      `- ${formatClock(now, cfg.tz)} 单元 ${candidates.length} / 新增 ${fresh.length}（计入 ${counts.count ?? 0}、不计 ${counts.skip ?? 0}、待确认 ${counts.review ?? 0}）· 飞书 ${notifyLabel}${openSkipped ? ` · 等 open ${openSkipped}` : ""}`,
      { dir, now, tz: cfg.tz },
    );
    appendEvent({ event: "round", units: candidates.length, processed: units.length - leftover, leftover, openSkipped, calls: calls.n, counts, delivered, notified: Boolean(report) && worthNotifying }, { dir: logDir, now, tz: cfg.tz });
    if (clockOutcome?.line) appendDigest(`  - clock：${clockOutcome.line}`, { dir, now, tz: cfg.tz });
  }

  return { units: candidates.length, fresh, report, delivered, cache, clock: clockSummary };
}

export function planOperations(plan, { budget = Infinity } = {}) {
  const ops = [];
  for (const id of plan.remove) ops.push({ op: "remove", id });
  for (const item of plan.patch) ops.push({ op: "patch", id: item.id, start: item.start, end: item.end });
  for (const segment of plan.create) ops.push({ op: "create", segment });
  return ops.slice(0, budget);
}

export function humanCoverage(periods, { ownIds, activityId }) {
  return (periods ?? [])
    .filter((item) => item.activityId === activityId && !ownIds.has(item.id))
    .filter((item) => Number.isFinite(item.start) && Number.isFinite(item.end) && item.end > item.start)
    .map((item) => ({ start: item.start, end: item.end }));
}

export async function readDayTotal(client, { now, tz }) {
  if (!client) return null;
  const res = await client.daily({ start: now - 36 * 3_600_000, end: now + 3_600_000, tz });
  if (!res?.ok) return null;
  const rows = Array.isArray(res.data) ? res.data : (res.data?.days ?? []);
  const today = rows.find((row) => row.date === dayKey(now, tz));
  if (!today) return { minutes: 0, segments: 0 };
  return { minutes: Math.round((today.totalDuration ?? 0) / 60_000), segments: today.periodCount ?? 0 };
}

export async function syncClock({
  judged,
  now,
  cfg,
  dir = CFG_DIR,
  logDir = join(dir, "logs"),
  dryRun = false,
  planOnly = false,
  client = null,
  log = () => {},
}) {
  const clockCfg = { ...CLOCK_DEFAULTS, ...(cfg.clock ?? {}), tz: cfg.tz };
  if (!clockCfg.enabled && !planOnly) return null;

  const syncedFile = join(dir, "synced.json");
  const stored = existsSync(syncedFile) ? JSON.parse(readFileSync(syncedFile, "utf8")) : {};
  const minute = (segment) => Math.round((segment.end - segment.start) / 60_000);
  const iso = (ms) => new Date(ms).toISOString();

  if (dryRun || planOnly) {
    const plan = buildPlan({ judged, now, cfg: clockCfg, synced: stored });
    if (!dryRun) {
      appendEvent(
        {
          event: "clock_plan",
          targets: plan.targets.length,
          create: plan.create.length,
          patch: plan.patch.length,
          remove: plan.remove.length,
          blocked: plan.blocked,
          dropped: plan.dropped,
          plan: { create: plan.create.map((segment) => [iso(segment.start), iso(segment.end)]) },
        },
        { dir: logDir, now, tz: cfg.tz },
      );
    }
    for (const segment of plan.create) log(`[clock] plan ${iso(segment.start)} → ${iso(segment.end)} (${minute(segment)}min)`);
    return {
      summary: { targets: plan.targets.length, minutes: plan.minutes, create: plan.create.length, patch: plan.patch.length, remove: plan.remove.length, created: plan.create.length, patched: plan.patch.length, deleted: plan.remove.length, blocked: plan.blocked, dropped: plan.dropped },
      line: `计划 ${plan.targets.length} 段 / ${formatDuration(plan.minutes)}（新建 ${plan.create.length}、改 ${plan.patch.length}、删 ${plan.remove.length}）`,
    };
  }

  const apiKey = readEnvFile(CLOCK_ENV).CLOCK_API_KEY ?? "";
  if (!apiKey && !client) {
    appendEvent({ event: "clock", action: "error", code: "no-key" }, { dir: logDir, now, tz: cfg.tz });
    log("[error] clock: CLOCK_API_KEY 缺失");
    return { summary: null, line: "未配置 CLOCK_API_KEY" };
  }

  const api = client ?? createClockClient({ baseUrl: clockCfg.baseUrl, apiKey });
  const todayBefore = await readDayTotal(api, { now, tz: clockCfg.tz });
  let activityId = clockCfg.activityId;
  if (!activityId) {
    const listed = await api.activities();
    const activity = listed.ok ? pickActivity(listed.data, { name: clockCfg.activityName }) : null;
    if (!activity) {
      appendEvent({ event: "clock", action: "error", code: "no-activity", name: clockCfg.activityName }, { dir: logDir, now, tz: cfg.tz });
      log(`[error] clock: 找不到名为 ${clockCfg.activityName} 的活动`);
      return { summary: null, line: `找不到活动 ${clockCfg.activityName}` };
    }
    activityId = activity.id;
  }

  const windowFrom = now - (clockCfg.backfillHours + 6) * 3_600_000;
  const live = await fetchLivePeriods(api, { from: windowFrom, to: now + 3_600_000 });
  const liveIds = live ? new Set(live.map((item) => item.id)) : null;
  const { synced, dropped } = liveIds ? pruneMissing(stored, liveIds, { windowFrom }) : { synced: stored, dropped: 0 };
  if (dropped) appendEvent({ event: "clock", action: "forget-missing", dropped }, { dir: logDir, now, tz: cfg.tz });

  const ownIds = new Set(Object.values(stored).flat().map((item) => item.id));
  const coverage = humanCoverage(live ?? [], { ownIds, activityId });
  const plan = buildPlan({ judged, now, cfg: clockCfg, synced, coverage });
  const summary = {
    targets: plan.targets.length,
    minutes: plan.minutes,
    covered: plan.covered.length,
    coveredMinutes: plan.coveredMinutes,
    create: plan.create.length,
    patch: plan.patch.length,
    remove: plan.remove.length,
    conflict: 0,
    conflictMinutes: 0,
    failed: 0,
    dropped,
    blocked: plan.blocked,
  };

  const created = [];
  const patched = [];
  const deleted = [];

  for (const op of planOperations(plan, { budget: clockCfg.maxWritesPerRun })) {
    if (op.op === "remove") {
      const result = await api.remove(op.id);
      if (result.ok) {
        deleted.push(op.id);
        appendEvent({ event: "clock", action: "delete", id: op.id }, { dir: logDir, now, tz: cfg.tz });
        continue;
      }
      summary.failed += 1;
      appendEvent({ event: "clock", action: "delete-failed", id: op.id, code: result.code, status: result.status }, { dir: logDir, now, tz: cfg.tz });
      continue;
    }
    if (op.op === "patch") {
      const result = await api.patch(op.id, { start: op.start, end: op.end });
      if (result.ok) {
        patched.push({ id: op.id, start: op.start, end: op.end });
        appendEvent({ event: "clock", action: "patch", id: op.id, start: iso(op.start), end: iso(op.end) }, { dir: logDir, now, tz: cfg.tz });
        continue;
      }
      summary.failed += 1;
      appendEvent({ event: "clock", action: "patch-failed", id: op.id, code: result.code, status: result.status }, { dir: logDir, now, tz: cfg.tz });
      continue;
    }
    const segment = op.segment;
    const result = await api.create({ activityId, start: segment.start, end: segment.end });
    if (result.ok) {
      created.push({ id: result.data.id, start: segment.start, end: segment.end, origin: segment.origin ?? "unit", unitKeys: segment.unitKeys ?? [] });
      appendEvent({ event: "clock", action: "create", id: result.data.id, start: iso(segment.start), end: iso(segment.end), minutes: minute(segment) }, { dir: logDir, now, tz: cfg.tz });
      continue;
    }
    if (result.code === "overlap") {
      summary.conflict += 1;
      summary.conflictMinutes += minute(segment);
      appendEvent({ event: "clock", action: "conflict", start: iso(segment.start), end: iso(segment.end), minutes: minute(segment) }, { dir: logDir, now, tz: cfg.tz });
      continue;
    }
    summary.failed += 1;
    appendEvent({ event: "clock", action: "create-failed", code: result.code, status: result.status, start: iso(segment.start) }, { dir: logDir, now, tz: cfg.tz });
  }

  summary.created = created.length;
  summary.patched = patched.length;
  summary.deleted = deleted.length;

  if (created.length || patched.length || deleted.length) {
    const byId = new Map(Object.values(synced).flat().map((item) => [item.id, { ...item }]));
    for (const id of deleted) byId.delete(id);
    for (const item of patched) {
      const current = byId.get(item.id);
      if (current) {
        current.start = item.start;
        current.end = item.end;
      }
    }
    for (const item of created) byId.set(item.id, item);
    writeJsonAtomic(syncedFile, pruneSynced(groupByDay([...byId.values()], clockCfg.tz), { now, tz: clockCfg.tz, ttlDays: clockCfg.syncedTtlDays }));
  }

  appendEvent({ event: "clock_round", ...summary, created: created.length, patched: patched.length, deleted: deleted.length }, { dir: logDir, now, tz: cfg.tz });
  const line = `写 ${created.length + patched.length} 段 / 删 ${deleted.length}${plan.covered.length ? ` / 人工已记 ${plan.covered.length} 段（${formatDuration(plan.coveredMinutes)}）` : ""} / 冲突 ${summary.conflict}${summary.conflictMinutes ? `（${formatDuration(summary.conflictMinutes)}）` : ""}${summary.blocked.length ? ` / 超限跳过 ${summary.blocked.map((item) => item.day).join(",")}` : ""}`;
  const todayAfter = await readDayTotal(api, { now, tz: clockCfg.tz });
  return { summary, line, todayBefore, todayAfter };
}

async function fetchLivePeriods(api, { from, to }) {
  const out = [];
  let offset = 0;
  for (;;) {
    const result = await api.list({ start: from, end: to, limit: 100, offset });
    if (!result.ok) return null;
    for (const item of result.data?.periods ?? []) {
      out.push({ id: item.id, activityId: item.activityId ?? item.activity?.id ?? null, start: Date.parse(item.start), end: Date.parse(item.end) });
    }
    if (!result.data?.hasMore || offset >= 900) break;
    offset += 100;
  }
  return out;
}

function resolveEntry() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fileURLToPath(import.meta.url) === entry;
  } catch {
    return false;
  }
}

function parseArgs(argv) {
  const flags = new Set();
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      values[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      values[arg.slice(2)] = next;
      index += 1;
      continue;
    }
    flags.add(arg.slice(2));
  }
  return { flags, values };
}

function formatReview(item) {
  const span = item.span ? `${item.span[0]} → ${item.span[1]}` : item.day;
  const p = item.p ? `count ${item.p.count} / skip ${item.p.skip}` : "no probability";
  const state = item.override ? `override=${item.override}` : item.current ?? "unknown";
  const ask = String(item.requests?.[0] ?? "").replace(/\s+/g, " ").slice(0, 60);
  return `${item.key}\n  ${span} · ${item.reason} · ${p} · ${state}\n  问：${ask}`;
}

async function main(argv) {
  const { flags, values } = parseArgs(argv);
  if (flags.has("review")) {
    const items = listReviews({ dir: CFG_DIR });
    process.stdout.write(items.length ? `${items.map(formatReview).join("\n")}\n` : "(no review units)\n");
    return;
  }
  if (values.override) {
    const kind = values.kind ?? "count";
    const release = acquireLock(join(CFG_DIR, ".lock"));
    if (!release) {
      process.stderr.write("[hours] skip: another round holds the lock\n");
      return;
    }
    try {
      const entry = setOverride({ key: values.override, kind, note: values.note ?? "" });
      process.stdout.write(`override ${values.override} → ${entry.override.kind}${entry.override.note ? ` (${entry.override.note})` : ""}\n`);
    } finally {
      release();
    }
    return;
  }
  if (values["clear-override"]) {
    const release = acquireLock(join(CFG_DIR, ".lock"));
    if (!release) {
      process.stderr.write("[hours] skip: another round holds the lock\n");
      return;
    }
    try {
      const removed = clearOverride({ key: values["clear-override"] });
      process.stdout.write(removed ? `cleared override on ${values["clear-override"]}\n` : `no override on ${values["clear-override"]}\n`);
    } finally {
      release();
    }
    return;
  }
  const dryRun = flags.has("dry-run");
  const dryRunClock = flags.has("dry-run-clock");
  const notify = !flags.has("no-notify");
  const release = acquireLock(join(CFG_DIR, ".lock"));
  if (!release) {
    process.stderr.write("[hours] skip: another round holds the lock\n");
    return;
  }
  try {
    const outcome = await run({ dryRun, notify, logDir: LOG_DIR, dryRunClock });
    if (dryRun) process.stdout.write(`${outcome.report || "(no new units)"}\n`);
    process.stderr.write(`[hours] units=${outcome.units} fresh=${outcome.fresh.length} notified=${outcome.delivered}\n`);
  } finally {
    release();
  }
}

if (resolveEntry()) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`[hours] ${error?.stack ?? error}\n`);
    process.exit(1);
  });
}
