import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { buildUnits, loadJudge, loadJudgePrompt, unitState } from "../../src/hours.mjs";

const CFG = join(homedir(), ".config/agent-hours");
const enabled = process.env.AGENT_HOURS_E2E === "1";
const skipGate = !enabled && "set AGENT_HOURS_E2E=1 to run against the real judge";

const DRY_RUN_OUTPUT = "**修好了，也推上去了：`--dry-run` 现在等价于自带 `--no-repair`（commit `9f6aa0f`，已 push 到 `origin/main`），服务直接从工作树跑，下一个整点生效。**\n\n**改了什么**\n```js\nconst dryRun = flags.has(\"dry-run\");\nconst repairs = flags.has(\"no-repair\") || dryRun ? { closed: [], sessions: 0 } : repairLedger({ dir: CFG_DIR });\n```";

const CLIENT_OUTPUT = "修好了三个 review 意见：表格渲染改成逐项组件、presenter 里两处标签改成块体函数、测试拆成两个文件；lint/tsc/test 全绿，覆盖率仍是 100%。";

function fixtureRepo(name) {
  const root = mkdtempSync(join(tmpdir(), "agent-hours-ctx-"));
  const repo = join(root, name);
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(repo, ".git"));
  return { root, repo, file: join(repo, "src", "hours.mjs") };
}

function record({ startedAt, userText, output, cwd = "", sessionName = "", paths = [] }) {
  return {
    v: 1,
    id: `fixture:${startedAt}`,
    sessionId: "fixture",
    sessionFile: "",
    source: "relay",
    startedAt,
    durationMs: 5 * 60_000,
    userText,
    output,
    aborted: false,
    cwd,
    sessionName,
    paths,
  };
}

function unitOf(entry) {
  return buildUnits([record(entry)])[0];
}

let judgePromise = null;

async function verdictOf(unit) {
  if (!judgePromise) {
    const cfg = JSON.parse(readFileSync(join(CFG, "config.json"), "utf8"));
    judgePromise = loadJudge(cfg.judge);
  }
  const judge = await judgePromise;
  const prompt = loadJudgePrompt();
  return judge.judgeChoice({ id: "hours:fixture", state: unitState(unit), instructions: prompt.instructions, criteria: prompt.criteria });
}

test("integration: the same dry-run turn skips with session context and counts without it", { skip: skipGate, timeout: 120_000 }, async () => {
  const { repo, file } = fixtureRepo("agent-hours");
  const withContext = await verdictOf(unitOf({
    startedAt: "2026-10-27T11:17:48.565Z",
    userText: "按 1 修",
    output: DRY_RUN_OUTPUT,
    sessionName: "修复dry-run跳过账本修复",
    paths: [file],
  }));
  const bare = await verdictOf(unitOf({
    startedAt: "2026-10-27T11:17:48.565Z",
    userText: "按 1 修",
    output: DRY_RUN_OUTPUT,
  }));

  assert.ok(withContext.probabilities, "the judge returned no probabilities");
  assert.ok(bare.probabilities, "the judge returned no probabilities");
  assert.ok(
    withContext.probabilities.skip > withContext.probabilities.count,
    `with context (${repo}) expected skip, got ${JSON.stringify(withContext.probabilities)}`,
  );
  assert.ok(
    bare.probabilities.count > bare.probabilities.skip,
    `without context expected count, got ${JSON.stringify(bare.probabilities)}`,
  );
});

test("integration: a client-repo turn still counts when the session also touched own paths", { skip: skipGate, timeout: 120_000 }, async () => {
  const { repo, file } = fixtureRepo("client-portal");
  const ownHome = mkdtempSync(join(tmpdir(), "agent-hours-own-"));
  const ownFile = join(ownHome, ".pi", "agent", "skills", "local-debug", "SKILL.md");
  mkdirSync(join(ownHome, ".pi", "agent", "skills", "local-debug"), { recursive: true });

  const verdict = await verdictOf(unitOf({
    startedAt: "2026-10-27T09:55:38.035Z",
    userText: "把这些 review 意见修一下",
    output: CLIENT_OUTPUT,
    sessionName: "review 意见整改",
    paths: [file, ownFile],
  }));

  assert.ok(verdict.probabilities, "the judge returned no probabilities");
  assert.ok(
    verdict.probabilities.count > verdict.probabilities.skip,
    `expected count for ${repo}, got ${JSON.stringify(verdict.probabilities)}`,
  );
});
