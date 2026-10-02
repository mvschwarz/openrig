# Developing OpenRig — gates and lanes

This is the contributor-facing statement of which checks BLOCK a change and which are
advisory. Every pull request to `main` runs `.github/workflows/tests.yml` on a clean GitHub
runner: build and packaging, typecheck, the repository scripts (`npm run test:repo`), each
workspace's test suite (daemon, cli, tui and ui) on macOS without ambient credentials or
external network, and an installed-package scenario (`scripts/run-pr-scenarios.sh`). The root
`package.json` scripts below run the same build, typecheck, repository and test checks locally.

## Blocking gates (must pass before a candidate moves)

| Gate | Command | Covers |
|---|---|---|
| Typecheck | `npm run lint` | daemon + **ui** + cli + tui tsconfigs — UI typecheck STAYS blocking |
| Build | `npm run build` | all workspaces — the UI dist ships in the package, so its build STAYS blocking |
| Repo scripts | `npm run test:repo` | daemon build, script self-tests, docs guard, skill mirror check, context-pack generation check |
| Unit tests | `npm run test:workspaces` | `packages/daemon` + `packages/cli` + `packages/tui` |

`npm test` runs `test:repo` and `test:workspaces` — the blocking set is readable in the
script itself.

## Advisory lane

| Lane | Command | Meaning |
|---|---|---|
| UI unit tests | `npm run test:ui` | runs `packages/ui` vitest at will; NOT part of `npm test` |

## The norm (web-UI freeze at 0.5.0)

Daemon API changes no longer require UI sync or UI verification; the contract mirrors
under `packages/ui/src/hooks/` are no longer proactively maintained; a new `test:ui`
failure signals a moved API contract, not a broken gate.

Browser/interaction testing of the web UI is not a contributor gate. (The packaged
starter-rig agent skills that exercise the UI are product content for user rigs, not
part of this repo's gates.)

## Wording rule

The web UI is **experimental**, in **maintenance mode**, supported **best-effort**;
**the CLI is primary**. There is no scheduled removal and PRs are welcome. Do not
describe the UI with stronger end-of-life language than this section uses.
