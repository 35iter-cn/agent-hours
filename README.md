# agent-hours

Turn accounting for coding agents: a pi extension writes one ledger row per turn,
a service judges those turns and reports the totals.

```
agent turn ──▶ pi extension ──▶ ledger jsonl ──▶ service ──▶ reporter hook
                                                        └──▶ judge (optional)
```

## Install

```bash
pi install git:github.com/35iter-cn/agent-hours@v0.1.0   # the ledger extension
git clone https://github.com/35iter-cn/agent-hours ~/code/agent-hours
```

## Layout

| path | role |
| --- | --- |
| `src/extension.ts` | pi extension: opens a ledger row on `agent_start`, closes it on `agent_settled` / `session_shutdown` |
| `src/ledger.mjs` | ledger format: `open` / closing rows, serialization, append |
| `src/heartbeat.mjs` | per-session heartbeat, used to bound a row that was closed by a hard kill |
| `src/repair.mjs` | reconciliation: closes rows whose process died, at its last heartbeat |
| `src/salvage.mjs` | the single-row closure repair uses |
| `src/hours.mjs` | service: read ledger, build units, judge, report |
| `src/reporter.mjs` | pluggable reporter (`command` / `http` / `none`) |
| `bin/agent-hours.mjs` | `report`, `repair` |
| `systemd/` | hourly timer |
| `examples/` | configuration examples, no real values |

## Judging

A unit is judged from three blocks: what the user asked, an excerpt of what the
agent produced, and a session context block — the session name the agent picked
plus the repositories and paths that turn touched. The context says where the
work landed, which the request and the output often leave out. Old rows are
backfilled from their session file on first judgment. The context feeds the
request only: it is not part of the cache key, so judged units are never
re-judged because of it.

Nothing identifying lives in this repo: credentials come from an env file or the
environment (`envFile`, `env:NAME`), and the judging prompt is a user file.

## Test

```bash
bun run test              # unit: 117 cases, no network
bun run test:integration  # end to end: real judge + real clock api
```

`test/unit/` holds the pure cases. `test/integration/hours.e2e.test.mjs` runs the
whole chain — ledger fixture in `test/fixtures/ledger/` → `run()` → real judge →
real clock write → reporter stub — then asserts the created period and deletes
it; cleanup also runs in `finally`, so a failing assertion still leaves no trace
in the timesheet. It is skipped unless `AGENT_HOURS_E2E=1`, which is why the
default `bun run test` never touches the network.

## Clock segments

A `count` unit contributes the time its runs actually occupy, plus a bounded
share of the gap between consecutive runs of the same unit — that gap is the
human reading the reply and thinking before the next turn.

`clock.gapMode` picks how that share is computed:

| mode | gap handling |
| --- | --- |
| `stitch` (default) | a gap under `gapCapMinutes` (5) is added whole; a longer gap still shifts the next segment back by `gapCapMinutes` |
| `decay` | `gap <= decayFullMinutes` (2) counts whole, the span up to `decayZeroMinutes` (6) decays linearly to zero, and a longer gap is not bridged at all |
| `merge` | binary switch on `mergeGapMinutes` (2); the pre-stitch behaviour |

`decay` produces more, shorter segments than `stitch` on the same ledger; that is
expected, because an unbridged gap becomes a real hole in the timesheet.

The notify line follows the plan's landing dates. A round that only writes today
collapses to `本轮 +48 分钟 · 记在 14:02–14:50`; a round that also writes an earlier
day lists every day it touched, each with its own delta, span and running total,
so the morning notice for a round that ran past midnight still says which day the
minutes belong to.

## Dry runs

`--dry-run` writes nothing at all: no Clock call, no notice, no `decisions.json`
update, no digest line. `--dry-run-clock` means the same thing for the whole
round — it only prints the plan — and is the intended way to compare two
timekeeping settings before switching.
