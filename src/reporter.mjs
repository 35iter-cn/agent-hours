import { spawnSync } from "node:child_process";

export function expandEnvRefs(value, env = process.env) {
  const text = String(value ?? "");
  if (!text.startsWith("env:")) return text;
  return env[text.slice(4)] ?? "";
}

export function expandCommand(template, text) {
  const argv = Array.isArray(template) ? template.map(String) : [String(template ?? "")];
  return argv.map((part) => part.replaceAll("{text}", text));
}

export function createReporter(cfg = {}, { run = spawnSync, fetchImpl = fetch, env = process.env, log = () => {} } = {}) {
  const type = cfg?.type ?? "none";
  const enabled = cfg?.enabled !== false;
  if (!enabled || type === "none") {
    return async () => ({ ok: true, chunks: 0, output: "" });
  }
  if (type === "command") {
    const template = cfg.command;
    if (!template) throw new Error("reporter command needs a command template");
    return async (chunks) => {
      let sent = 0;
      let failure = "";
      for (const chunk of chunks) {
        const [bin, ...args] = expandCommand(template, chunk);
        const result = run(bin, args, { encoding: "utf8", timeout: cfg.timeoutMs ?? 30_000 });
        if (result?.status !== 0) {
          failure = `${result?.stdout ?? ""}${result?.stderr ?? ""}`.trim() || `exit ${result?.status}`;
          break;
        }
        sent += 1;
      }
      if (failure) log(`reporter command failed: ${failure}`);
      return { ok: !failure, chunks: sent, output: failure };
    };
  }
  if (type === "http") {
    if (!cfg.url) throw new Error("reporter http needs a url");
    const headers = Object.fromEntries(Object.entries(cfg.headers ?? {}).map(([key, value]) => [key, expandEnvRefs(value, env)]));
    return async (chunks) => {
      let sent = 0;
      for (const chunk of chunks) {
        try {
          const response = await fetchImpl(cfg.url, {
            method: cfg.method ?? "POST",
            headers: { "Content-Type": "application/json", ...headers },
            body: JSON.stringify({ text: chunk }),
          });
          if (!response?.ok) {
            const body = await response?.text?.().catch(() => "");
            log(`reporter http ${response?.status}: ${String(body).slice(0, 200)}`);
            return { ok: false, chunks: sent, output: `${response?.status}` };
          }
          sent += 1;
        } catch (error) {
          log(`reporter http failed: ${String(error?.message ?? error)}`);
          return { ok: false, chunks: sent, output: String(error?.message ?? error) };
        }
      }
      return { ok: true, chunks: sent, output: "" };
    };
  }
  throw new Error(`unknown reporter type: ${type}`);
}
