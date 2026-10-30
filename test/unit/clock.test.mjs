import test from "node:test";
import assert from "node:assert/strict";
import {
  alignSegment,
  buildPlan,
  clipToWindow,
  CLOCK_DEFAULTS,
  dayKey,
  filterShort,
  groupByDay,
  oversizeDays,
  countedSegments,
  planReconcile,
  decayFill,
  stitchRuns,
  stitchRunsDecay,
  subtractCoverage,
  pruneMissing,
  pruneSynced,
  splitAtMidnight,
  unionSegments,
} from "../../src/clock.mjs";

const MIN = 60_000;
const HOUR = 3_600_000;
const TZ = "Asia/Shanghai";

function at(iso) {
  return Date.parse(iso);
}

test("TC-C1 union merges segments whose gap is within the threshold", () => {
  const merged = unionSegments(
    [
      { start: at("2026-10-24T01:00:00Z"), end: at("2026-10-24T01:10:00Z") },
      { start: at("2026-10-24T01:20:00Z"), end: at("2026-10-24T01:30:00Z") },
      { start: at("2026-10-24T02:00:00Z"), end: at("2026-10-24T02:10:00Z") },
    ],
    15 * MIN,
  );
  assert.equal(merged.length, 2);
  assert.equal(merged[0].end - merged[0].start, 30 * MIN);
});

test("TC-C2 alignment floors the start and ceils the end to whole minutes", () => {
  const aligned = alignSegment({ start: at("2026-10-24T01:00:20.400Z"), end: at("2026-10-24T01:10:39.900Z") });
  assert.equal(new Date(aligned.start).toISOString(), "2026-10-24T01:00:00.000Z");
  assert.equal(new Date(aligned.end).toISOString(), "2026-10-24T01:11:00.000Z");
});

test("TC-C3 segments shorter than the minimum are dropped", () => {
  const kept = filterShort(
    [
      { start: 0, end: 4 * MIN },
      { start: 10 * MIN, end: 15 * MIN },
    ],
    5 * MIN,
  );
  assert.equal(kept.length, 1);
  assert.equal(kept[0].end - kept[0].start, 5 * MIN);
});

test("TC-C4 clipping drops old segments and trims the one crossing the window edge", () => {
  const now = at("2026-10-24T12:00:00Z");
  const clipped = clipToWindow(
    [
      { start: now - 30 * HOUR, end: now - 26 * HOUR },
      { start: now - 25 * HOUR, end: now - 23 * HOUR },
    ],
    { now, hours: 24 },
  );
  assert.equal(clipped.length, 1);
  assert.equal(clipped[0].start, now - 24 * HOUR);
  assert.equal(clipped[0].end, now - 23 * HOUR);
});

test("TC-C5 a day over the warn threshold is reported with its minutes", () => {
  const day = at("2026-10-24T02:00:00Z");
  const oversize = oversizeDays(
    [
      { start: day, end: day + 13 * HOUR },
    ],
    { tz: TZ, warnHours: 12 },
  );
  assert.equal(oversize.length, 1);
  assert.equal(oversize[0].day, dayKey(day, TZ));
  assert.equal(oversize[0].minutes, 780);
});

test("TC-C6 reconcile creates missing targets, patches drifted ones and deletes orphans", () => {
  const plan = planReconcile({
    targets: [
      { start: 0, end: 10 * MIN },
      { start: 20 * MIN, end: 30 * MIN },
    ],
    current: [
      { id: "keep", start: 0, end: 10 * MIN },
      { id: "drift", start: 20 * MIN, end: 25 * MIN },
      { id: "orphan", start: 40 * MIN, end: 50 * MIN },
    ],
    thresholdMs: MIN,
  });
  assert.deepEqual(plan.create, []);
  assert.deepEqual(plan.patch, [{ id: "drift", start: 20 * MIN, end: 30 * MIN }]);
  assert.deepEqual(plan.remove, ["orphan"]);
});

test("TC-C7 a target without any overlapping record is created", () => {
  const plan = planReconcile({
    targets: [{ start: 0, end: 10 * MIN }],
    current: [{ id: "other", start: 20 * MIN, end: 30 * MIN }],
  });
  assert.equal(plan.create.length, 1);
  assert.deepEqual(plan.remove, ["other"]);
});

test("TC-C8 a target overlapping two of our records pairs with the first and deletes the rest", () => {
  const plan = planReconcile({
    targets: [{ start: 0, end: 30 * MIN }],
    current: [
      { id: "a", start: 0, end: 10 * MIN },
      { id: "b", start: 12 * MIN, end: 30 * MIN },
    ],
    thresholdMs: MIN,
  });
  assert.deepEqual(plan.patch, [{ id: "a", start: 0, end: 30 * MIN }]);
  assert.deepEqual(plan.remove, ["b"]);
});

test("TC-C9 buildPlan counts only counted units, keeps a 48h backfill and ignores synced rows outside it", () => {
  const now = at("2026-10-24T12:00:00Z");
  const judged = [
    {
      unit: { runs: [{ startedAt: now - 2 * HOUR, endedAt: now - 2 * HOUR + 20 * MIN }] },
      result: { kind: "count" },
    },
    {
      unit: { runs: [{ startedAt: now - 4 * HOUR, endedAt: now - 4 * HOUR + 20 * MIN }] },
      result: { kind: "skip" },
    },
    {
      unit: { runs: [{ startedAt: now - 30 * HOUR, endedAt: now - 30 * HOUR + 20 * MIN }] },
      result: { kind: "count" },
    },
    {
      unit: { runs: [{ startedAt: now - 60 * HOUR, endedAt: now - 60 * HOUR + 20 * MIN }] },
      result: { kind: "count" },
    },
  ];
  const synced = {
    "2026-10-20": [{ id: "old", start: now - 4 * 24 * HOUR, end: now - 4 * 24 * HOUR + 10 * MIN }],
  };
  const cfg = { ...CLOCK_DEFAULTS, tz: TZ };
  const plan = buildPlan({ judged, now, cfg, synced });
  assert.equal(plan.targets.length, 2);
  assert.equal(plan.create.length, 2);
  assert.equal(plan.targets[0].start, now - 30 * HOUR);
  assert.deepEqual(plan.remove, []);
});

test("TC-C10 buildPlan drops every target of a day that exceeds the warn threshold", () => {
  const now = at("2026-10-24T12:00:00Z");
  const judged = [
    {
      unit: { runs: [{ startedAt: now - 13 * HOUR, endedAt: now - 13 * HOUR + 13 * HOUR }] },
      result: { kind: "count" },
    },
  ];
  const plan = buildPlan({ judged, now, cfg: { ...CLOCK_DEFAULTS, tz: TZ }, synced: {} });
  assert.equal(plan.targets.length, 0);
  assert.equal(plan.blocked.length, 1);
  assert.equal(plan.dropped, 1);
});

test("TC-C11 synced pruning drops stale days and stale rows", () => {
  const now = at("2026-10-24T12:00:00Z");
  const pruned = pruneSynced(
    {
      "2026-10-20": [{ id: "a", start: now - 4 * 24 * HOUR, end: now - 4 * 24 * HOUR + MIN }],
      "2026-10-24": [{ id: "b", start: now - HOUR, end: now }],
    },
    { now, tz: TZ, ttlDays: 2 },
  );
  assert.deepEqual(Object.keys(pruned), ["2026-10-24"]);
});

test("TC-C12 grouping buckets records by the local day of their start", () => {
  const grouped = groupByDay(
    [
      { start: at("2026-10-23T16:30:00Z"), end: at("2026-10-23T17:00:00Z") },
      { start: at("2026-10-24T02:00:00Z"), end: at("2026-10-24T03:00:00Z") },
    ],
    TZ,
  );
  assert.deepEqual(Object.keys(grouped).sort(), ["2026-10-24"]);
});

test("TC-C13 rows missing from the server are forgotten so the next round rebuilds them", () => {
  const now = at("2026-10-24T12:00:00Z");
  const { synced, dropped } = pruneMissing(
    {
      "2026-10-24": [
        { id: "gone", start: now - 2 * HOUR, end: now - HOUR },
        { id: "alive", start: now - HOUR, end: now },
      ],
    },
    new Set(["alive"]),
    { windowFrom: now - 24 * HOUR },
  );
  assert.equal(dropped, 1);
  assert.deepEqual(synced["2026-10-24"].map((row) => row.id), ["alive"]);
});

test("TC-C14 rows older than the verification window are kept untouched", () => {
  const now = at("2026-10-24T12:00:00Z");
  const { synced, dropped } = pruneMissing(
    { "2026-10-20": [{ id: "old", start: now - 5 * 24 * HOUR, end: now - 5 * 24 * HOUR + HOUR }] },
    new Set(),
    { windowFrom: now - 24 * HOUR },
  );
  assert.equal(dropped, 0);
  assert.equal(synced["2026-10-20"].length, 1);
});

function unitOf(key, runs) {
  return { key, runs };
}

test("countedSegments merges only inside a unit and skips excluded runs", () => {
  const base = at("2026-10-24T09:00:00Z");
  const judged = [
    {
      unit: unitOf("u1", [
        { startedAt: base, endedAt: base + 5 * MIN },
        { startedAt: base + 7 * MIN, endedAt: base + 12 * MIN },
        { startedAt: base + 15 * MIN, endedAt: base + 20 * MIN },
      ]),
      result: { kind: "count" },
    },
    {
      unit: unitOf("u2", [{ startedAt: base + 21 * MIN, endedAt: base + 26 * MIN }]),
      result: { kind: "count" },
    },
  ];
  const segments = countedSegments(judged, { gapMs: 2 * MIN });
  assert.equal(segments.length, 3);
  assert.equal(segments[0].start, base);
  assert.equal(segments[0].end, base + 12 * MIN);
  assert.equal(segments[1].start, base + 15 * MIN);
  assert.equal(segments[2].start, base + 21 * MIN);
  assert.deepEqual(segments[2].unitKeys, ["u2"]);
});

test("countedSegments never merges across a run excluded by the split verdict", () => {
  const base = at("2026-10-24T09:00:00Z");
  const judged = [
    {
      unit: unitOf("u1", [
        { startedAt: base, endedAt: base + 5 * MIN },
        { startedAt: base + 6 * MIN, endedAt: base + 8 * MIN },
        { startedAt: base + 9 * MIN, endedAt: base + 14 * MIN },
      ]),
      result: {
        kind: "count",
        split: true,
        runs: [
          { runHash: "a", kind: "count" },
          { runHash: "b", kind: "skip" },
          { runHash: "c", kind: "count" },
        ],
      },
    },
  ];
  const segments = countedSegments(judged, { gapMs: 2 * MIN });
  assert.equal(segments.length, 2);
  assert.equal(segments[0].end, base + 5 * MIN);
  assert.equal(segments[1].start, base + 9 * MIN);
  assert.equal(segments[0].origin, "run-split");
});

test("buildPlan reports the planned minutes and keeps one minute segments", () => {
  const now = at("2026-10-24T12:00:00Z");
  const judged = [
    {
      unit: unitOf("u1", [
        { startedAt: now - 2 * HOUR, endedAt: now - 2 * HOUR + 20 * MIN },
        { startedAt: now - 2 * HOUR + 22 * MIN, endedAt: now - 2 * HOUR + 24 * MIN },
      ]),
      result: { kind: "count" },
    },
  ];
  const plan = buildPlan({ judged, now, cfg: { ...CLOCK_DEFAULTS, tz: TZ }, synced: {} });
  assert.equal(plan.targets.length, 1);
  assert.equal(plan.minutes, 24);
  assert.equal(CLOCK_DEFAULTS.mergeGapMinutes, 2);
  assert.equal(CLOCK_DEFAULTS.minSegmentMinutes, 1);
  assert.equal(CLOCK_DEFAULTS.maxWritesPerRun, 120);
});

test("buildPlan merges segments that touch after minute alignment", () => {
  const now = at("2026-10-24T12:00:00Z");
  const judged = [
    {
      unit: unitOf("u1", [
        { startedAt: now - 2 * HOUR, endedAt: now - 2 * HOUR + 5 * MIN },
        { startedAt: now - 2 * HOUR + 5 * MIN + 20_000, endedAt: now - 2 * HOUR + 10 * MIN },
      ]),
      result: { kind: "count" },
    },
  ];
  const plan = buildPlan({ judged, now, cfg: { ...CLOCK_DEFAULTS, tz: TZ }, synced: {} });
  assert.equal(plan.targets.length, 1);
  assert.equal(plan.targets[0].end - plan.targets[0].start, 10 * MIN);
});

test("a target fully inside a foreign period counts as recorded and is not written", () => {
  const now = at("2026-10-24T12:00:00Z");
  const judged = [
    {
      unit: unitOf("u1", [{ startedAt: now - 2 * HOUR, endedAt: now - 2 * HOUR + 27 * MIN }]),
      result: { kind: "count" },
    },
  ];
  const coverage = [{ start: now - 2 * HOUR - MIN, end: now - 2 * HOUR + 29 * MIN }];
  const plan = buildPlan({ judged, now, cfg: { ...CLOCK_DEFAULTS, tz: TZ }, synced: {}, coverage });
  assert.deepEqual(plan.create, []);
  assert.deepEqual(plan.targets, []);
  assert.equal(plan.covered.length, 1);
  assert.equal(plan.coveredMinutes, 27);
  assert.equal(plan.minutes, 27);
});

test("a partially covered target keeps only the uncovered remainder", () => {
  const now = at("2026-10-24T12:00:00Z");
  const judged = [
    {
      unit: unitOf("u1", [{ startedAt: now - 2 * HOUR, endedAt: now - 2 * HOUR + 30 * MIN }]),
      result: { kind: "count" },
    },
  ];
  const coverage = [{ start: now - 2 * HOUR + 10 * MIN, end: now - 2 * HOUR + 20 * MIN }];
  const plan = buildPlan({ judged, now, cfg: { ...CLOCK_DEFAULTS, tz: TZ }, synced: {}, coverage });
  assert.equal(plan.create.length, 2);
  assert.equal(plan.create[0].start, now - 2 * HOUR);
  assert.equal(plan.create[0].end, now - 2 * HOUR + 10 * MIN);
  assert.equal(plan.create[1].start, now - 2 * HOUR + 20 * MIN);
  assert.equal(plan.create[1].end, now - 2 * HOUR + 30 * MIN);
  assert.equal(plan.coveredMinutes, 10);
  assert.equal(plan.minutes, 30);
});

test("subtractCoverage ignores foreign periods that miss the target and keeps unit keys", () => {
  const base = { start: 0, end: 10 * MIN, unitKeys: ["u1"] };
  const inside = subtractCoverage([base], [{ start: MIN, end: 2 * MIN }]);
  assert.deepEqual(inside.segments, [
    { start: 0, end: MIN, unitKeys: ["u1"] },
    { start: 2 * MIN, end: 10 * MIN, unitKeys: ["u1"] },
  ]);
  const outside = subtractCoverage([base], [{ start: 20 * MIN, end: 30 * MIN }]);
  assert.deepEqual(outside.segments, [base]);
  assert.deepEqual(outside.covered, []);
  const all = subtractCoverage([base], [{ start: 0, end: 10 * MIN }]);
  assert.deepEqual(all.covered, [{ start: 0, end: 10 * MIN, unitKeys: ["u1"] }]);
});

test("TC-C13 synced segments outside this round's judged units are neither patched nor removed", () => {
  const now = at("2026-10-24T12:00:00Z");
  const skipped = { key: "s1:2026-10-24T09:00:00.000Z", runs: [{ startedAt: now - 3 * HOUR, endedAt: now - 3 * HOUR + 30 * MIN }] };
  const judgedUnit = { key: "s2:2026-10-24T10:00:00.000Z", runs: [{ startedAt: now - 2 * HOUR, endedAt: now - 2 * HOUR + 30 * MIN }] };
  const judged = [{ unit: judgedUnit, result: { kind: "count" } }];
  const synced = {
    "2026-10-24": [
      { id: "a-skipped", start: now - 3 * HOUR, end: now - 3 * HOUR + 30 * MIN, unitKeys: [skipped.key] },
      { id: "b-judged", start: now - 2 * HOUR, end: now - 2 * HOUR + 10 * MIN, unitKeys: [judgedUnit.key] },
    ],
  };
  const plan = buildPlan({ judged, now, cfg: { ...CLOCK_DEFAULTS, tz: TZ }, synced });
  assert.equal(plan.remove.includes("a-skipped"), false);
  assert.equal(plan.patch.some((item) => item.id === "a-skipped"), false);
  assert.deepEqual(plan.patch.map((item) => item.id), ["b-judged"]);
});

test("TC-C14 a unit re-judged from count to skip still loses its segment", () => {
  const now = at("2026-10-24T12:00:00Z");
  const unit = { key: "s1:2026-10-24T10:00:00.000Z", runs: [{ startedAt: now - 2 * HOUR, endedAt: now - 2 * HOUR + 30 * MIN }] };
  const synced = {
    "2026-10-24": [{ id: "old", start: now - 2 * HOUR, end: now - 2 * HOUR + 30 * MIN, unitKeys: [unit.key] }],
  };
  const plan = buildPlan({ judged: [{ unit, result: { kind: "skip" } }], now, cfg: { ...CLOCK_DEFAULTS, tz: TZ }, synced });
  assert.deepEqual(plan.remove, ["old"]);
  assert.equal(plan.create.length, 0);
});

test("TC-C15 stitch absorbs a gap under the cap and keeps the tail untouched", () => {
  const first = { start: at("2026-10-24T10:00:00Z"), end: at("2026-10-24T10:10:00Z"), unitKeys: ["u1"] };
  const second = { start: at("2026-10-24T10:13:00Z"), end: at("2026-10-24T10:20:00Z"), unitKeys: ["u1"] };
  const out = stitchRuns([first, second], 5 * MIN);
  assert.equal(out.length, 1);
  assert.equal(out[0].start, first.start);
  assert.equal(out[0].end, second.end);
  assert.equal(out[0].end - out[0].start, 20 * MIN);
  assert.deepEqual(out[0].unitKeys, ["u1"]);
});

test("TC-C16 stitch caps a long gap at five minutes and leaves the rest empty", () => {
  const first = { start: at("2026-10-24T10:00:00Z"), end: at("2026-10-24T10:10:00Z"), unitKeys: ["u1"] };
  const second = { start: at("2026-10-24T10:22:00Z"), end: at("2026-10-24T10:30:00Z"), unitKeys: ["u1"] };
  const out = stitchRuns([first, second], 5 * MIN);
  assert.equal(out.length, 2);
  assert.equal(out[1].start, second.start - 5 * MIN);
  assert.equal(out[1].end, second.end);
  assert.equal(out[1].start - out[0].end, 7 * MIN);
});

test("TC-C17 parallel runs merge into one segment without overlap", () => {
  const first = { start: at("2026-10-24T10:00:00Z"), end: at("2026-10-24T10:20:00Z"), unitKeys: ["u1"] };
  const second = { start: at("2026-10-24T10:10:00Z"), end: at("2026-10-24T10:30:00Z"), unitKeys: ["u2"] };
  const out = stitchRuns([first, second], 5 * MIN);
  assert.equal(out.length, 1);
  assert.equal(out[0].start, first.start);
  assert.equal(out[0].end, second.end);
  assert.deepEqual(out[0].unitKeys, ["u1", "u2"]);
});

test("TC-C18 gapCapMinutes zero records only run time and gapMode merge restores the old binary switch", () => {
  const now = at("2026-10-24T12:00:00Z");
  const unit = {
    key: "s1:2026-10-24T10:00:00.000Z",
    runs: [
      { startedAt: at("2026-10-24T10:00:00Z"), endedAt: at("2026-10-24T10:10:00Z") },
      { startedAt: at("2026-10-24T10:13:00Z"), endedAt: at("2026-10-24T10:20:00Z") },
    ],
  };
  const judged = [{ unit, result: { kind: "count" } }];
  const zero = buildPlan({ judged, now, cfg: { ...CLOCK_DEFAULTS, tz: TZ, gapCapMinutes: 0 }, synced: {} });
  assert.equal(zero.targets.length, 2);
  const merged = buildPlan({ judged, now, cfg: { ...CLOCK_DEFAULTS, tz: TZ, gapMode: "merge" }, synced: {} });
  assert.equal(merged.targets.length, 2);
  assert.equal(merged.targets[0].end - merged.targets[0].start, 10 * MIN);
  assert.equal(merged.targets[1].end - merged.targets[1].start, 7 * MIN);
});

test("TC-C19 segments owned by other units occupy their interval instead of being re-created", () => {
  const now = at("2026-10-24T12:00:00Z");
  const unit = { key: "s1:2026-10-24T09:00:00.000Z", runs: [{ startedAt: now - 3 * HOUR, endedAt: now - 3 * HOUR + 40 * MIN }] };
  const judged = [{ unit, result: { kind: "count" } }];
  const synced = {
    "2026-10-24": [
      { id: "foreign", start: now - 3 * HOUR, end: now - 3 * HOUR + 25 * MIN, unitKeys: ["s9:gone"] },
      { id: "own", start: now - 3 * HOUR + 28 * MIN, end: now - 3 * HOUR + 40 * MIN, unitKeys: [unit.key] },
    ],
  };
  const plan = buildPlan({ judged, now, cfg: { ...CLOCK_DEFAULTS, tz: TZ }, synced });
  for (const segment of plan.targets) {
    const clash = synced["2026-10-24"].filter((item) => item.id === "foreign" && item.start < segment.end && item.end > segment.start);
    assert.equal(clash.length, 0);
  }
  assert.equal(plan.create.length, 0);
  assert.deepEqual(plan.patch.map((item) => item.id), ["own"]);
  assert.equal(plan.patch[0].start, now - 3 * HOUR + 25 * MIN);
  assert.deepEqual(plan.remove, []);
});

test("TC-C20 decayFill is linear between the full and the zero boundary", () => {
  const decay = { fullMinutes: 2, zeroMinutes: 6 };
  assert.equal(decayFill(0, decay), 0);
  assert.equal(decayFill(1 * MIN, decay), 1 * MIN);
  assert.equal(decayFill(2 * MIN, decay), 2 * MIN);
  assert.equal(decayFill(4 * MIN, decay), 2 * MIN);
  assert.equal(decayFill(6 * MIN, decay), 0);
  assert.equal(decayFill(30 * MIN, decay), 0);
});

test("TC-C21 decay keeps a gap under the full boundary and cuts a long one without shifting the start", () => {
  const first = { start: at("2026-10-24T10:00:00Z"), end: at("2026-10-24T10:10:00Z"), unitKeys: ["u1"] };
  const near = { start: at("2026-10-24T10:12:00Z"), end: at("2026-10-24T10:20:00Z"), unitKeys: ["u1"] };
  const merged = stitchRunsDecay([first, near], { fullMinutes: 2, zeroMinutes: 6 });
  assert.equal(merged.length, 1);
  assert.equal(merged[0].start, first.start);
  assert.equal(merged[0].end, near.end);

  const far = { start: at("2026-10-24T10:30:00Z"), end: at("2026-10-24T10:40:00Z"), unitKeys: ["u1"] };
  const split = stitchRunsDecay([first, far], { fullMinutes: 2, zeroMinutes: 6 });
  assert.equal(split.length, 2);
  assert.equal(split[1].start, far.start);
  assert.equal(split[1].end, far.end);
});

test("TC-C22 decay reports the minutes it bridged and the number of bridged gaps", () => {
  const now = at("2026-10-24T12:00:00Z");
  const unit = {
    key: "s1:2026-10-24T10:00:00.000Z",
    runs: [
      { startedAt: at("2026-10-24T10:00:00Z"), endedAt: at("2026-10-24T10:10:00Z") },
      { startedAt: at("2026-10-24T10:14:00Z"), endedAt: at("2026-10-24T10:20:00Z") },
    ],
  };
  const judged = [{ unit, result: { kind: "count" } }];
  const plan = buildPlan({ judged, now, cfg: { ...CLOCK_DEFAULTS, tz: TZ, gapMode: "decay" }, synced: {} });
  assert.equal(plan.targets.length, 2);
  assert.equal(plan.minutes, 18);
  assert.equal(plan.gapMinutes, 2);
  assert.equal(plan.gapCount, 1);

  const zero = buildPlan({ judged, now, cfg: { ...CLOCK_DEFAULTS, tz: TZ, gapMode: "decay", decayZeroMinutes: 4 }, synced: {} });
  assert.equal(zero.targets.length, 2);
  assert.equal(zero.gapMinutes, 0);
  assert.equal(zero.gapCount, 0);
});

test("TC-C23 a record the window edge already trimmed is extended, never shortened again", () => {
  const now = at("2026-10-29T00:00:49Z");
  const unit = {
    key: "s1:2026-10-26T23:45:00.000Z",
    runs: [{ startedAt: at("2026-10-26T23:45:00Z"), endedAt: at("2026-10-27T00:07:00Z") }],
  };
  const judged = [{ unit, result: { kind: "count" } }];
  const synced = {
    "2026-10-27": [{ id: "own", start: at("2026-10-26T23:49:00Z"), end: at("2026-10-27T00:07:00Z"), unitKeys: [unit.key] }],
  };
  const plan = buildPlan({ judged, now, cfg: { ...CLOCK_DEFAULTS, tz: TZ }, synced });
  assert.deepEqual(plan.create, []);
  assert.deepEqual(plan.remove, []);
  assert.equal(plan.patch.length, 1);
  assert.equal(plan.patch[0].start, at("2026-10-26T23:45:00Z"));
  assert.equal(plan.patch[0].end, at("2026-10-27T00:07:00Z"));
  assert.ok(plan.patch[0].start <= synced["2026-10-27"][0].start);
});

test("TC-C24 a segment crossing the edge without a record is created from the edge", () => {
  const now = at("2026-10-29T00:00:49Z");
  const unit = {
    key: "s1:2026-10-26T23:45:00.000Z",
    runs: [{ startedAt: at("2026-10-26T23:45:00Z"), endedAt: at("2026-10-27T00:07:00Z") }],
  };
  const judged = [{ unit, result: { kind: "count" } }];
  const plan = buildPlan({ judged, now, cfg: { ...CLOCK_DEFAULTS, tz: TZ }, synced: {} });
  assert.equal(plan.create.length, 1);
  assert.equal(plan.create[0].start, at("2026-10-27T00:00:00Z"));
  assert.equal(plan.create[0].end, at("2026-10-27T00:07:00Z"));

  const strict = buildPlan({ judged, now, cfg: { ...CLOCK_DEFAULTS, tz: TZ, minSegmentMinutes: 8 }, synced: {} });
  assert.deepEqual(strict.create, []);
});

test("TC-C25 a raised minimum length does not turn a crossing record into a delete", () => {
  const now = at("2026-10-29T00:05:00Z");
  const unit = {
    key: "s1:2026-10-26T23:00:00.000Z",
    runs: [{ startedAt: at("2026-10-26T23:00:00Z"), endedAt: at("2026-10-27T00:10:00Z") }],
  };
  const judged = [{ unit, result: { kind: "count" } }];
  const synced = {
    "2026-10-27": [{ id: "own", start: at("2026-10-26T23:00:00Z"), end: at("2026-10-27T00:10:00Z"), unitKeys: [unit.key] }],
  };
  const plan = buildPlan({ judged, now, cfg: { ...CLOCK_DEFAULTS, tz: TZ, minSegmentMinutes: 10 }, synced });
  assert.equal(plan.targets.length, 1);
  assert.deepEqual(plan.remove, []);
  assert.deepEqual(plan.patch, []);
});

test("TC-C26 a segment splits at the local midnight", () => {
  const parts = splitAtMidnight(at("2026-10-29T15:50:00Z"), at("2026-10-29T16:20:00Z"), TZ);
  assert.deepEqual(parts.map((part) => part.day), ["2026-10-29", "2026-10-30"]);
  assert.equal(parts[0].end - parts[0].start, 10 * MIN);
  assert.equal(parts[1].end - parts[1].start, 20 * MIN);

  const whole = splitAtMidnight(at("2026-10-29T02:00:00Z"), at("2026-10-29T03:00:00Z"), TZ);
  assert.equal(whole.length, 1);
  assert.equal(whole[0].day, "2026-10-29");
  assert.equal(whole[0].start, at("2026-10-29T02:00:00Z"));
  assert.equal(whole[0].end, at("2026-10-29T03:00:00Z"));
});
