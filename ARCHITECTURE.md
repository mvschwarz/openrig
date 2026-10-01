# OpenRig architecture

> **This map is not the territory.** It is a zoomed-out guide for finding your way around the
> code. It is incomplete by design and it may be stale. Where it disagrees with the code, the code
> is right; please fix the page. Every path, symbol, count and command below was checked against
> commit `1347d825` (`v0.6.3-33-g1347d825c`). Each count shows the command that produced it, so you
> can re-run it.

## What OpenRig is

OpenRig runs a team of coding agents on your machine as one system. A local daemon keeps the team's
state in SQLite and runs each agent as an ordinary Claude Code or Codex session (or a plain
terminal, a Pi runner, or a scripted test stub) inside tmux. People and agents drive it through the
`rig` CLI, a terminal UI (TUI) and an MCP server, all of which talk to the daemon over local HTTP.
The agents themselves are unmodified. What OpenRig adds is the coordination around them: launching
and restoring agents, delivering messages, keeping durable work in a queue, and giving each agent
the right skills and context.

## Packages

| Directory | Package | What it is | How it ships |
|---|---|---|---|
| `packages/daemon` | `@openrig/daemon` (private) | The daemon: HTTP routes, domain services, SQLite migrations, runtime adapters, built-in specs, skills, plugins, static context-pack sources | Copied into `@openrig/cli` |
| `packages/cli` | `@openrig/cli` | The `rig` command, the MCP server, daemon start and stop | The only published package |
| `packages/tui` | `@openrig/tui` (private) | The terminal UI | Copied into `@openrig/cli`; opened by `rig tui`, by bare `rig` in a terminal, or by the `openrig-tui` bin |
| `packages/ui` | `@openrig/ui` (private) | The React web UI, in **maintenance mode**: it still ships and runs, but gets no new feature work. The CLI and TUI are the supported surfaces | Built files copied into `@openrig/cli` and served by the daemon |
| `packages/test-system` | none (not an npm workspace) | The stub-agent scenario library, the CI scenario harness, live-model eval cases | Not shipped |

**What bundles what.** `packages/cli/package.json` publishes `LICENSE`, `dist`, `daemon`, `ui`,
`tui` and `scripts`. `scripts/build-package.sh` (the CLI's `prepublishOnly`) builds the daemon, UI,
TUI and CLI, then assembles them inside `packages/cli/`: the daemon's `dist`, `assets`, `specs` and
`policies`, the generated context packs and a copy of `docs/reference/` go under `daemon/`; the UI
build goes to `ui/dist`; the TUI build goes to `tui/dist`. So `docs/reference/` ships to every
user; `docs/as-built/` and this file do not.

**Sharing code between packages.** The CLI and TUI import daemon code only through the subpaths in
the `exports` field of `packages/daemon/package.json` (18 at this commit), for example
`@openrig/daemon/attention`, which points at `packages/daemon/src/attention-surface.ts`. The CLI
uses 16 of them and the TUI uses 2. In development they resolve through the npm workspace. At
package time `scripts/rewrite-daemon-imports.mjs` rewrites them to the shipped `daemon/dist` copy
and fails the build on a specifier with no `exports` entry. To share new daemon code, add a
`*-surface.ts` file and an `exports` entry.

## The request path

```
  rig (CLI)            TUI            MCP server (rig mcp serve, stdio)
       \                |                /
        +---- HTTP to the daemon (loopback, port 7433 by default) ----+
                                |
  packages/daemon/src/server.ts      createApp(): context middleware, /healthz, app.route("/api/...")
                                |
  packages/daemon/src/routes/        one Hono router per area; reads services with c.get(...)
                                |
  packages/daemon/src/domain/        services, repositories, orchestrators, event bus
              /                 |                  \
     SQLite (db/)       tmux (adapters/tmux.ts)    runtime adapters (adapters/*-adapter.ts)
                                                     claude-code, codex, pi, terminal, stub
```

**Inside the daemon** (`packages/daemon/src/`):

- **Startup.** `index.ts` is the process entry: it resolves where to listen, starts the server and
  runs the periodic queue sweeps. It calls `createDaemon()` in `startup.ts`, which opens the
  database (`db/connection.ts`: WAL mode, foreign keys on), runs `migrate(db, ALL_MIGRATIONS)`,
  constructs every service and adapter, and passes them to `createAppWithWebSocket(deps)` in
  `server.ts`.
- **`server.ts`.** `createApp(deps)` installs one `app.use("*", ...)` middleware that puts each
  service on the request context (`c.set("<name>" as never, deps.<name>)`), serves `/healthz`, and
  mounts each router with `app.route("/api/<area>", ...)`. Unknown `/api/*` paths get a JSON 404;
  other GET requests serve the web UI's built files.
- **`routes/`.** Thin handlers. For example, `routes/ps.ts` reads `psProjectionService` from the
  context and returns its entries as JSON. `routes/terminal-ws.ts` registers the terminal
  WebSocket, and `routes/require-sender-identity.ts` is a shared helper rather than a router.
- **`domain/`.** The behaviour: repositories over SQLite (`rig-repository.ts`,
  `queue-repository.ts`, `session-registry.ts`), orchestration (`startup-orchestrator.ts`,
  `node-launcher.ts`, `rigspec-instantiator.ts`), message delivery (`session-transport.ts`,
  `seat-delivery-guard.ts`) and events (`event-bus.ts`). Larger areas have their own
  subdirectories, such as `gateway/`, `provider/`, `policies/`, `scope/`, `context-packs/` and
  `mission-control/`.
- **`adapters/`.** The outside world. `tmux.ts` wraps tmux. The five `RuntimeAdapter`
  implementations launch each runtime and project skills and files into it. `cmux.ts` and
  `compose-services-adapter.ts` cover other integrations.
- **`db/`.** `connection.ts`, `migrate.ts`, `all-migrations.ts` and `migrations/`.
- **`middleware/auth-bearer-token.ts`.** The bearer-token check for operator write routes, plus
  the loopback and Tailscale bind detection used at startup.
- **Live updates** go out as server-sent events: `routes/events.ts` uses Hono's `streamSSE`, and
  the TUI subscribes to `/api/activity/events`.
- **State** lives in `$OPENRIG_HOME` (default `~/.openrig`). The database is `openrig.sqlite`
  there (`daemon-db-path.ts`).

**The clients:**

- **CLI.** `createProgram()` in `packages/cli/src/index.ts` registers every top-level command;
  the commands live in `packages/cli/src/commands/`. Most are thin clients: they call a daemon route
  through `DaemonClient` (`packages/cli/src/client.ts`) and render the result. A few lifecycle
  helpers open the database file directly. Bare `rig` in a terminal opens the TUI
  (`packages/cli/src/front-door.ts`).
- **MCP.** `createMcpServer(client)` in `packages/cli/src/mcp-server.ts` registers the tools over
  the same `DaemonClient`. `rig mcp serve` (`packages/cli/src/commands/mcp.ts`) runs it on stdio.
- **TUI.** `packages/tui/src/daemon-client.ts` is its only HTTP module. It reads existing daemon
  projections, for example `/api/ps`, `/api/rigs/summary` and `/api/queue/list`, and the
  `/api/activity/events` stream when the daemon offers it. The daemon URL comes from `--url`,
  `OPENRIG_URL`, or `http://127.0.0.1:7433`. Agents can drive a running TUI through its control
  socket (`packages/tui/src/socket-server.ts`).
- **Web UI.** Served by the daemon from the bundled `ui/dist`.

**In a development checkout,** `rig daemon start` prefers `packages/daemon/dist` over the bundled
copy (`resolveDaemonPath` in `packages/cli/src/daemon-lifecycle.ts`), and the TUI launcher prefers
`packages/tui/dist` (`packages/cli/src/front-door.ts`). Rebuild the package you changed. A daemon
that is already running keeps running the code it started with.

## Key counts

At commit `1347d825`. Run these from the repository root to refresh them.

| What | Count | Command |
|---|---|---|
| Database migrations | 89 (latest: `089_classification_identity_provenance.ts`) | `git ls-files packages/daemon/src/db/migrations \| wc -l` |
| Files in `routes/` | 67 | `git ls-files packages/daemon/src/routes \| wc -l` |
| ... of which create a Hono router | 65 | `git grep -l 'new Hono' -- packages/daemon/src/routes \| wc -l` |
| `app.route(...)` mounts in `server.ts` | 69 | `grep -c 'app.route(' packages/daemon/src/server.ts` |
| Top-level `rig` commands | 85 | `grep -c 'program.addCommand(' packages/cli/src/index.ts` |
| Runtime adapters | 5 (`claude-code`, `codex`, `pi`, `terminal`, `stub`) | `git grep -l 'implements RuntimeAdapter' packages/daemon/src \| wc -l` |
| MCP tools | 18 | `grep -c 'server.tool(' packages/cli/src/mcp-server.ts` |
| Daemon `exports` subpaths | 18 | `node -p 'Object.keys(require("./packages/daemon/package.json").exports).length'` |
| Library scenarios | 11 | `grep -l '^scenario:' packages/test-system/scenarios/*.yaml \| wc -l` |

## Where to add things

Each recipe names the files to touch. Read a neighbouring example before you start; the code is
the authority.

### A CLI command

1. Create `packages/cli/src/commands/<name>.ts` exporting a function that returns a commander
   `Command` and takes optional injected dependencies. `packages/cli/src/commands/unarchive.ts`
   is a short example.
2. In the action, get the daemon with `getDaemonStatus(...)` and `daemonStatusGuard(status)`
   (`packages/cli/src/daemon-lifecycle.ts`), then call it with
   `new DaemonClient(getDaemonUrl(status))` (`packages/cli/src/client.ts`). Offer `--json` for
   agents, and set `process.exitCode` on failure.
3. Register it in `createProgram()` in `packages/cli/src/index.ts` with
   `program.addCommand(...)`. If it takes injected dependencies, add them to `ProgramDeps` in the
   same file.
4. Add `packages/cli/test/<name>.test.ts`. `packages/cli/test/archive.test.ts` shows how tests
   inject mocked lifecycle dependencies.
5. If the command needs new daemon behaviour, add a route as well.

### A daemon route

1. Create `packages/daemon/src/routes/<area>.ts` with a Hono router. Both styles exist: a
   constant (`export const psRoutes = new Hono()` in `routes/ps.ts`) and a factory
   (`whoamiRoutes()` in `routes/whoami.ts`).
2. Read services from the request context with `c.get("<name>" as never)`. Keep the behaviour in
   `packages/daemon/src/domain/`.
3. Mount it in `createApp()` in `packages/daemon/src/server.ts` with
   `app.route("/api/<area>", ...)`, above the `/api/*` 404 catch-all.
4. A new service needs three more edits: a field on `AppDeps` and a `c.set(...)` line in
   `server.ts`, and its construction in `createDaemon()` in `packages/daemon/src/startup.ts`.
5. Test it the way `packages/daemon/test/whoami-routes.test.ts` does: build a small Hono app,
   `c.set` the service, mount the router and call `app.request(...)`. `createFullTestDb()` in
   `packages/daemon/test/helpers/test-app.ts` gives you an in-memory database migrated with the
   test fixture list (`migrationsForFullTestDb`).

### A database migration

1. Create `packages/daemon/src/db/migrations/<NNN>_<name>.ts` exporting a `Migration`
   (`{ name: "<NNN>_<name>.sql", sql: "..." }`; the type is in `packages/daemon/src/db/migrate.ts`).
   `089_classification_identity_provenance.ts` is a one-line example.
2. Take the next number after the highest on `main` (089 at this commit). Parallel pull requests
   often pick the same number, so check again and renumber if `main` moved before you merge.
3. Import it in `packages/daemon/src/db/all-migrations.ts` and append it to `ALL_MIGRATIONS`.
   Startup runs exactly that list (`startup-migrations-mirror.test.ts` pins this).
4. Add it to `migrationsForFullTestDb` in `packages/daemon/test/helpers/test-app.ts`, or list it in
   `migrationsForFullTestDbExclusions` with a reason. `migration-fixture-parity.test.ts` fails
   otherwise.
5. `migrate()` sorts migrations by name and records each applied name in `schema_migrations`, so
   an install that already applied a migration never runs it again. Editing a migration that has
   shipped changes nothing for those installs; add a new one instead. A long-lived install applies
   every new migration on its next start, against real data.

### A runtime adapter

1. Implement `RuntimeAdapter` from `packages/daemon/src/domain/runtime-adapter.ts`: `runtime`,
   `listInstalled`, `project`, `deliverStartup`, `launchHarness` and `checkReady`. The smallest
   implementation is `packages/daemon/src/adapters/terminal-adapter.ts`; the scripted test double
   is `stub-runtime-adapter.ts`.
2. Register it in `packages/daemon/src/startup.ts`. The adapter maps are keyed by runtime name:
   `adapters:` (for the pod instantiator) and `runtimeAdapters:`. The context monitor has its own
   map for the runtimes it samples.
3. Accept the runtime name in rig spec validation: `SUPPORTED_RUNTIMES` in
   `packages/daemon/src/domain/rigspec-preflight.ts`. Other runtime lists, such as `RuntimeHint` in
   `domain/discovery-types.ts` and `LEGACY_KNOWN_RUNTIMES` in `domain/rigspec-schema.ts`, may need
   it too; search for an existing runtime name such as `"pi"` to find them.
4. Launch, projection and readiness are arteries. Read
   [docs/as-built/arteries.md](docs/as-built/arteries.md) first.

### A shipped skill

Skills ship from three copies in this repository (the "edges"), listed in
`scripts/skill-edge-layout.generated.json`:

| Edge | Path | Layout |
|---|---|---|
| `spec` | `packages/daemon/specs/agents/shared/skills/` | by category (`core`, `pm`, `pods`, `process`) |
| `plugin` | `packages/daemon/assets/plugins/openrig-core/skills/` | flat |
| `canonical` | `skills/_canonical/` | public mirror of the `spec` copy |

Each skill in the layout file lists which edges carry it. At this commit, 33 skills are in `spec`
and `canonical`, 17 only in `plugin`, and 2 in all three.

- `npm run mirror-skills:check` (part of `npm test`) hashes every file in each edge and compares the
  hashes with `scripts/skill-edge-digests.generated.json`. It also fails on a `SKILL.md` the layout
  does not list.
- The full apply, `npm run mirror-skills`, regenerates all three edges from the maintainers' skill
  source, which lives outside this repository. It needs `OPENRIG_SKILL_CANON_ROOT` and three
  authority-file environment variables, so an outside contributor cannot run it.
- **To fix a skill:** edit the file in every edge that carries it (same bytes), run
  `node scripts/regen-edge-digests.mjs` to refresh the hashes from disk, then run
  `npm run mirror-skills:check`. Say in the pull request that you edited mirrored skill files: the
  next full apply regenerates these copies from the maintainers' source, so the change has to land
  there too.
- **To add a skill:** open an issue first. Its layout entry is generated from files that are not
  in this repository.
- Every shipped skill also becomes a context pack at package time (next recipe).

### A context pack

- **Static packs** are hand-written: a directory under `packages/daemon/context-packs-src/<name>/`
  with a `manifest.yaml` and its files. Keep `version: "0"` in the manifest; the generator stamps
  the package version. A pack file may be a symlink to a file under `docs/reference/`, so a
  reference document has one source (for example `help/help.md` points to
  `docs/reference/help.md`). Any other symlink fails the build. There are 5 static packs at this
  commit.
- **Generated packs** go to `packages/daemon/context-packs/`, which is gitignored and never edited
  by hand. `scripts/generate-context-packs.mjs` builds it at package time from every shipped skill
  and every static pack.
- `npm run generate-context-packs:check` (part of `npm test`) validates every pack through the
  daemon's own manifest parser, so build the daemon first. It also runs the leak scan over the
  static sources, including the `docs/reference/` files they link to.
- The daemon serves the shipped packs through `rig context get`; `startup.ts` registers the bundled
  directory as its built-in root.

### A scenario

Scenarios run the real CLI, daemon, tmux and SQLite with scripted stub agents (`runtime: stub`)
and no model cost.

1. Add `packages/test-system/scenarios/<defect-class>.yaml`, named for the class of bug it
   catches. Topology fixtures sit beside it (`*-stub.yaml`).
2. The format is checked by `validateScenario` in
   `packages/daemon/test/helpers/scenario-schema.ts`. Step verbs: `up`, `down`, `send`, `restart`,
   `restore`, `emit`, `mutate`, `policy`, `seed_regression`, `daemon`, plus `expect`. `expect` may
   only read shipped surfaces: `ps`, `queue`, `stream`, `scope`, `pane`, `transcript`,
   `tui_socket`, `policy_provenance`.
3. Today the runner binds `up`, `down`, `send`, `restart` and `daemon`. `restore`, `emit`,
   `mutate` and `policy` fail with `UnboundActionError`, and `seed_regression` needs a fault
   controller (`packages/daemon/test/helpers/scenario-real-deps.ts`).
4. Write a header comment naming the defect class and the seed: what a seeded regression plants,
   and which `expect` must catch it. A scenario counts only as a pair: it passes on healthy code
   and fails on the seeded run (`packages/test-system/README.md`).
5. **Run it on your machine** after `npm run build`, from a shell that is not inside tmux:
   `node --import tsx packages/daemon/scripts/run-scenarios.mjs <file.yaml>`. It uses a private
   daemon and a private tmux server, and refuses to start if `TMUX` is set. It supplies no fault
   controller, so a `seed_regression` step fails there; the seeded pair runs in the container
   path.
6. **CI.** The `installed-scenario` job runs `scripts/run-pr-scenarios.sh` in disposable,
   network-less containers built from the packed package. It runs two cases, both built around
   queue durability (`library` is `queue-baton-survives-restart.yaml`). Adding a case today means
   changing three files: the `--case` list in `scripts/run-pr-scenarios.sh`, `CASES` in
   `packages/test-system/ci/result.mjs`, and the fault controller in
   `packages/test-system/ci/run.mjs`. [docs/as-built/test-layers.md](docs/as-built/test-layers.md)
   covers both run modes, running a case on your own Docker host, and what a stub can and cannot
   prove.

## Guards you will meet

`npm test` runs `test:repo` (builds the daemon, runs `node --test scripts/*.test.mjs`, the docs
guard, `mirror-skills --check` and `generate-context-packs --check`) and then the daemon, CLI and
TUI suites. `npm run test:ui` runs the web UI suite separately. `npm run lint` typechecks all four
packages.

- **Docs guard** (`scripts/check-docs-guard.mjs`). Under `docs/`, git may track only
  `docs/as-built/`, `docs/reference/`, `docs/releases/` and exactly `docs/DESIGN.md`;
  `.gitignore` ignores the rest of `docs/`. Remember that `docs/reference/` ships inside the npm
  package, and the daemon copies its Markdown files to `$OPENRIG_HOME/reference/` when it
  starts. Files in `docs/as-built/` carry a `last-verified-against-source` commit in their
  frontmatter.
- **Internal-leak guard** (`scripts/internal-leak-scanner.mjs`, with rules in
  `scripts/internal-tokens.generated.json`). It refuses maintainer-internal names and paths in
  content that ships. It runs in `generate-context-packs.mjs` (static pack sources, on every
  `npm test`), in the full skill mirror apply (each public skill), in `scripts/build-package.sh`
  (the daemon `specs/` tree before it is copied into the package), and in the release-time
  substance gate (`scripts/check-substance-gate.mjs`, `npm run gate:substance`) over the packed
  CLI. No workflow runs it over a pull request's whole diff.
- **Portability report** (`.github/workflows/portability-report.yml`, running
  `scripts/portability-report.mjs`). On each pull request it lists added lines containing
  machine-specific values: credentials, home and temporary paths, network addresses, email
  addresses. It never fails the job; you read it and decide.
- **Generated files.** Do not hand-edit `scripts/*.generated.json` or anything under
  `packages/daemon/context-packs/`. The skill-edge digests are the one generated file a contributor
  refreshes, with `node scripts/regen-edge-digests.mjs` (see "A shipped skill").
- **Hosted CI** (`.github/workflows/tests.yml`): `build-and-package`, `typecheck`, `repo-checks`,
  `package-tests` (macOS; daemon, CLI, TUI and UI suites with no credentials and no external
  network) and `installed-scenario`.

## Pointers

- [CONTRIBUTING.md](CONTRIBUTING.md): setup, what a pull request needs, what to expect from review.
- [docs/reference/developing.md](docs/reference/developing.md): which checks block and which are
  advisory. It predates the hosted Tests workflow; `.github/workflows/tests.yml` is current.
- [docs/reference/worktree-builds.md](docs/reference/worktree-builds.md): building in a git
  worktree, with its own `npm install` rather than a symlinked `node_modules`.
- [docs/reference/](docs/reference/): user and operator reference; it ships with the package.
- [docs/as-built/](docs/as-built/README.md): module-by-module descriptions of the system. **These
  are being re-verified.** Most modules were last verified against `7eaf524c` (2026-05-16, around
  v0.3.1). The newest markers are `c8341f72` (`architecture/living-notes-review.md`) and
  `b13a8e4c7` (`cli-reference.md`). Their counts are historical: `architecture/daemon-core.md`
  describes 40 migrations, and there are 89 today. Use them for orientation, then check the code.
- [docs/as-built/test-layers.md](docs/as-built/test-layers.md): what each test layer covers and
  what it cannot catch.
- [docs/as-built/arteries.md](docs/as-built/arteries.md): the areas where a small change has a
  large effect, what depends on them, and what broke there before.
- [packages/test-system/ci/README.md](packages/test-system/ci/README.md): the CI scenario job.
- [docs/releases/](docs/releases/) and [CHANGELOG.md](CHANGELOG.md): release history, written by
  the maintainers at release time.
