# Developing OpenRig — gates and lanes

This is the contributor-facing statement of which checks BLOCK a change and which are
advisory. Every pull request to `main` runs `.github/workflows/tests.yml` on a clean GitHub
runner: build and packaging, typecheck, the repository scripts (`npm run test:repo`), each
workspace's test suite (daemon, cli, tui and ui) on macOS without ambient credentials or
external network, and an installed-package scenario (`scripts/run-pr-scenarios.sh`). The root
`package.json` scripts below run the same build, typecheck, repository and test checks locally,
with one difference: `npm test` does not include the UI suite, which CI runs as
`package-tests (ui)`. Run `npm run test:ui` for it.

## Blocking gates (must pass before a candidate moves)

| Gate | Command | Covers |
|---|---|---|
| Typecheck | `npm run lint` | daemon + **ui** + cli + tui tsconfigs — UI typecheck STAYS blocking |
| Build | `npm run build` | all workspaces — the UI dist ships in the package, so its build STAYS blocking |
| Repo scripts | `npm run test:repo` | daemon build, script self-tests, docs guard, skill mirror check, context-pack generation check |
| Unit tests | `npm run test:workspaces` | `packages/daemon` + `packages/cli` + `packages/tui` |
| UI unit tests | `npm run test:ui` | `packages/ui` vitest. NOT part of `npm test`, but every pull request runs it as `package-tests (ui)` (the `package-tests` matrix in `.github/workflows/tests.yml`) |

`npm test` runs `test:repo` and `test:workspaces`; `npm run test:ui` is the separate UI
suite. Both sets are readable in the root `package.json` scripts.

## Advisory lane

| Lane | Command | Meaning |
|---|---|---|
| Portability report | `node scripts/portability-report.mjs` | lists added lines with machine-specific values; findings never fail it (`.github/workflows/portability-report.yml`) |

## The norm (web-UI freeze at 0.5.0)

Daemon API changes no longer require browser or interaction verification of the UI, and
the contract mirrors under `packages/ui/src/hooks/` are no longer proactively maintained. A
new `test:ui` failure usually signals a moved API contract. Because pull-request CI runs the
UI suite as `package-tests (ui)`, the change that moves the contract has to update the affected
UI test or mirror to pass that check.

Browser/interaction testing of the web UI is not a contributor gate. (The packaged
starter-rig agent skills that exercise the UI are product content for user rigs, not
part of this repo's gates.)

## Wording rule

The web UI is **experimental**, in **maintenance mode**, supported **best-effort**;
**the CLI is primary**. There is no scheduled removal and PRs are welcome. Do not
describe the UI with stronger end-of-life language than this section uses.
