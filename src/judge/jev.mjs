import { createHash } from "node:crypto";

const DEFAULT_BASE = "https://api.commandcode.ai/provider/v1/systemone";
const DEFAULT_MODEL = "typesafe/jev";
const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_LIMIT = 2;
const RETRY_BASE_MS = 500;
const RETRY_CAP_MS = 8_000;
const CACHE_TTL_MS = 600_000;
const CIRCUIT_MS = 300_000;
const FAILURE_LIMIT = 3;
const MIN_CONFIDENCE = 0.5;

export function createJev(deps = {}) {
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const log = deps.log ?? (() => {});
  const clock = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const random = deps.random ?? Math.random;
  const base = deps.base ?? env.JEV_BASE_URL ?? DEFAULT_BASE;
  const model = deps.model ?? env.JEV_MODEL ?? DEFAULT_MODEL;
  const requestTimeoutMs = deps.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const cache = new Map();
  let failures = 0;
  let circuitUntil = 0;

  function apiKey() {
    return env.JEV_API_KEY ?? "";
  }

  function cacheKey(state, questions) {
    return createHash("sha256").update(`${state}\u0000${JSON.stringify(questions)}`).digest("hex").slice(0, 16);
  }

  function retryable(error) {
    const status = error?.status;
    if (status === undefined) return true;
    return status >= 500;
  }

  function backoffMs(attempt) {
    const step = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** (attempt - 1));
    return Math.round(step * (0.8 + random() * 0.4));
  }

  function fallbackOf(error) {
    if (error?.name === "AbortError") return "timeout";
    if (error?.status === 429) return "http_429";
    if (error?.status === 402) return "http_402";
    return "error";
  }

  async function post(state, questions) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const res = await fetchImpl(base, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey()}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, state, questions }),
        signal: controller.signal,
      });
      const body = await res.text();
      if (!res.ok) {
        const error = new Error(`Jev ${res.status}: ${body.slice(0, 200)}`);
        error.status = res.status;
        throw error;
      }
      return JSON.parse(body);
    } finally {
      clearTimeout(timer);
    }
  }

  function emit(id, record) {
    log("info", "jev", { event: "jev", id, ...record });
  }

  async function ask(id, state, questions) {
    const startedAt = clock();
    if (!apiKey()) return { answers: {}, fallback: "nokey", elapsedMs: 0, attempts: 0 };
    const key = cacheKey(state, questions);
    const cached = cache.get(key);
    if (cached && cached.expiresAt > startedAt) return { answers: cached.answers, fallback: null, elapsedMs: 0, attempts: 0 };
    if (circuitUntil > startedAt) return { answers: {}, fallback: "circuit", elapsedMs: 0, attempts: 0 };
    let attempts = 0;
    try {
      let payload;
      for (;;) {
        attempts += 1;
        try {
          payload = await post(state, questions);
          break;
        } catch (error) {
          if (!retryable(error) || attempts > RETRY_LIMIT) throw error;
          await sleep(backoffMs(attempts));
        }
      }
      failures = 0;
      const answers = payload?.answers ?? {};
      cache.set(key, { answers, expiresAt: startedAt + CACHE_TTL_MS });
      return { answers, fallback: null, elapsedMs: clock() - startedAt, attempts };
    } catch (error) {
      failures += 1;
      if (failures >= FAILURE_LIMIT) circuitUntil = clock() + CIRCUIT_MS;
      return { answers: {}, fallback: fallbackOf(error), elapsedMs: clock() - startedAt, error: String(error?.message ?? error), attempts };
    }
  }

  async function judgeChoice({ id, state, instructions, criteria }) {
    const startedAt = clock();
    const questions = { choice: { type: "choice", instructions, criteria } };
    const result = await ask(id, state, questions);
    const answer = result.answers?.choice ?? null;
    const confidence = answer?.confidence ?? null;
    const choice = answer?.choice && confidence !== null && confidence >= MIN_CONFIDENCE ? answer.choice : null;
    const fallback = result.fallback ?? (answer ? (choice ? null : "low-confidence") : "error");
    const elapsedMs = result.elapsedMs ?? clock() - startedAt;
    emit(id, { choice, confidence, fallback, elapsedMs, attempts: result.attempts, ...(result.error ? { error: result.error } : {}) });
    return { choice, confidence, probabilities: answer?.probabilities ?? null, fallback, elapsedMs, attempts: result.attempts };
  }

  async function judgeScore({ id, state, instructions }) {
    const startedAt = clock();
    const questions = { score: { type: "noul", instructions } };
    const result = await ask(id, state, questions);
    const answer = result.answers?.score ?? null;
    const score = typeof answer?.noul === "number" ? answer.noul : null;
    const fallback = result.fallback ?? (answer ? null : "error");
    const elapsedMs = result.elapsedMs ?? clock() - startedAt;
    emit(id, { score, fallback, elapsedMs, attempts: result.attempts, ...(result.error ? { error: result.error } : {}) });
    return { score, fallback, elapsedMs, attempts: result.attempts };
  }

  return { judgeChoice, judgeScore, reset: () => { failures = 0; circuitUntil = 0; cache.clear(); } };
}
