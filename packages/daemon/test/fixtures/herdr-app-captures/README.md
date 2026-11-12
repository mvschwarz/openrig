# Captured herdr-app and herdr-core fixtures

These 44 capture files (indexed in `index.json` and `index-after-down.json`, 46 JSON files in total) record real request/reply exchanges captured from a live `herdr-app` and `herdr-core` (`hc`) running inside an isolated headless Linux sandbox (`Weston` + `Xwayland`, software Vulkan):

- **Versions captured:** `herdr-app 0.1.13`, `hc 0.1.18`
- **Schema:** `herdr-app-capture/v1` (indexed in `index.json`)
- **Channels:**
  - `app-socket` (`$HERDR_APP_HOME/herdr-app.sock`, one JSON line per connection): `status`, `ls`, `commands`, `do` (`layout.switch`, `layout.select`, `space.*`, `pane.*`, `tab.*`), definite error replies (`error-*`), and 5 s main-thread timeout/late-apply behavior (`timeout-window-busy`, `timeout-do-applied-later`, `uncertain-no-reply`).
  - `hc-cli` (`hc <subcommand> --json`): `run --bg --no-parent`, `ls --label`, `get`, `kill`, and structured error bodies.

## What is tested against these captures vs simulated

- `packages/daemon/test/herdr-app-transport.test.ts` runs `classifyAppReply` and the Rig layout's transport assumptions directly against all captured `app-socket` replies in this directory.
- `packages/daemon/test/herdr-app-provider.test.ts` exercises multi-step provider lifecycle, rollback, reconciliation, and tmux keyboard handoff against an in-memory `World` fake modeled on these captured shapes.

## Sanitization rule

Every path in a committed capture must use the `<sandbox>/...` placeholder. No hostnames, user home directories, usernames, or tokens may appear in any fixture file.

## Recapturing

Run a private `herdr-core` + `herdr-app` instance with its own `HERDR_APP_HOME`, `HC_SESSION`, and `HC_SOCKET` in a headless display sandbox, record each JSON line sent and received along with the `herdr-app` and `hc` version strings, replace the temporary sandbox root with `<sandbox>`, and update `index.json`.
