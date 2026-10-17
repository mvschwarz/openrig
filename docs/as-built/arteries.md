---
kind: as-built
title: Arteries — where a small change has a large effect
status: active
applies-when: |
  You are about to change, or review a change to, an area that many other paths depend on:
  message delivery, launch and resume, the queue, rig identity, skill projection, native
  process observation, migrations, or restore. Read this to see what depends on the area and
  what broke there before, then go and read the code.
siblings: [README.md, test-layers.md]
prerequisite-reads: [../../ARCHITECTURE.md]
last-verified-against-source: e8f0ab340db773392ec8be75b072d1c0f3068a50
last-updated: 2026-10-08
---

# Arteries: where a small change has a large effect

## Read this first: this map is not the territory

- **This page is a zoomed-out view, not a description of OpenRig.** It names a few areas where
  small changes caused large regressions before. OpenRig is much larger than this page. Code,
  behaviour and risk that are not listed here exist, and some of it is riskier than anything below.
- **It is incomplete by construction.** A pull request is not safe because its files are missing
  from this list.
- **It may be stale.** It was checked against commit `e8f0ab34`. Files and dependencies move. If
  this page and the code disagree, the code is right; fix the page.
- **Use it to change altitude, then go to the ground:** read the code, run the commands, check the
  behaviour. When you are lost, go and look rather than leaning on this page.

## The arteries

Paths are relative to `packages/`. The key files are entry points, not the full extent of each
area.

| Artery | Key files | What depends on it | Past regressions and lessons |
|---|---|---|---|
| **Message delivery to seats** | `daemon/src/domain/session-transport.ts`, `daemon/src/domain/seat-delivery-guard.ts`, `daemon/src/adapters/tmux.ts` | Every `rig send`, queue wake, nudge, watchdog wake and handoff | #150 (the fix for #142) stopped typing into a bare shell. It then refused managed Codex seats (fixed by #171 before release) and every Claude seat launched with an explicit permission mode, which shipped in 0.6.2 as #197 (fixed by #220). The delivery guard's rule that a name must resolve to exactly one target, added in #109 (0.6.0), was involved in #141 (fixed by #151), the delivery half of #174 (fixed by #181) and #188 (fixed by #189). Since #310/#327, a Claude seat whose runtime can't be observed still receives ordinary messages with a warning; only a plain idle shell or the wrong recipient is refused. An OpenRig notice (an `@system` sender such as the watchdog) to a terminal seat is refused too. |
| **Launch, relaunch, resume** | `daemon/src/adapters/claude-code-adapter.ts`, `daemon/src/domain/claude-managed-launch.ts`, `daemon/src/adapters/codex-runtime-adapter.ts`, `daemon/src/domain/codex-daemon-support.ts`, `daemon/src/domain/seat-launch-environment.ts`, `daemon/src/domain/native-resume-probe.ts`, `daemon/src/domain/startup-orchestrator.ts` | Every seat start, restore and permission mode, plus the non-interruptive, `permission_policy`, effort, kernel operational-authority and team permission-default settings that each launch and resume command carries | Always setting `CLAUDE_CONFIG_DIR` gave explicit-mode Claude seats a blank config (#154). #225 fixed which config home is selected, and #565 writes the onboarding and trust bootstrap into that home. Codex seats launch with `--no-daemon` only when `codex --help` shows support (#69, #77); when support is unknown, OpenRig refuses to launch, so a failing or slow `codex --help` blocks the seat. The readiness window defaults to 30 seconds and can time out under load (#182); since #643 it is configurable as `runtime.readiness_timeout_seconds` (env `OPENRIG_RUNTIME_READINESS_TIMEOUT_SECONDS`, 1–600). A git worktree's `.git` file broke the Codex sandbox (#121; see #126). #618 moved non-managed Claude, Codex and Pi launches behind the seat launch environment, and #628, #638 and #666 followed within days. |
| **Queue claim, pickup, wakes** | `daemon/src/domain/queue-repository.ts`, `daemon/src/domain/queue-pickup.ts`, `daemon/src/domain/queue-wake-ladder.ts`, `daemon/src/routes/require-sender-identity.ts`, `cli/src/client.ts` | All durable work between seats | After a slow `/healthz`, the CLI host-qualified a local sender and claims failed (#131, fixed by #135). Done-and-closed items read as stalled forever (#164, fixed by #176). |
| **Rig identity: same names, archived and deleted rigs** | `daemon/src/domain/rig-repository.ts`, `daemon/src/domain/rig-lifecycle-service.ts`, `daemon/src/domain/rig-teardown.ts`, `daemon/src/domain/seat-handover-service.ts`, `daemon/src/domain/running-name-guard.ts` | Seat resolution, `rig remove`, restore, importing a rig from YAML | Archived rigs still matched seat references, and `rig remove` killed another rig's live seat with the same name (#174, fixed by #181). Replacing stopped same-name rig generations on YAML import followed in #196. |
| **Projection of skills and files** | `daemon/src/domain/rigspec-instantiator.ts`, `daemon/src/domain/projection-planner.ts`, and each runtime adapter's `project()` (Claude Code, Codex, Pi, OMP, stub) | What every agent is given at start | Codex seats skipped skills that a Claude sibling had already projected (#159, fixed by #162). File-shaped entries failed with ENOTDIR (fixed by #185). |
| **Native process observation** | `daemon/src/domain/native-process-lineage.ts` (parses `ps -Ao pid,ppid,pgid,tpgid,ucomm,lstart,command`) | Liveness, identity verdicts, delivery checks | Processes whose command name contains a space were dropped (#134, fixed by #82). Non-English locales broke the date parsing (fixed by #239, which runs `ps` with `LC_ALL=C`). #220 also changed this file to recognise managed Claude seats behind launch wrappers. Claude identity proof (wrappers, launcher shims, conversation rotation, effort, version-named binaries, launch `--settings`) changed ten more times after 0.6.3. |
| **Schema and migrations** | `daemon/src/db/migrations/`, `daemon/src/db/all-migrations.ts`, `daemon/src/db/migrate.ts` | Every install, and every upgrade of a long-lived install | Parallel pull requests pick the same next number: #112 adds `086_rig_kernel_variant` while `main` already has `086_classification_fields_and_attempts`, and #155 and #195 landed as 090 and 091. `migrate.ts` applies by migration name in name order, so a duplicate number is not skipped, but its order relative to the other migration changes; 093 is unused at `e8f0ab34`. A long-lived install upgrading across several releases applies many migrations in one start, against real data. |
| **Restore and recovery** | `daemon/src/domain/restore-orchestrator.ts`, `daemon/src/adapters/{claude,codex,pi,omp}-resume.ts`, `daemon/src/domain/reconciler.ts`, `daemon/src/domain/restore-check-service.ts`, `daemon/src/domain/startup-orchestrator.ts`, `daemon/src/adapters/tmux.ts` | Reboots, power loss, daemon restarts | Detached seats kept stale tmux pane ids after a reboot (#141, fixed by #151 in `tmux.ts`). `restore-check` read queue files and Claude hooks from a fixed shared-docs path (#130); #139 made it use the configured root, and #328 replaced the queue-file check with a probe of the daemon's queue store and checks the selected Claude hooks. After a fresh relaunch, a stale Codex restore attention flag never clears (#116). Full-restore recovery of OMP seats is open (#41). |

## How reviews use this page

- **Find where the effect lands.** A reviewer notes which artery a pull request touches, if any,
  and what depends on it.
- **At an artery, review the effect, not only the diff.** Whatever the diff size, the reviewer
  states the downstream effects and checks behaviour with a scratch reproduction or a test.
- **Away from the arteries,** small pull requests keep a normal review. Scrutiny goes where the
  effect is.

## The scenario rule

**A pull request that touches an artery adds or extends a stub-agent scenario, or says in its
description why it cannot.** Reviewers check for one or the other. Scenarios live in
`packages/test-system/scenarios/`; [ARCHITECTURE.md](../../ARCHITECTURE.md#a-scenario) says how to
write and run one, and [test-layers.md](test-layers.md) says what each test layer can and cannot
catch.

The goal is that every artery has at least one scenario whose seeded regression fails, so a small
change to an artery meets a real end-to-end check before it merges, not only a reviewer's reading.

### Scenario coverage today

At commit `e8f0ab34`. For why the stub cannot reach some of these yet, see "What a stub can and
cannot prove" in [test-layers.md](test-layers.md).

- **Queue durability across a daemon restart: covered.** CI runs
  `queue-baton-survives-restart.yaml` healthy, then with a seeded `baton-drop` fault that must
  fail, then healthy again (#243). It runs `rig queue claim` and checks the destination after the
  restart, but pickup, wakes and claim-identity edge cases (such as the #131 sender case) have no
  scenario yet.
- **Delivery (the #197 class): not covered.** The stub runtime has no input behaviour, so it cannot
  exercise delivery to a managed wrapper; `send-verify-means-rendered.yaml` is not admitted to CI
  for that reason (`packages/test-system/ci/README.md`).
- **Addressing and rendered delivery: partial.** CI runs the transcript and capture stub scenarios
  in passing form, and the capture scenario catches a seat resolved by member-name prefix.
  `send-renders-in-addressed-pane.yaml` and `down-stops-every-seat.yaml` run with the local runner
  only. `stub-cli-journeys.integration.test.ts` checks that a verified send lands in the addressed
  pane and not its sibling. None of these proves a seat consumed a message.
- **Restore (the #141 class): not covered.** The scenario runner does not bind the `restore` verb
  yet; it fails with `UnboundActionError`.
- **Rig identity (the #174 class): not covered.** No library scenario sets up a same-name archived
  or removed rig.
- **Projection (the #159 class): not coverable with `runtime: stub`,** which projects skills into its
  own `.openrig/stub/skills/` directory. Use adapter-level unit tests.
- **Native process observation: unit tests only** (for example
  `packages/daemon/test/codex-process-observation.test.ts`, `native-ps-locale.test.ts` and
  `send-runtime-not-running.test.ts`).
- **Migrations: unit guards only** (`migration-fixture-parity.test.ts`,
  `startup-migrations-mirror.test.ts`). Every scenario starts from an empty database, so upgrading
  an existing database is not covered.
- **Launch:** every scenario's `up` goes through the real `rig up`, instantiation and startup
  orchestration with stub seats. The stub adapter types its runner directly; Claude Code, Codex
  and Pi seats launch through the seat launch environment (`seat-launch-environment.ts`), which
  no scenario reaches. Real Codex launch and handover run only in two opt-in daemon tests
  (`OPENRIG_E2E_REAL_CODEX=1`, which needs tmux, `codex` and a Codex login). The CI containers
  have no provider CLIs or credentials.

## Regression log

When a regression reaches a release, add one line: date, issue, artery, and which layer missed it
(the layers are named in [test-layers.md](test-layers.md)). Each line should end up as a scenario.

- 2026-09-30, #197 (0.6.2), delivery: review saw a small diff in isolation; CI had no managed
  explicit-mode Claude seat; the project's own day-to-day seats use the default launch path.
- 2026-09-29/30, #141, #174, #188 (after 0.6.0), delivery and rig identity: reviews of #109 did not
  see the downstream effect of the exactly-one-target rule.
