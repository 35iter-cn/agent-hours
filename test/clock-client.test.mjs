import test from "node:test";
import assert from "node:assert/strict";
import { createClockClient, pickActivity } from "../src/clock-client.mjs";

function harness(responder) {
  const calls = [];
  const client = createClockClient({
    baseUrl: "https://clock.test",
    apiKey: "k",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return responder(url, init);
    },
  });
  return { client, calls };
}

function json(status, body) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

test("TC-K1 create posts ISO timestamps to /api/periods", async () => {
  const { client, calls } = harness(() => json(201, { id: "p1" }));
  const result = await client.create({
    activityId: "a1",
    start: Date.parse("2026-10-24T01:00:00.000Z"),
    end: Date.parse("2026-10-24T01:30:00.000Z"),
  });
  assert.equal(result.ok, true);
  assert.equal(result.data.id, "p1");
  assert.equal(calls[0].url, "https://clock.test/api/periods");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.Authorization, "Bearer k");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    activityId: "a1",
    start: "2026-10-24T01:00:00.000Z",
    end: "2026-10-24T01:30:00.000Z",
  });
});

test("TC-K2 list passes the range plus paging through the query string", async () => {
  const { client, calls } = harness(() => json(200, { periods: [], total: 0, hasMore: false }));
  await client.list({ start: Date.parse("2026-10-24T00:00:00.000Z"), end: Date.parse("2026-10-25T00:00:00.000Z"), limit: 50, offset: 50 });
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, "/api/periods");
  assert.equal(url.searchParams.get("start"), "2026-10-24T00:00:00.000Z");
  assert.equal(url.searchParams.get("end"), "2026-10-25T00:00:00.000Z");
  assert.equal(url.searchParams.get("limit"), "50");
  assert.equal(url.searchParams.get("offset"), "50");
});

test("TC-K3 409 maps to overlap, 403 to forbidden and 503 to server", async () => {
  const overlap = await harness(() => json(409, { error: { code: "CONFLICT" } })).client.create({ activityId: "a", start: 0, end: 1 });
  assert.equal(overlap.ok, false);
  assert.equal(overlap.code, "overlap");

  const forbidden = await harness(() => json(403, { error: { code: "FORBIDDEN" } })).client.remove("p1");
  assert.equal(forbidden.code, "forbidden");

  const server = await harness(() => json(503, "down")).client.patch("p1", { start: 0, end: 1 });
  assert.equal(server.code, "server");
});

test("TC-K4 a rejected fetch maps to network", async () => {
  const { client } = harness(() => {
    throw new Error("boom");
  });
  const result = await client.remove("p1");
  assert.equal(result.ok, false);
  assert.equal(result.code, "network");
});

test("TC-K5 patch and delete target the record path", async () => {
  const { client, calls } = harness(() => json(200, { ok: true }));
  await client.patch("p1", { start: Date.parse("2026-10-24T01:00:00.000Z"), end: Date.parse("2026-10-24T02:00:00.000Z") });
  await client.remove("p1");
  assert.equal(calls[0].url, "https://clock.test/api/periods/p1");
  assert.equal(calls[0].init.method, "PATCH");
  assert.equal(calls[1].init.method, "DELETE");
});

test("TC-K6 activity lookup prefers the configured id and falls back to the name", () => {
  const payload = [
    { id: "a1", name: "工作" },
    { id: "a2", name: "clock" },
  ];
  assert.equal(pickActivity(payload, { activityId: "a1", name: "clock" }).id, "a1");
  assert.equal(pickActivity(payload, { name: "clock" }).id, "a2");
  assert.equal(pickActivity(payload, { name: "missing" }), null);
});

test("TC-K7 activities payload shapes are all accepted", () => {
  assert.equal(pickActivity({ activities: [{ id: "a1", name: "clock" }] }, { name: "clock" }).id, "a1");
  assert.equal(pickActivity({ data: [{ id: "a2", name: "clock" }] }, { name: "clock" }).id, "a2");
});
