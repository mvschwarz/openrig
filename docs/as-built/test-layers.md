---
kind: as-built
title: Test layers — what to run before you push, and what each layer proves
status: active
applies-when: |
  You changed OpenRig and want to know which checks to run before opening a pull
  request, what each check actually proves, and what CI will run for you. Also
  read it before claiming a stub-agent scenario covers a behaviour.
siblings: [arteries.md, README.md, codemap.md]
last-verified-against-source: 1347d825
last-updated: 2026-10-01
---

# Test layers: what to run before you push, and what each layer proves

> **This page is a map, not the territory.** It was checked against source at `1347d825`
> and it will drift. It is also incomplete on purpose. Before you rely on a command or a
> claim here, read the script it names or run it. If a behaviour is missing from this page
> (or from [arteries.md](arteries.md)), that tells you nothing about whether a change to it
> is safe.

## Short version

For every change, run what the pull-request template asks for:

```sh
npm run build
npm run lint      # typecheck only; there is no formatter or style linter
npm test          # = npm run test:repo && npm run test:workspaces
```

Then add the layers your change calls for, using the ladder below. CI also runs a
network-denied macOS test pass and a containerised installed-package scenario on every PR
to `main`. In the PR description, say which layers you ran and which you could not run.

## The ladder

| Layer | Command | What it proves | What it cannot prove | When to run it |
|---|---|---|---|---|
| Typecheck | `npm run lint` | Builds the daemon, then `tsc --noEmit` passes for daemon, ui, cli and tui | Any runtime behaviour. Formatting. | Every change |
| Build | `npm run build` | All four workspaces compile (the UI also runs `vite build`) | That the *published* package is complete (see Packaging) | Every change |
| Repo checks | `npm run test:repo` | Builds the daemon, then runs `node --test --test-concurrency=1 scripts/*.test.mjs`, `scripts/check-docs-guard.mjs`, `mirror-skills --check` and `generate-context-packs --check` | Package behaviour | Every change. It matters most when you touch `scripts/`, `docs/` or skills. |
| Package suites | `npm run test:workspaces`. One package: `npm run test -w packages/cli`. One file, from the repo root: `npx vitest run packages/cli/test/<file>.test.ts` | Vitest unit and integration tests for daemon, cli and tui. Some of them start real scenario daemons, tmux sessions and stub runners. | The installed package. Real Claude Code or Codex. CI's sandbox conditions (see CI). | Every change (`npm test` covers it) |
| Web UI suite | `npm run test:ui` | jsdom unit tests for `packages/ui` | Real browser rendering | When you touch `packages/ui`, or a daemon API the UI reads. The web UI is in maintenance mode, so this suite is advisory locally and is not part of `npm test`. |
| Generated files | `npm run mirror-skills:check`, `npm run generate-context-packs:check` (both part of `npm test`) | Every copy of each shipped skill matches its recorded hash, and every static context pack passes the daemon's own manifest parser and the leak scan | Whether the skill content is any good | After you edit a shipped skill: edit the same file in every copy that carries it, run `node scripts/regen-edge-digests.mjs`, then the check. The full `npm run mirror-skills` apply needs maintainer-only inputs. See "A shipped skill" in [ARCHITECTURE.md](../../ARCHITECTURE.md#a-shipped-skill). |
| Local gate | `npm run gate` | Lint plus `npm test` on a clean tree, tied to `HEAD`, one run per machine at a time, with a JSON receipt | Anything that lint and `npm test` don't already prove | Optional. Useful when several agents share one machine, or when you want a receipt tied to a commit. |
| Packaging | `npm run build:package`, `npm run test:tui-package`, `bash scripts/smoke-fresh-install.sh` | The publishable `@openrig/cli` assembles, the packed TUI launches, and a fresh install starts a daemon | Behaviour beyond startup | When you touch dependencies, bin entries, build scripts, or files a package ships |
| Stub scenarios, host mode | `node --import tsx packages/daemon/scripts/run-scenarios.mjs [scenario.yaml …]` | A scenario's steps and assertions pass against a scratch daemon, real tmux and `runtime: stub` seats | The installed package. Seeded-regression pairing. Everything under [What a stub can and cannot prove](#what-a-stub-can-and-cannot-prove). | While you write or debug a scenario |
| Stub scenarios, installed package in a container | CI job `installed-scenario`. Before pushing: `DOCKER_HOST=ssh://<your-host> bash scripts/run-pr-scenarios.sh --remote …` | A clean Linux install starts. A claimed queue item survives a daemon restart. A planted fault is caught at the intended assertion. | Native runtimes. Most command families (see [Help wanted](#help-wanted-command-families-without-a-behavioural-scenario)). | Changes that can affect daemon startup, packaging, queue durability or the scenario harness |
| Live-model evals | `npm run eval -w packages/daemon -- --provider rig …` | Whether a real Claude Code seat runs the expected `rig context get <entry>` for natural prompts | Determinism. Codex. Anything without a case. | Changes to shipped skills or context entries meant to steer agents. **Uses provider credits.** |
| Testbed runbooks | `docker/testbed/runbooks/` (manual) | The testbed image itself works as a test environment | Product behaviour | Only when you change the testbed image or the container plumbing |

### Gotchas that cost people time

- **Stale vendored daemon.** `npm run build:package` leaves an assembled copy of the daemon at
  `packages/cli/daemon/` (gitignored). If you change daemon source afterwards,
  `scripts/check-cli-daemon-freshness.test.mjs` inside `test:repo` can fail on the stale copy.
  Re-run `npm run build:package` or delete `packages/cli/daemon/`. `npm run gate` deletes it for you.
- **Local passes, CI fails.** CI runs the package suites with a scratch `HOME`, no
  credentials, and outbound network blocked except to localhost (see below). A test that reads
  your real home directory, a running daemon, the network or a credential can pass on your
  machine and fail in CI.
- **Docs location.** `check-docs-guard` fails if a tracked file under `docs/` sits outside
  `docs/as-built/`, `docs/reference/` or `docs/releases/`. `docs/DESIGN.md` is the one allowed
  exception.

## What CI runs on your pull request

`.github/workflows/tests.yml` runs on pull requests to `main` and on manual dispatch, all on
Node 22. Each suite is its own job, so one failure doesn't hide the others. No provider
credentials are supplied.

| Job | Runner | What it does |
|---|---|---|
| `build-and-package` | ubuntu | `npm ci` and `npm run build`. Then `npm pack --dry-run` for cli, daemon and tui, with each file list uploaded as the `pack-lists` artifact. The job only records the lists; reviewers read them. |
| `typecheck` | ubuntu | `npm run lint` |
| `repo-checks` | ubuntu | `npm run test:repo` |
| `package-tests` | macOS, matrix `daemon`, `cli`, `tui`, `ui` (fail-fast off) | Installs tmux, runs `npm ci` and `npm run build`. Then runs `npm run test -w packages/<pkg>` under `env -i` with a scratch `HOME`/`TMPDIR`/`TMUX_TMPDIR` and a `sandbox-exec` profile that blocks outbound network except localhost and the job's own socket directory. `scripts/ci-macos-process-probe.mjs` runs first. |
| `installed-scenario` | ubuntu | `bash scripts/run-pr-scenarios.sh` (six container runs, described below). Uploads `dist/pr-scenarios/` as `installed-scenario-evidence`, including on failure. |

A second workflow, `.github/workflows/portability-report.yml` (job `portability-report`),
lists lines your PR adds that contain machine-specific values: credentials, home or temp
paths, network addresses, email addresses. It never fails because of a finding. To see the
matched text locally (credentials show only their first characters), run
`node scripts/portability-report.mjs`. By default it compares the
merge-base with `origin/main` against `HEAD`; pass `--staged` to check staged changes instead.

The UI suite is a CI matrix leg even though it is advisory locally. Check your PR's status to
see whether a red UI leg is treated as blocking. Branch-protection settings are not in the
repository.

## The local gate: `npm run gate`

`scripts/gate-lane.mjs` runs two legs: `npm run lint` and `npm run test`. It does not run
`test:ui`, the scenarios or the packaging checks. On top of those legs it:

- holds a machine-wide lock on localhost port 40404 (override with `OPENRIG_GATE_LANE_PORT`).
  A second gate exits 2 straight away instead of waiting.
- refuses a dirty worktree. Refuses a `node_modules` that is a symlink, or `@openrig/*`
  workspace links that resolve outside this worktree. Both are common with shared git worktrees.
- deletes the stale vendored daemon bundle at `packages/cli/daemon/` before the legs run.
- writes `gate-lane-verdict.json` at the repo root (or wherever `OPENRIG_GATE_VERDICT`
  points). The file holds the `HEAD` SHA, per-leg results and durations, and a note of other
  `node`/`vitest`/`tsc` processes running at the time. It fails if `HEAD` changes during the
  run. The file is not gitignored, so don't commit it.

Exit codes: 0 pass, 1 a leg failed, 2 lane busy, 3 the runner itself errored.
`OPENRIG_GATE_LANE_SMOKE=1` skips the legs to test the wiring only, and the verdict records
`smoke: true`.

## Stub-agent scenarios

### What's in the box

| Piece | Where |
|---|---|
| `runtime: stub` adapter | `packages/daemon/src/adapters/stub-runtime-adapter.ts`, with `stub-runner.ts` (the process that runs in the pane), `stub-script.ts` (the launch-script format) and `stub-compaction.ts` / `stub-restore.ts` |
| Scenario format and runner | `packages/daemon/test/helpers/scenario-*.ts`. Step verbs: `up`, `down`, `send`, `restart`, `daemon`, `seed_regression` are bound. `restore`, `emit`, `mutate`, `policy` parse but are unbound. Assertion surfaces: `ps`, `queue`, `stream`, `scope`, `pane`, `transcript`, `tui_socket`, `policy_provenance`. |
| Scenario library | `packages/test-system/scenarios/`: 11 scenarios, 6 stub topologies, `agents/`, `culture.md` |
| Runner fixtures | `packages/daemon/test/fixtures/scenarios/` (`scenario-01-per-seat-scripts`, `scenario-02-baton`, `scenario-10-one-view-state`) |
| Host runner | `packages/daemon/scripts/run-scenarios.mjs` |
| In-container entry and result check | `packages/test-system/ci/run.mjs`, `packages/test-system/ci/result.mjs` |
| PR orchestrator | `scripts/run-pr-scenarios.sh` |
| Image | `docker/testbed/Dockerfile`, built by `scripts/build-testbed-image.sh`; `docker/testbed/Dockerfile.scenarios` is layered on top by `scripts/run-pr-scenarios.sh` |

### Host mode: while you're writing a scenario

```sh
npm run build    # the runner drives packages/cli/dist/bin-wrapper.js
node --import tsx packages/daemon/scripts/run-scenarios.mjs     # the fixture scenario-*.yaml files
node --import tsx packages/daemon/scripts/run-scenarios.mjs packages/daemon/test/fixtures/scenarios/scenario-02-baton.yaml
```

- The runner creates a scratch `HOME`/`OPENRIG_HOME`, its own tmux server and its own
  daemon. It builds the scenario environment from `HOME`, `PATH` and `TERM` only, so your
  shell's daemon-target variables (`OPENRIG_URL`, `OPENRIG_PORT` and similar), `TMUX` and
  `OPENRIG_TEST_CLOCK_NOW` are dropped rather than inherited. It does not touch the daemon or
  tmux server your own session uses.
- It accepts YAML paths only. Any flag, including `--container`, is refused before anything runs.
- It supplies no fault controller, so any scenario with a `seed_regression` step fails loudly
  at that step. That includes the library's `queue-baton-survives-restart`. Use the container
  path to run the seeded pair.
- `scenario-10-one-view-state` declares its own normaliser for its cross-surface `equals`
  check. Whether it passes in host mode has not been verified.

### Container mode: the scenario pack CI runs

In CI the `installed-scenario` job runs `scripts/run-pr-scenarios.sh` with no arguments:
both cases (`fixture` = `scenario-02-baton.yaml`, `library` = `queue-baton-survives-restart.yaml`),
each run three times as healthy, then lost-baton, then healthy. That is six fresh containers.

To run a case before you push, point `DOCKER_HOST` at a Docker engine you control over SSH:

```sh
npm ci
DOCKER_HOST=ssh://<your-host> bash scripts/run-pr-scenarios.sh \
  --remote --case library --mode healthy --out dist/scenario-check
```

- Options: `--case fixture|library` (default: both), `--mode healthy|lost-baton` (default:
  healthy, lost-baton, healthy) and `--out <dir>` (default `dist/pr-scenarios`). Use a fresh
  `--out` directory for each run you want to keep.
- `--remote` accepts only `ssh://` values for `DOCKER_HOST`, and it refuses if
  `DOCKER_CONTEXT` is set. The engine must be Linux on amd64 or arm64. The script reads the
  *server's* platform, so a macOS/arm64 laptop driving a Linux/amd64 engine works.
- Without `--remote`, the script refuses to run anywhere except GitHub Actions on Linux.
- The source build and pack run on your machine. The image build and the containers run on
  the engine. Building the image needs network access for the pinned base image, Node and
  dependencies. The scenario containers have no network.
- The image is built from your working tree but tagged with `git rev-parse HEAD`. Commit
  first, so the tag names what you actually tested.
- It never pushes images. It removes only the containers it named. If the SSH connection
  drops, it prints the name of any container it could not remove.

What happens, in order:

1. `scripts/build-testbed-image.sh` packs `@openrig/cli` from your tree. It installs the
   package into a digest-pinned Debian image with Node, checks `rig --version`, and checks
   that the installed daemon loads. The result is tagged `openrig-testbed:<sha>`.
2. `docker/testbed/Dockerfile.scenarios` adds a bundled copy of
   `packages/test-system/ci/run.mjs` plus the fixture and library scenarios.
3. Each run uses a fresh container: `--network none`, read-only root plus a 512 MB `/tmp`
   tmpfs, `--cap-drop ALL`, `no-new-privileges`, non-root, 2 CPUs, 2 GiB, 256 PIDs and a
   300-second deadline.
4. In lost-baton mode, the runner stops the daemon, changes exactly one queue row in the
   scratch database from `in-progress` to `pending`, and restarts the daemon.
   `packages/test-system/ci/result.mjs` then accepts only one outcome: a failure at the
   post-restart queue assertion, with `baton-1` observed as `pending` at the expected
   destination. A startup error, a timeout or any other failure does not count as a caught
   regression. Healthy runs must pass with no fault armed.

A single healthy run proves that one leg only. The paired fault run is what shows the
assertion can catch the failure.

Adding a new case to this pack today means changing three files:
`scripts/run-pr-scenarios.sh` (the `--case` list), `CASES` in
`packages/test-system/ci/result.mjs`, and the fault controller in
`packages/test-system/ci/run.mjs`, which is currently specific to the baton row.

### What a green stub scenario proves

- The packaged CLI installs into a clean Linux container and starts a daemon.
- `rig up` and `rig down` of a stub topology go through the real daemon, tmux, SQLite and CLI.
- Queue state, read through the shipped `rig queue list` path, survives a daemon restart.
- With the paired seeded run: the assertion fails when that state is broken.

### What a stub can and cannot prove

The stub does not fabricate product outputs. It runs the real daemon, tmux and CLI. But it is
not Claude Code or Codex, and it differs from them in ways that decide what a stub green
means:

| Area | What the stub does at `1347d825` | What that means for your test |
|---|---|---|
| Consuming a message | `stub-runner.ts` runs its launch script once and then idles. It has no stdin reader, socket or other input channel. The default script prints `[stub] scripted reply: acknowledged` at boot, before anything has been sent. | A pane showing a reply, or your echoed text, does not prove the message was consumed. No stub scenario can currently prove "delivered and answered". Separately, `rig send --verify` means "appeared in the pane", not acknowledgement (see `rig send --help`), and the scenario `send` step doesn't pass `--verify` at all. |
| Launch path | `StubRuntimeAdapter` types `node <stub-runner> …` into the pane (`tmux.sendText`, then Enter). Claude Code with an explicit permission mode launches through a managed launch (`ClaudeManagedLaunch.prepare`, `tmux.sendShellCommand`); without one it uses `sendText`. The shell-foreground check in `session-transport.ts` (`unverifiedShellForeground`) runs for every runtime except `terminal`, but its native-process proof is limited to `codex` and `claude-code`. | A stub seat doesn't exercise wrapper, managed-launch or native-process-identity behaviour (the class behind #197). Wrapping the stub in a shell wouldn't change that. |
| Permissions | `validateNativePermissionSelection` accepts only `codex` and `claude-code`. The stub models only the `floor` / `full_bypass` launch posture. | Testing Claude permission modes or per-seat permission selection needs a real runtime. |
| Queue pickup and wake | No stub worker reacts to a nudge by claiming an item, working on it and handing it back. | The baton scenarios prove the claim *survives a restart*. They don't prove delivery, pickup or wake. |
| Reboot / tmux reset | `daemon: {op: restart}` restarts only the scenario daemon, and the tmux server keeps running. No step resets tmux. | Recycled pane IDs and stale bindings after a real reboot (the class behind #141) are not covered by a daemon restart. |
| Multi-rig and same-name identities | The `up` step always uses the scenario's top-level `topology` and ignores a per-step override. No step archives or removes a rig. | Cross-rig scope, same-name generations and archive/remove routing (the class behind #174) need runner work before they can be tested. |
| Step-time restore, compaction, mutation, policy | `restore`, `emit`, `mutate` and `policy` parse, but the runner throws `UnboundActionError` when it reaches them. Behaviours run only from a per-seat launch script (`env.stub_scripts`). A seat `restart` step maps to `rig launch`, which is not native resume or fork. | Step-time compaction and restore, and native resume and fork, are not covered. |
| Skill projection | The stub projects skills into `<cwd>/.openrig/stub/skills/`. Claude Code projects into `<cwd>/.claude/skills/`. | A stub green says nothing about provider-specific projection (the class behind #159). |
| Model and provider | No model, no tokens. Stub scripts refuse `usage_limit` because it only exists on real runtimes. | Model behaviour, provider usage limits and real context usage need live evals or a real runtime. |
| Platform | CI's scenario job runs in a Linux container. | macOS process behaviour is covered by the macOS `package-tests` jobs, not by scenarios. |

The most useful next pieces of harness work, roughly in dependency order:

1. A stub that consumes input and answers a fresh nonce.
2. A model-free test entry point shaped like a provider, that goes through the real native
   adapter and managed launch.
3. Lifecycle and identity steps (tmux reset, archive/remove).
4. Then pickup, wake and restore scenarios.

### Library status

Only `queue-baton-survives-restart` runs in CI (since #243). The other ten scenarios are
authored but not yet runnable as meaningful checks:

| Scenario | Why it doesn't run as a check yet | Smallest useful next step |
|---|---|---|
| `queue-baton-survives-restart` | Runs in CI: healthy / seeded `baton-drop` / healthy | Extend it to handoff, block, resolve and unclaim |
| `clean-lifecycle-no-residue` | The post-`down` "nothing left over" assertion is commented out, because the format has no way to say "empty" | Add a real absence assertion |
| `ps-scope-honesty` | The second `up` reuses the first topology, and the expected match tolerates the other rig | Make `up` honour the per-step topology, then assert the exclusion |
| `send-verify-means-rendered` | The `send` step drops `verify`, and the stub has no input loop | Build the input-consuming stub and assert a response derived from the nonce |
| `home-divergence-preseed-visible` | The pipeline ignores `env.pre_existing_tmux`, and the default script never prints the expected `trust reached` | Recreate the real HOME split and whatever consumes it |
| `compaction-restore-resumes-role` | Step-time `emit` is unbound | Input-triggered hooks plus evidence specific to one seat |
| `stream-emit-durable-replay-live` | Step-time `emit` is unbound | Assert the actual stream contract |
| `policy-posture-survives-structural-edit` | `policy` and `mutate` are unbound | Rewrite around current per-seat permission selection and an observed launch |
| `locked-restore-never-permissive` | `policy` and `restore` are unbound | Keep the invariant (the selection survives a restore) and use current modes |
| `one-view-state-after-mutation-storm` | The validator rejects its bare-list `equals` (`EQUALS_NOT_DECLARATIVE`), and `mutate` is unbound | Declare the comparable fields and real mutations |
| `kill-daemon-mid-handoff` | A pane `send` doesn't create the queue item the next assertion expects, and later assertions use a shape the queue reader doesn't return | Rebuild the setup before treating a red result as meaningful |

In most of these files, `seed_regression` steps that come *after* the assertions are
historical markers, not executable fault injections.

## If your change touches an artery, add or extend a scenario (or say why not)

[arteries.md](arteries.md) lists the behaviours that everything else depends on. If your
diff can affect one, your PR description should do one of these:

- link the scenario that covers it, and say which layer you ran it in;
- add or extend a scenario. For a regression scenario, show that the fixed code passes and
  that the planted old defect fails *at the intended assertion*. A setup crash or a timeout
  doesn't count;
- or say precisely why the stub can't exercise it. Use the table above, which covers
  message consumption, native launch and permissions, tmux reset and so on. Then say what
  you ran instead, for example a manual run with the real runtime.

This is part of normal review, not an extra approval step. It also isn't a claim that
changes outside the arteries map are safe.

## Live-model evals

`packages/test-system/evals/` is a separate check from scenarios. A real seat receives a
natural prompt and decides what to do. A case passes when the seat's transcript shows the
expected `rig context get <entry>` command, in the expected order. Cases live in
`cases/selection.yaml` (10) and `cases/loading.yaml` (4).

```sh
# Harness check: a fake provider fed a JSON map of prompt -> transcript.
# Any prompt without a transcript counts as an error, never as a pass.
npm run eval -w packages/daemon -- --transcripts <transcripts.json> --out <result.json>

# Live run: drives a real Claude Code seat
npm run eval -w packages/daemon -- --provider rig --seat <session> --out <result.json>
npm run eval -w packages/daemon -- --provider rig --seat-spec "$PWD/<one-seat-rig.yaml>" --out <result.json>
```

- **Live runs use provider credits, and the results vary from run to run.** CI never runs them.
- `--provider rig` needs `OPENRIG_HOME` set, and it supports Claude Code seats only. It
  refuses a Codex seat.
- `--seat-spec` runs `rig up` of a scratch rig against **your current daemon**, then
  `rig down` at the end. `--seat` attaches to an existing seat and leaves it running.
- `evals/rig-seat/example-scratch-rig.yaml` sets `permission_policy: builtin:yolo` and
  `cwd: "."`. It also references `local:agents/blank`, and no such agent directory ships
  beside it. Read the file and expect to adapt it before you use it.
- Before any run, the runner builds the production context package in a temp directory and
  refuses if any case's entry doesn't resolve in it.
- `npm test` covers the harness without a model: the case schema, the grader, the fixtures
  and production entry resolution (`packages/daemon/test/eval-*.test.ts`).

## Docker testbed runbooks

`docker/testbed/runbooks/` holds manual procedures, L0 to L6, that you run on a machine with
Docker. They check the testbed image itself:

- L0: resolve the pinned base image and the stub asset list
- L1: PTY allocation
- L2: tmux server lifecycle
- L3: the daemon inside a container, settling a stub rig
- L4: the scenario environment still refuses a foreign daemon target inside a container
- L5: several containers acting as named hosts on one Docker network
- L6: the scenario runner driving a scenario through a container

Use them when you change `docker/testbed/`, `scripts/build-testbed-image.sh` or the
container staging helpers. Ordinary PRs don't need them. They were written before the CI
scenario job and contain internal planning references, so treat them as procedures to adapt,
not as current status.

## Help wanted: command families without a behavioural scenario

> This list may be stale. It was taken from the `rig --help` tree of 0.6.3: 85 visible
> top-level families. At `1347d825`, `packages/cli/src/index.ts` registers 85 top-level
> commands. Before picking one up, check `packages/test-system/scenarios/`, the cases in
> `scripts/run-pr-scenarios.sh`, and the current `rig --help`.
> One scenario doesn't cover a family's every option, sequence or platform. A `--help`
> check only proves the command is discoverable. Existing unit tests are not counted here.
> They exist, but this list is about behavioural scenarios.

Status today: `queue` has partial coverage, namely create, claim and list, plus the claim
surviving a restart. `up`, `down` and `daemon` are used by the existing scenarios but have no
scenario of their own. Everything else has none.

Before you start, two honest constraints:

- Today's step verbs can't run arbitrary `rig` commands. Many rows below need a runner
  binding first. One proposal (not implemented) is a single structured-argv step that runs
  the installed CLI through the existing `rigBin`, instead of one new verb per command.
- Rows that need a seat to *answer* (anything with "nonce") depend on the input-consuming
  stub described above.

| Group | Family | Proposed first check (observable result) |
|---|---|---|
| lifecycle | `start` | Restore two stopped stub seats. Both answer distinct fresh nonces, and no second daemon starts. |
| lifecycle | `daemon` | start/status/stop/restart. Port, process and persisted queue identity agree through public commands. |
| lifecycle | `bootstrap` | Bootstrap a minimal stub spec. Seats come up ready and the selected spec is the one used. |
| lifecycle | `up` | Launch two stub seats. Each consumes its own send. Relaunching doesn't duplicate identities. |
| lifecycle | `down` | Tear down one rig. Its panes are gone, a sibling rig still answers, retained data follows the docs. |
| lifecycle | `create` | Create a one-seat rig through the public path. It appears and answers without a hand-written topology. |
| lifecycle | `launch` | Fresh, relaunch, resume and fork on provider-shaped fixtures. Correct restored token, one live process. |
| reads | `status` | Two rigs in different states. Status matches their exact identities and transitions. |
| reads | `ps` | Two rigs with overlapping seat names. Rig and node filters return exactly the intended members. |
| reads | `usage` | Deterministic stub telemetry. top and series respect seat and time bounds. Missing data isn't reported as zero. |
| reads | `health` | Known fresh, stale and cleared findings. Scope, explain and diagnosis values match the fixture. |
| continuity | `snapshot` | Snapshot two seats. Rig, membership and snapshot bytes survive a daemon restart. |
| continuity | `restore` | Restore after a daemon and tmux reset. Seat identity and nonce answers survive. |
| continuity | `agent-image` | create/show/pin/unpin/delete for a provider-shaped fixture. References and identity match. |
| continuity | `fork` | Fork at a known history token. The child keeps the prefix with its own identity, and the parent still answers. |
| continuity | `restore-check` | One restorable and one missing transcript. Readiness tells them apart without relaunching. |
| continuity | `restore-packet` | write/read/validate round trip. A malformed packet fails clearly. |
| continuity | `compact-plan` | Scripted history and usage fixtures. Candidates and exclusions match thresholds, and nothing is compacted. |
| continuity | `compact` | Input-driven compact and restore keep the role and token. Messages before and after reach the same seat. |
| continuity | `handover` | Scripted predecessor and successor. Context is delivered before the rebind, and the successor answers. |
| recovery | `crash-cart` | Stop only the scratch daemon. The output names paths and state, and the command changes nothing. |
| recovery | `preflight` | Ready and missing-dependency fixtures produce named checks without launching seats. |
| recovery | `doctor` | Healthy and damaged scratch installs. Exact diagnosis, no automatic repair. |
| recovery | `destroy` | In a disposable scenario HOME only. Removes the intended state and keeps explicitly retained markers. |
| registry | `gateway` | Add, show, update and remove a synthetic human. Reads match exact fields, and removal sticks. |
| registry | `host` | add/list/select/rename isolated entries that resolve to fixture endpoints. Pairing needs two container daemons. |
| coordination | `parked` | An owed item with a stopped worker is reported. A held worker with a live wake is distinguished. |
| coordination | `stream` | emit/list/show/archive an exact item. A restart and a bounded watch keep the order with no duplicates. |
| coordination | `queue` | (partial) Next: handoff, block, resolve and unclaim, each with exact items and destinations. |
| coordination | `project` | Acquire a lease, classify one item twice, read one projection. The wrong holder cannot act. |
| coordination | `view` | Register a view over known items. list/show return the exact filtered result after a mutation. |
| coordination | `watchdog` | Register one short wake, see one response, stop it, prove no further deliveries. |
| coordination | `workflow` | validate/compile/instantiate a tiny flow. It transitions and resumes after a restart with no duplicate queue work. |
| coordination | `chatroom` | send/history/topic/clear in a scratch room. A bounded watcher sees exactly the ordered messages. |
| coordination | `heartbeat` | Known execution-proof and missing-closure fixtures report the right status. Empty output isn't completion. |
| authoring | `export` | Export a stub rig, then validate and re-import it. Membership and configuration are equivalent. |
| authoring | `import` | Import a minimal spec, and the export matches it. Malformed input leaves state unchanged. |
| authoring | `package` | validate/plan/install/rollback in scratch. Installed files and prior state match. |
| authoring | `requirements` | Complete and missing capability fixtures produce the right named requirements. |
| authoring | `bundle` | create/inspect/install a local bundle and round-trip it. A missing asset gives a named failure. |
| authoring | `agent` | Validate a good and a malformed stub AgentSpec. The diagnostic names the bad field. |
| authoring | `spec` | validate/audit/preflight/show a minimal spec, with predictable diagnostics for a malformed field. |
| authoring | `specs` | add/show/preview/rename/remove a library fixture. A missing reference fails explicitly. |
| authoring | `workspace` | validate/doctor known roots plus one missing-frontmatter case. Reports the exact affected path. |
| authoring | `config` | set/get/reset a scratch key and init a workspace. Readback and files match the requested root. |
| presentation | `ui` | Open the URL through a fake browser executable and read a local UI route. Rendering is out of scope. |
| presentation | `tui` | Drive the TUI command bar and socket over two stub rigs. select, mutate and back show exact identities. |
| presentation | `terminal` | open/status/views against a fake terminal-app endpoint. Correct target and layout arguments. |
| adoption | `discover` | One unmanaged and one owned scratch tmux session. Only the intended candidate is discovered. |
| adoption | `attach` | Attach to the intended seat. `whoami` reports it without duplicating the process. |
| adoption | `bind` | Bind one discovered pane. A different, already-occupied identity is refused. |
| adoption | `adopt` | Adopt two scratch sessions. PIDs and history are preserved, and the identities become addressable. |
| adoption | `reconcile-session` | Rebind a hand-resumed provider-shaped fixture without starting or typing into another process. |
| adoption | `unclaim` | Release an adopted seat. The tmux process and its history stay alive. |
| adoption | `release` | Release one rig's claimed sessions. Processes survive, and a sibling rig is unchanged. |
| identity | `archive` | Archive an old same-name generation. The current one stays routable, and the old data is kept. |
| identity | `unarchive` | Unarchive a retained generation without taking over another live seat. |
| identity | `remove` | Remove an archived generation or one member. Only that identity goes, and a reused name still routes. |
| identity | `whoami` | Inside each stub seat, it returns that seat, not a sibling or the caller. |
| identity | `seat` | Status, held-message guard, stop/launch and resume token keep the right process and permissions. |
| integration | `mcp` | Serve against a scratch daemon. One listed tool's value matches CLI state. |
| integration | `slack` | Manifest and config round trip, plus deterministic inbound and outbound fixture requests. No real Slack account. |
| integration | `ask` | Search fixture transcripts via a fake model endpoint. Citations resolve to the stored lines. |
| integration | `file` | Copy a fixture payload through isolated transport endpoints. Verify bytes and paths. |
| integration | `env` | A fixture service-backed rig. status/logs/down reflect that service and stop only it. |
| delivery | `transcript` | Ordered, unique stub output. The selected seat's transcript contains no other seat's token. |
| delivery | `send` | Send a fresh nonce and require an answer derived from it. Boot text or echo can't pass. |
| delivery | `capture` | A unique token in the pane. Wrong-seat, tail and not-found cases are told apart. |
| delivery | `broadcast` | Broadcast a nonce to a rig or pod. Each intended seat answers once, and an excluded seat gets nothing. |
| delivery | `walk` | Walk two pieces through an input-consuming stub. Order is kept, and a bad piece isn't reported as delivered. |
| context | `context` | add/get/compose/trace/profile over a fixture project. Output bytes, order and roots match. |
| context | `plugin` | list/show/used-by/validate a fixture plugin. A missing resource is not the same as a valid empty selection. |
| context | `skill` | Resolve and audit a fixture skill, then inspect the projection the consumer actually gets. |
| context | `mode` | set/effective/cite/unset at nested scopes. Precedence holds, and the inherited value returns after unset. |
| context | `startup-proof` | Submit a proof from a real stub identity. Check the stored attribution and the duplicate behaviour. |
| permissions | `policy` | Apply and read an explicit permission selection using a provider-shaped fixture. It survives a restore, and the default is unchanged. |
| accounts | `auth` | Synthetic auth files in scratch: save, list, validate, switch. No provider contact, no real credentials. |
| accounts | `provider` | Synthetic account, binding and signal state. The precheck refuses where it should, and a switch keeps seat history. |
| topology | `expand` | Add a pod to a live stub rig. Old seats survive, and new members answer nonces. |
| topology | `add` | Add one seat. Exact binding, siblings preserved, and the duplicate-name behaviour is explicit. |
| topology | `grow` | Grow two seats. Identities are unique, config is inherited, and existing history is kept. |
| topology | `shrink` | Remove a pod. Unrelated seats still answer, and the removed membership is gone. |
| onboarding | `setup` | Scripted newcomer answers against synthetic providers. No install or login for an unused provider. |
| work | `scope` | Create a mission and a slice. move/progress/notes/graph readback keep identity and paths. |
| work | `proof` | add/judge/show evidence in a fixture scope. Readiness updates without overwriting earlier proof. |

How to make a case useful:

- Assert actual state or content, not just exit code 0. Where ordinary use includes bad
  input, add an invalid or missing input case too.
- Reuse the existing runner and the installed CLI. Don't add a second scenario engine.
- If a scenario exposes an existing product bug, keep the failing case and open an issue.
  Include the exact source revision, the shortest failing sequence, and the intended versus
  observed result. Don't weaken the assertion to make it pass. Keep "the harness setup
  failed" separate from "the product misbehaved".
- A check that only covers the success path is still useful. Just don't call it a
  regression detector until you have seen its negative case fail.

## Existing docs in this area that are out of date

Read these with care. This page notes them and proposes no changes.

- `packages/test-system/README.md`: says the scenarios "DO NOT run" until a runner lands.
  The runner exists, and one library scenario runs in CI. Its layout lists `fixtures/*.yaml`,
  a directory that no longer exists (the topologies live in `scenarios/`). It also says the
  emit behaviours don't exist yet. Launch-script `emit` now exists, but step-time `emit` is
  still unbound. `packages/test-system/ci/README.md` is the current description of the CI
  scenario job.
- `packages/test-system/scripts/README.md` and `packages/test-system/ROUTING.md` are
  dependency-routing notes from when the scenarios were first written. Several of the items
  they list have since landed. Treat them as history.
- `packages/test-system/evals/README.md`: says cases are `cases/*.ts`. They are
  `cases/selection.yaml` and `cases/loading.yaml`. Its "build in progress" status line is old.
- `docs/reference/developing.md`: says "There is no external CI at this tip". In fact
  `.github/workflows/tests.yml` runs on every PR to `main`, and its `package-tests` matrix
  includes `ui`. Its description of `test:repo` leaves out the `generate-context-packs --check` step.
- `docker/testbed/runbooks/`: see above. They are manual procedures that predate the CI job.
