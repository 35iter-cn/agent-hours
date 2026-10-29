import test from "node:test";
import assert from "node:assert/strict";
import { createReporter, expandCommand, expandEnvRefs } from "../../src/reporter.mjs";
import { defaultReporter } from "../../src/hours.mjs";

test("none and disabled reporters send nothing", async () => {
  const calls = [];
  const none = createReporter({ type: "none" }, { run: (...args) => calls.push(args) });
  const disabled = createReporter({ type: "command", command: ["printf", "{text}"], enabled: false }, { run: (...args) => calls.push(args) });
  assert.deepEqual(await none(["a"]), { ok: true, chunks: 0, output: "" });
  assert.deepEqual(await disabled(["a"]), { ok: true, chunks: 0, output: "" });
  assert.equal(calls.length, 0);
});

test("command reporter expands {text} per chunk and stops on failure", async () => {
  assert.deepEqual(expandCommand(["/bin/sh", "-c", "printf %s {text}"], "hi there"), ["/bin/sh", "-c", "printf %s hi there"]);
  const seen = [];
  const ok = createReporter({ type: "command", command: ["/usr/bin/printf", "%s", "{text}"] }, {
    run: (bin, args) => {
      seen.push([bin, ...args]);
      return { status: 0, stdout: "", stderr: "" };
    },
  });
  const result = await ok(["one", "two"]);
  assert.deepEqual(result, { ok: true, chunks: 2, output: "" });
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[1], ["/usr/bin/printf", "%s", "two"]);

  const bad = createReporter({ type: "command", command: ["/bin/false", "{text}"] }, {
    run: () => ({ status: 1, stdout: "", stderr: "boom" }),
  });
  const failed = await bad(["one"]);
  assert.equal(failed.ok, false);
  assert.match(failed.output, /boom/);
});

test("http reporter resolves env: headers and reports non-2xx", async () => {
  assert.equal(expandEnvRefs("env:TOKEN", { TOKEN: "t" }), "t");
  assert.equal(expandEnvRefs("plain", { TOKEN: "t" }), "plain");
  const seen = [];
  const ok = createReporter({ type: "http", url: "https://example.invalid/hook", headers: { Authorization: "env:TOKEN" } }, {
    env: { TOKEN: "secret" },
    fetchImpl: async (url, init) => {
      seen.push({ url, init });
      return { ok: true, status: 200, text: async () => "" };
    },
  });
  assert.deepEqual(await ok(["body"]), { ok: true, chunks: 1, output: "" });
  assert.equal(seen[0].init.headers.Authorization, "secret");
  assert.equal(JSON.parse(seen[0].init.body).text, "body");

  const failing = createReporter({ type: "http", url: "https://example.invalid/hook" }, {
    fetchImpl: async () => ({ ok: false, status: 503, text: async () => "down" }),
  });
  const result = await failing(["body"]);
  assert.equal(result.ok, false);
  assert.equal(result.output, "503");
});

test("TC-R1 a notify platform without a reporter falls back to the agent-relay CLI by name", async () => {
  const seen = [];
  const send = defaultReporter({ notify: { platform: "feishu" } }, {
    run: (bin, args) => {
      seen.push([bin, ...args]);
      return { status: 0, stdout: "", stderr: "" };
    },
  });
  await send("hello");
  assert.deepEqual(seen, [["agent-relay", "notice", "emit", "--platform", "feishu", "--text", "hello"]]);
});

test("TC-R2 an explicit reporter command wins over the built-in default", async () => {
  const seen = [];
  const send = defaultReporter({
    notify: { platform: "feishu" },
    reporter: { type: "command", command: ["/bin/echo", "{text}"] },
  }, {
    run: (bin, args) => {
      seen.push([bin, ...args]);
      return { status: 0, stdout: "", stderr: "" };
    },
  });
  await send("hi");
  assert.deepEqual(seen, [["/bin/echo", "hi"]]);
});
