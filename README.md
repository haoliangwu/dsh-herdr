# dsh-herdr

Reports the [dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI) lifecycle state to [Herdr](https://herdr.dev)'s agent
panel. When `dsh --profile tui` runs inside a Herdr pane, this plugin makes the pane show up
in the agent panel as `dsh` with a live `idle` / `working` / `blocked` status
— the same mechanism Herdr's own integrations (opencode, pi, omp, …) use.

![Herdr agent panel with dsh](docs/1.png)

> **Dependency:** This plugin is designed for [ccch1mneyyy/dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI) (`@deepseek-harness-tui/dsh-tui >=0.8.5`). It has no effect with other profiles.

## How it works

A process inside a Herdr pane inherits `HERDR_ENV`, `HERDR_PANE_ID`,
`HERDR_BIN_PATH`, and `HERDR_SOCKET_PATH`. The plugin talks to the local
Herdr socket with JSON-lines requests (`pane.report_agent`,
`pane.release_agent`), exactly like Herdr's built-in integrations.

State mapping (only the pane's root agent is reported):

| dsh signal                                        | Herdr state |
| ------------------------------------------------- | ----------- |
| plugin boot                                       | `idle`      |
| `agent/status` → `running`                        | `working`   |
| `agent/status` → `idle`                           | `idle`      |
| session event `approval/asked`                    | `blocked`   |
| session event `approval/decided`                  | prior state |

Every report carries the dsh session id (`agent_session_id`) once a session
exists. On process exit the plugin releases the source's lifecycle authority
(`pane.release_agent`), flushing synchronously so even hard exits reach
Herdr.

Herdr accepts a source's reports only while their `seq` strictly increases
and silently drops stale ones, so the reporter seeds its per-source sequence
from the wall clock at startup — a restarted dsh never falls below the seq a
previous process already used (releases consume seqs too).

Outside a Herdr pane (`HERDR_ENV != 1`) the plugin is a strict no-op.

## Install into a profile

```sh
dsh plugin --profile tui add /path/to/dsh-herdr
```

The `dsh plugin` command adds the package to the profile's dependencies and
its `dsh.profile.bundles` list; the bundle's `cordis.patch.yml` mounts the
`herdr-reporter` row on the host plane. Remove the package from the bundles
list to uninstall.

## Development

```sh
npm install          # dev deps (types only)
bun run typecheck    # tsc --noEmit
bun run build        # bundle to dist/ (reinstall the profile after changes)
bun run smoke        # fake-Herdr-socket end-to-end test
```
