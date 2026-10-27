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
| `src/salvage.mjs` | closure for a run whose process died without writing one |
| `src/hours.mjs` | service: read ledger, build units, judge, report |
| `src/reporter.mjs` | pluggable reporter (`command` / `http` / `none`) |
| `bin/agent-hours.mjs` | `report`, `repair` |
| `systemd/` | hourly timer |
| `examples/` | configuration examples, no real values |

Nothing identifying lives in this repo: credentials come from an env file or the
environment (`envFile`, `env:NAME`), and the judging prompt is a user file.

## Verify

```bash
bun test                                   # 117 cases
bun src/hours.mjs --dry-run --dry-run-clock # one round, no notices, no Clock writes
```

`--dry-run` prints the report instead of sending it; `--dry-run-clock` skips Clock
writes. `decisions.json` in the config dir caches verdicts per unit hash.

### Integration

`test/integration.hours.test.mjs` runs the whole chain against the real judge and
the real clock API: it writes a ledger fixture into a temp config dir, runs one
round, asserts the created clock period and removes it again. It is skipped
unless asked:

```bash
AGENT_HOURS_E2E=1 bun test test/integration.hours.test.mjs
```

Cleanup runs in `finally`, so a failed assertion still removes the test periods.
