const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

export const CLOCK_DEFAULTS = {
  enabled: false,
  baseUrl: "",
  activityName: "clock",
  activityId: null,
  minSegmentMinutes: 1,
  warnDailyHours: 12,
  changeThresholdMs: MINUTE_MS,
  mergeGapMinutes: 2,
  gapCapMinutes: 5,
  gapMode: "stitch",
  decayFullMinutes: 2,
  decayZeroMinutes: 6,
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

export function splitAtMidnight(start, end, tz) {
  const out = [];
  let from = start;
  while (from < end) {
    const day = dayKey(from, tz);
    const to = Math.min(end, midnightAfter(from, tz));
    out.push({ day, start: from, end: to });
    from = to;
  }
  return out;
}

function midnightAfter(ms, tz) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const pick = (type) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const remaining = (1440 - (pick("hour") * 60 + pick("minute"))) * MINUTE_MS;
  let next = ms - (ms % MINUTE_MS) + remaining;
  while (next <= ms + 24 * HOUR_MS && dayKey(next - 1, tz) === dayKey(ms, tz)) next += MINUTE_MS;
  while (next > ms && dayKey(next - MINUTE_MS, tz) !== dayKey(ms, tz)) next -= MINUTE_MS;
  return next;
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

export function decayFill(gapMs, { fullMinutes, zeroMinutes }) {
  if (!(gapMs > 0)) return 0;
  const gap = gapMs / MINUTE_MS;
  const full = Math.max(0, fullMinutes);
  const zero = Math.max(full + 1, zeroMinutes);
  if (gap <= full) return gapMs;
  if (gap >= zero) return 0;
  return (gapMs * (zero - gap)) / (zero - full);
}

export function stitchRunsDecay(runs, decay) {
  const out = [];
  for (const run of runs) {
    const last = out[out.length - 1];
    if (!last) {
      out.push({ start: run.start, end: run.end, origin: run.origin, unitKeys: [...(run.unitKeys ?? [])] });
      continue;
    }
    const gap = run.start - last.end;
    const start = gap <= 0 ? last.end : run.start - decayFill(gap, decay);
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

export function countedSegments(judged, { gapMs, capMs = null, decay = null }) {
  const out = [];
  for (const entry of judged) {
    if (entry.result.kind !== "count") continue;
    const origin = entry.result.split ? "run-split" : "unit";
    const runs = entry.unit.runs
      .map((run, index) => ({ run, verdict: entry.result.runs?.[index] }))
      .filter(({ run, verdict }) => run.endedAt > run.startedAt && (!entry.result.split || verdict?.kind === "count"))
      .map(({ run }) => ({ start: run.startedAt, end: run.endedAt, origin, unitKeys: [entry.unit.key] }))
      .sort((a, b) => a.start - b.start);
    out.push(...(decay ? stitchRunsDecay(runs, decay) : capMs === null ? mergeSegments(runs, gapMs) : stitchRuns(runs, capMs)));
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

export function countBridgedGaps(judged, cfg, { tz = cfg.tz, day = null } = {}) {
  const decay = cfg.gapMode === "decay"
    ? { fullMinutes: cfg.decayFullMinutes, zeroMinutes: cfg.decayZeroMinutes }
    : null;
  let count = 0;
  for (const entry of judged) {
    if (entry.result?.kind !== "count") continue;
    const runs = entry.unit.runs
      .map((run, index) => ({ run, verdict: entry.result.runs?.[index] }))
      .filter(({ run, verdict }) => run.endedAt > run.startedAt && (!entry.result.split || verdict?.kind === "count"))
      .map(({ run }) => run)
      .sort((a, b) => a.startedAt - b.startedAt);
    for (let index = 1; index < runs.length; index += 1) {
      if (day && dayKey(runs[index - 1].endedAt, tz) !== day) continue;
      const gap = runs[index].startedAt - runs[index - 1].endedAt;
      if (!(gap > 0)) continue;
      const filled = decay
        ? decayFill(gap, decay)
        : cfg.gapMode === "merge"
          ? (gap <= cfg.mergeGapMinutes * MINUTE_MS ? gap : 0)
          : Math.min(gap, cfg.gapCapMinutes * MINUTE_MS);
      if (filled > 0) count += 1;
    }
  }
  return count;
}

export function buildPlan({ judged, now, cfg, synced, coverage = [] }) {
  const segments = cfg.gapMode === "merge"
    ? countedSegments(judged, { gapMs: cfg.mergeGapMinutes * MINUTE_MS })
    : cfg.gapMode === "decay"
      ? countedSegments(judged, { decay: { fullMinutes: cfg.decayFullMinutes, zeroMinutes: cfg.decayZeroMinutes } })
      : countedSegments(judged, { capMs: cfg.gapCapMinutes * MINUTE_MS });
  const from = now - cfg.backfillHours * HOUR_MS;
  const minMs = cfg.minSegmentMinutes * MINUTE_MS;
  const clipped = clipToWindow(segments, { now, hours: cfg.backfillHours });
  const aligned = mergeSegments(clipped.map(alignSegment), 0);
  const targets = filterShort(aligned, minMs);
  const oversize = oversizeDays(targets, { tz: cfg.tz, warnHours: cfg.warnDailyHours });
  const blocked = new Set(oversize.map((item) => item.day));
  const onBlocked = (segment) => blocked.has(dayKey(segment.start, cfg.tz));
  const usable = targets.filter((segment) => !onBlocked(segment));
  const pure = filterShort(
    mergeSegments(clipToWindow(countedSegments(judged, { gapMs: 0 }), { now, hours: cfg.backfillHours }).map(alignSegment), 0),
    minMs,
  ).filter((segment) => !onBlocked(segment));
  const managed = filterShort(mergeSegments(segments.map(alignSegment), 0), minMs)
    .filter((segment) => segment.end > from && !onBlocked(segment));  const todayKey = dayKey(now, cfg.tz);
  const onDay = (segment) => dayKey(segment.start, cfg.tz) === todayKey;
  const sumMinutes = (segments) => Math.round(segments.reduce((sum, segment) => sum + (segment.end - segment.start), 0) / MINUTE_MS);
  const minutes = sumMinutes(usable);
  const pureMinutes = sumMinutes(pure);
  const todayMinutes = sumMinutes(usable.filter(onDay));
  const pureTodayMinutes = sumMinutes(pure.filter(onDay));
  const judgedKeys = new Set(judged.map((entry) => entry.unit.key));
  const owned = (item) => (item.unitKeys ?? []).some((key) => judgedKeys.has(key));
  const live = Object.values(synced ?? {}).flat().filter((item) => item.end > from);
  const foreign = live.filter((item) => !owned(item)).map((item) => ({ start: item.start, end: item.end }));
  const { segments: afterForeign } = subtractCoverage(managed, foreign);
  const { segments: open, covered } = subtractCoverage(afterForeign, coverage);
  const current = live.filter(owned).map((item) => ({ id: item.id, start: item.start, end: item.end }));
  const plan = planReconcile({ targets: open, current, thresholdMs: cfg.changeThresholdMs });
  const edge = Math.floor(from / MINUTE_MS) * MINUTE_MS;
  const create = plan.create
    .map((segment) => ({ ...segment, start: Math.max(segment.start, edge) }))
    .filter((segment) => segment.end - segment.start >= minMs);
  return {
    targets: open,
    minutes,
    gapMinutes: Math.max(0, minutes - pureMinutes),
    gapCount: countBridgedGaps(judged, cfg),
    todayMinutes,
    gapTodayMinutes: Math.max(0, todayMinutes - pureTodayMinutes),
    gapTodayCount: countBridgedGaps(judged, cfg, { tz: cfg.tz, day: todayKey }),
    covered,
    coveredMinutes: Math.round(covered.reduce((sum, segment) => sum + (segment.end - segment.start), 0) / MINUTE_MS),
    blocked: oversize,
    dropped: targets.length - usable.length,
    create,
    patch: plan.patch,
    remove: plan.remove,
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
