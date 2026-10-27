const JSON_HEADERS = { "Content-Type": "application/json" };

export const CLOCK_MAX_PAGE = 100;

export function createClockClient({ baseUrl, apiKey, fetchImpl = fetch, timeoutMs = 15_000 }) {
  function auth() {
    return { Authorization: `Bearer ${apiKey}` };
  }

  async function request(method, path, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: body === undefined ? auth() : { ...auth(), ...JSON_HEADERS },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      let payload = null;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        payload = text;
      }
      if (response.ok) return { ok: true, status: response.status, data: payload };
      return { ok: false, status: response.status, code: codeOf(response.status), data: payload };
    } catch (error) {
      return { ok: false, status: 0, code: error?.name === "AbortError" ? "timeout" : "network", data: String(error?.message ?? error) };
    } finally {
      clearTimeout(timer);
    }
  }

  function codeOf(status) {
    if (status === 401) return "unauthorized";
    if (status === 403) return "forbidden";
    if (status === 404) return "not-found";
    if (status === 409) return "overlap";
    if (status >= 500) return "server";
    return "bad-request";
  }

  function iso(ms) {
    return new Date(ms).toISOString();
  }

  async function list({ start, end, limit = CLOCK_MAX_PAGE, offset = 0 }) {
    const query = new URLSearchParams({ start: iso(start), end: iso(end), limit: String(limit), offset: String(offset) });
    return request("GET", `/api/periods?${query}`);
  }

  async function create({ activityId, start, end }) {
    return request("POST", "/api/periods", { activityId, start: iso(start), end: iso(end) });
  }

  async function patch(id, { start, end }) {
    return request("PATCH", `/api/periods/${id}`, { start: iso(start), end: iso(end) });
  }

  async function remove(id) {
    return request("DELETE", `/api/periods/${id}`);
  }

  async function activities() {
    return request("GET", "/api/activities");
  }

  async function daily({ start, end, tz }) {
    const query = new URLSearchParams({ start: iso(start), end: iso(end), tz });
    return request("GET", `/api/periods/daily?${query}`);
  }

  return { list, create, patch, remove, activities, daily };
}

export function pickActivity(payload, { name, activityId }) {
  const items = Array.isArray(payload) ? payload : (payload?.activities ?? payload?.data ?? []);
  if (activityId) return items.find((item) => item.id === activityId) ?? null;
  return items.find((item) => item.name === name) ?? null;
}
