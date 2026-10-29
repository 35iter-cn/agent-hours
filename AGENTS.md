# AGENTS.md

Conventions for anyone — human or agent — changing this repository. Read
`README.md` first: its **Design rules**, the layout table, and the clock-segment
section are the contract and are not repeated here.

## Non-negotiables

- **Never commit to `main` directly.** Branch, push, open a PR, squash-merge.
- **This repository is the runtime.** The hourly timer runs
  `~/code/agent-hours/src/hours.mjs`; the copy under `~/.pi/agent/git/…` is the pi
  extension install. Keep them in step, and make source changes here.
- **A timekeeping change is a product change.** Altering how gaps, units, or
  `count`/`skip` become billed time needs a spec plus the before/after numbers
  from a `--dry-run-clock` run. Never nudge a default on the way past.
- **`--dry-run-clock` stays read-only.** No Clock write, no notice, no
  `decisions.json` write, no digest line. Any change that lets a dry run reach
  the outside world is a regression.
- **`bun test` green before a push.**

## Tests

`bun test` runs `test/<module>.test.mjs`, one file per module. Name cases
`TC-<group><n>` — `TC-C20` for clock segments, `TC-D1` for dry runs. Ids are
stable; never reuse or renumber them.

Assert the behaviour a user can see, not that a function exists. When a change
touches a number in the notice, assert that number. A case that would also pass
on the unpatched code proves nothing.

`bun run test:integration` is separate: real judge, real clock write, cleanup in
`finally`. It is skipped unless `AGENT_HOURS_E2E=1`, so the default run never
touches the network.

## Deploying

The timer is a `Type=oneshot` unit on `*-*-* *:00:00`, so a source change takes
effect at the next hour — no restart, no install step:

```bash
git -C ~/code/agent-hours pull --ff-only
```

A change to `clock.gapMode` re-plans the last `clock.backfillHours` (48) hours, so
switching modes also rewrites the previous day. Narrow `backfillHours` for one
round when only today should move.

Judging is cached by the request and output text only. Editing
`~/.config/agent-hours/judge-prompt.json` therefore never re-judges historical
units, while `runHash` — used by split units — does change with the prompt.

## Where things live

| Path | What |
| --- | --- |
| `src/hours.mjs` | the round: judge, plan, notify, digest |
| `src/clock.mjs` | segments: stitch, decay, merge, reconcile, day limits |
| `src/clock-client.mjs` | Clock HTTP calls |
| `src/ledger.mjs`, `src/extension.ts` | ledger row format and the pi extension that writes it |
| `src/repair.mjs`, `src/salvage.mjs` | closing rows whose process died |
| External binaries | Called by name from `PATH` (`agent-relay`); the systemd user environment (`~/.config/environment.d/`) owns `PATH`, so neither the unit nor the sources set it |
| `src/judge/`, `src/reporter.mjs` | verdicts and delivery |
| `systemd/` | the hourly timer |

State lives outside the repo, in `~/.config/agent-hours/`: `config.json`,
`judge-prompt.json`, `decisions.json`, `ledger/`, `synced.json`, `digest/`,
`review/`, `logs/`. Nothing there is committed.
