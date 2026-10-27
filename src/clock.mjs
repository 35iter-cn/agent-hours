const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

export const CLOCK_DEFAULTS = {
  enabled: false,
  baseUrl: "https://focus.35iter.cn",
  activityName: "clock",
  activityId: null,
  minSegmentMinutes: 1,
  warnDailyHours: 12,
  changeThresholdMs: MINUTE_MS,
  mergeGapMinutes: 2,
  gapCapMinutes: 5,
  gapMode: "stitch",
  backfillHours: 48,
  maxWritesPerRun: 120,
  syncedTtlDays: 7,
};

export function dayKey(ms, tz) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(ms));
  const pick = (type) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
}

export function runSegments(runs) {
  return runs
    .filter((run) => Number.isFinite(run.startedAt) && Number.isFinite(run.endedAt) && run.endedAt > run.startedAt)
    .map((run) => ({ start: run.startedAt, end: run.endedAt }));
}

export function unionSegments(segments, gapMs) {
  const sorted = [...segments].sort((a, b) => a.start - b.start);
  const out = [];
  for (const segment of sorted) {
    const last = out[out.length - 1];
    if (last && segment.start - last.end <= gapMs) {
      last.end = Math.max(last.end, segment.end);
      continue;
    }
    out.push({ start: segment.start, end: segment.end });
  }
  return out;
}

export function alignSegment(segment) {
  return {
    ...segment,
    start: Math.floor(segment.start / MINUTE_MS) * MINUTE_MS,
    end: Math.ceil(segment.end / MINUTE_MS) * MINUTE_MS,
  };
}

export function mergeSegments(segments, gapMs) {
  const sorted = [...segments].sort((a, b) => a.start - b.start);
  const out = [];
  for (const segment of sorted) {
    const last = out[out.length - 1];
    if (last && segment.start - last.end <= gapMs) {
      last.end = Math.max(last.end, segment.end);
      if (segment.origin && segment.origin !== last.origin) last.origin = "mixed";
      last.unitKeys = [...new Set([...(last.unitKeys ?? []), ...(segment.unitKeys ?? [])])];
      continue;
    }
    out.push({ ...segment, unitKeys: [...(segment.unitKeys ?? [])] });
  }
  return out;
}

export function stitchRuns(runs, capMs) {
  const out = [];
  for (const run of runs) {
    const last = out[out.length - 1];
    if (!last) {
      out.push({ start: run.start, end: run.end, origin: run.origin, unitKeys: [...(run.unitKeys ?? [])] });
      continue;
    }
    const gap = run.start - last.end;
    const start = gap <= 0 ? last.end : run.start - Math.min(gap, capMs);
    if (run.origin && run.origin !== last.origin) last.origin = "mixed";
    last.unitKeys = [...new Set([...(last.unitKeys ?? []), ...(run.unitKeys ?? [])])];
    if (start <= last.end) {
      last.end = Math.max(last.end, run.end);
      continue;
    }
    out.push({ start, end: run.end, origin: run.origin, unitKeys: [...(run.unitKeys ?? [])] });
  }
  return out;
}

export function countedSegments(judged, { gapMs, capMs = null }) {
  const out = [];
  for (const entry of judged) {
    if (entry.result.kind !== "count") continue;
    const origin = entry.result.split ? "run-split" : "unit";
    const runs = entry.unit.runs
      .map((run, index) => ({ run, verdict: entry.result.runs?.[index] }))
      .filter(({ run, verdict }) => run.endedAt > run.startedAt && (!entry.result.split || verdict?.kind === "count"))
      .map(({ run }) => ({ start: run.startedAt, end: run.endedAt, origin, unitKeys: [entry.unit.key] }))
      .sort((a, b) => a.start - b.start);
    out.push(...(capMs === null ? mergeSegments(runs, gapMs) : stitchRuns(runs, capMs)));
  }
  return out;
}

export function filterShort(segments, minMs) {
  return segments.filter((segment) => segment.end - segment.start >= minMs);
}

export function clipToWindow(segments, { now, hours }) {
  const from = now - hours * HOUR_MS;
  return segments
    .map((segment) => ({ ...segment, start: Math.max(segment.start, from) }))
    .filter((segment) => segment.end > segment.start);
}

export function oversizeDays(segments, { tz, warnHours }) {
  const limit = warnHours * HOUR_MS;
  const sums = new Map();
  for (const segment of segments) {
    const key = dayKey(segment.start, tz);
    sums.set(key, (sums.get(key) ?? 0) + (segment.end - segment.start));
  }
  return [...sums.entries()]
    .filter(([, ms]) => ms > limit)
    .map(([day, ms]) => ({ day, minutes: Math.round(ms / MINUTE_MS) }));
}

export function planReconcile({ targets, current, thresholdMs = MINUTE_MS }) {
  const create = [];
  const patch = [];
  const remove = [];
  const used = new Set();
  for (const target of [...targets].sort((a, b) => a.start - b.start)) {
    const match = [...current]
      .filter((item) => !used.has(item.id) && item.start < target.end && item.end > target.start)
      .sort((a, b) => a.start - b.start)[0];
    if (!match) {
      create.push(target);
      continue;
    }
    used.add(match.id);
    if (Math.abs(match.start - target.start) > thresholdMs || Math.abs(match.end - target.end) > thresholdMs) {
      patch.push({ id: match.id, start: target.start, end: target.end });
    }
  }
  for (const item of current) {
    if (!used.has(item.id)) remove.push(item.id);
  }
  return { create, patch, remove };
}

export function subtractCoverage(segments, coverage) {
  const covered = [];
  let rest = [...segments];
  for (const block of [...coverage].sort((a, b) => a.start - b.start)) {
    const next = [];
    for (const segment of rest) {
      if (block.end <= segment.start || block.start >= segment.end) {
        next.push(segment);
        continue;
      }
      if (block.start <= segment.start && block.end >= segment.end) {
        covered.push({ start: segment.start, end: segment.end, unitKeys: [...(segment.unitKeys ?? [])] });
        continue;
      }
      covered.push({ start: Math.max(block.start, segment.start), end: Math.min(block.end, segment.end) });
      if (block.start > segment.start) next.push({ ...segment, end: block.start });
      if (block.end < segment.end) next.push({ ...segment, start: block.end });
    }
    rest = next;
  }
  return { segments: rest, covered };
}

export function buildPlan({ judged, now, cfg, synced, coverage = [] }) {
  const segments = cfg.gapMode === "merge"
    ? countedSegments(judged, { gapMs: cfg.mergeGapMinutes * MINUTE_MS })
    : countedSegments(judged, { capMs: cfg.gapCapMinutes * MINUTE_MS });
  const clipped = clipToWindow(segments, { now, hours: cfg.backfillHours });
  const aligned = mergeSegments(clipped.map(alignSegment), 0);
  const targets = filterShort(aligned, cfg.minSegmentMinutes * MINUTE_MS);
  const oversize = oversizeDays(targets, { tz: cfg.tz, warnHours: cfg.warnDailyHours });
  const blocked = new Set(oversize.map((item) => item.day));
  const usable = targets.filter((segment) => !blocked.has(dayKey(segment.start, cfg.tz)));
  const from = now - cfg.backfillHours * HOUR_MS;
  const judgedKeys = new Set(judged.map((entry) => entry.unit.key));
  const owned = (item) => (item.unitKeys ?? []).some((key) => judgedKeys.has(key));
  const live = Object.values(synced ?? {}).flat().filter((item) => item.end > from);
  const foreign = live.filter((item) => !owned(item)).map((item) => ({ start: item.start, end: item.end }));
  const { segments: afterForeign } = subtractCoverage(usable, foreign);
  const { segments: open, covered } = subtractCoverage(afterForeign, coverage);
  const current = live.filter(owned).map((item) => ({ id: item.id, start: item.start, end: item.end }));
  return {
    targets: open,
    minutes: Math.round(usable.reduce((sum, segment) => sum + (segment.end - segment.start), 0) / MINUTE_MS),
    covered,
    coveredMinutes: Math.round(covered.reduce((sum, segment) => sum + (segment.end - segment.start), 0) / MINUTE_MS),
    blocked: oversize,
    dropped: targets.length - usable.length,
    ...planReconcile({ targets: open, current, thresholdMs: cfg.changeThresholdMs }),
  };
}

export function groupByDay(records, tz) {
  const out = {};
  for (const record of records) {
    const key = dayKey(record.start, tz);
    (out[key] ??= []).push(record);
  }
  return out;
}

export function pruneSynced(synced, { now, tz, ttlDays }) {
  const out = {};
  for (const [day, records] of Object.entries(synced ?? {})) {
    const anchor = Date.parse(`${day}T00:00:00Z`);
    if (Number.isFinite(anchor) && now - anchor > ttlDays * 24 * HOUR_MS) continue;
    const kept = records.filter((record) => record.end >= now - ttlDays * 24 * HOUR_MS);
    if (kept.length) out[day] = kept;
  }
  return out;
}

export function pruneMissing(synced, liveIds, { windowFrom }) {
  const out = {};
  let dropped = 0;
  for (const [day, records] of Object.entries(synced ?? {})) {
    const kept = records.filter((record) => record.end < windowFrom || liveIds.has(record.id));
    dropped += records.length - kept.length;
    if (kept.length) out[day] = kept;
  }
  return { synced: out, dropped };
}
