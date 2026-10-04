# Contributing to OpenRig

Thanks for being here. OpenRig is built in the open and by the thing it is: a rig of coding
agents and a small group of people. External pull requests and issues have started arriving
faster than we planned for, which is the best problem to have. This page says how to get a
change in with the least friction on both sides.

## Before you start

- **Bugs:** open an issue with the bug template. Include your OpenRig version (`rig --version`),
  OS, Node version, which harnesses are involved (or none), and the relevant command and output.
  Reports are public: remove credentials, private prompts, personal details and private paths
  before posting. Share a small reproduction rather than a full transcript or instance dump.
- **Features and behaviour changes:** open an issue or a Discussion in *Ideas* first. A short
  "what I am trying to do and what stops me" saves both of us a rewrite. Small, obvious fixes do
  not need an issue.
- **Questions:** use [Discussions › Q&A](https://github.com/mvschwarz/openrig/discussions/categories/q-a),
  not an issue.

## Before a security or integration PR

OpenRig connects your coding agents to each other: shared context, messaging, coordination and long-running seats.
It's designed for your own machine or a trusted private network, for you and people you trust, not for the open
internet. It doesn't try to act for you in the outside world; your agents already have tools for that.

**Security-related PRs.** If you've found something exploitable, report it privately first (see
[SECURITY.md](SECURITY.md)) rather than in a public PR. For hardening changes, tell us in the PR description:

- the scenario: how this goes wrong for someone using OpenRig as it's designed to be used, and the evidence you have
- who or what causes it, and how they reach the install
- what the change costs everyone else: a refusal, an extra step, a new setting

We look at the finding and the fix separately. We may agree with a finding and fix it differently, or decide the fix
costs more than it protects. If the answers are missing we'll ask once, and close the PR with thanks if they don't
come.

**Integrations with other tools or projects.** Open an issue or an Ideas Discussion and wait for a maintainer's yes on
scope before you build it; an issue on its own isn't a yes. Often the best home for an integration is your own
repository, and we're happy to link to it.

## Setting up

Node `^22 || ^24` and a working `tmux` are required. Then:

```bash
git clone https://github.com/mvschwarz/openrig.git
cd openrig
npm ci                 # exactly what package-lock.json records
npm run build          # all workspaces
npm test               # repo checks + daemon, cli, tui test suites
npm run lint           # typecheck every package
```

`npm ci` installs the locked versions and never rewrites `package-lock.json`, which is what CI
runs too. Use `npm install <package>` only when you're adding or changing a dependency, and commit
the lockfile change with it.

`npm test` builds the daemon and runs repository checks before the package suites. Read the
specific failure. A shipped skill may exist in more than one copy (see ARCHITECTURE.md): edit every copy, then run
`node scripts/regen-edge-digests.mjs` (the full `npm run mirror-skills` apply needs maintainer-only
inputs; see "A shipped skill" in [ARCHITECTURE.md](ARCHITECTURE.md#a-shipped-skill)).
`npm run generate-context-packs` updates generated packs. Review the generated diff; neither
fixes every documentation failure. The UI unit-test suite is advisory and separate:
`npm run test:ui`. [docs/as-built/test-layers.md](docs/as-built/test-layers.md) lists every test
layer, what CI runs, and what each layer can and cannot prove.

For hands-on development, read the [check requirements](docs/reference/developing.md),
[worktree setup](docs/reference/worktree-builds.md), and
[machine changes](README.md#what-openrig-changes-on-your-machine). Use an isolated environment
for changes that start daemons or agents; `OPENRIG_HOME` alone does not isolate provider settings.
Permission configuration is an [explicit choice](docs/reference/getting-started.md#have-your-agent-configure-permissions).
A checked-out tree is not the installed daemon; restarting an installed daemon does not adopt
your working copy.

## Making the change

- One concern per pull request. Keep unrelated refactors separate; explain any refactor needed
  for the fix.
- Keep the diff small enough to review in one sitting. If it is not, say why in the description.
- Add or update a test where the change is testable. Use focused deterministic tests where
  possible. For terminal or provider behaviour, state what was exercised with the actual runtime
  and what was simulated; a stub alone does not prove the native interaction works.
- Do not edit `CHANGELOG.md`. Maintainers write release notes at the tag.
- Do not bump versions.
- Match the surrounding style. `npm run lint` typechecks; it does not format code.
- Write commit messages in the form the log already uses: `fix(cli): …`, `feat(daemon): …`,
  `docs(reference): …`, `harness: …`.

## The pull request

Fill in the template. The three things a reviewer needs are: what a user gets, how you verified
it, and anything you were unsure about. State the revision and relevant local changes you tested,
what you actually ran, and any checks you could not run. Redact private information from evidence.

Contributions follow the repository's [Apache-2.0 license](LICENSE). Preserve attribution and any
applicable license notices when adapting third-party material.

## What to expect from us

- We aim to acknowledge issues and pull requests within **one day**. An acknowledgement is not
  a completed review or a merge decision.
- Our target for a first substantive review decision on an external PR is **seven days**. If it
  takes longer, we explain what is pending on the PR. This is a target, not a guaranteed deadline.
- Labels you will see: `needs-repro` (we could not reproduce it yet; waiting on versions or steps),
  `fixed-on-main` (merged, not yet on npm), `good first issue`, `help wanted`, `discussion`
  (direction question; continues in Discussions).

Reviews here are done by people and by the project's own agents. An agent may ask the first
clarifying question or run the reproduction; a maintainer makes the merge decision.

## Where things live

- **Start here:** [ARCHITECTURE.md](ARCHITECTURE.md) maps the packages, the request path, and where to
  add a command, route, migration, adapter, skill, context pack or scenario.
  [docs/as-built/arteries.md](docs/as-built/arteries.md) lists the areas where a small change has a
  large effect; if your change touches one, read it first.
- **Using a coding agent?** Claude Code and Codex load the repository's `developing-openrig` skill
  when they work in this checkout (`.claude/skills/` and `.agents/skills/`). It points at the maps
  above and at what to run before you push.
- Repository reference: `docs/reference/`; user documentation: [openrig.dev/docs](https://openrig.dev/docs).
- Skills: `packages/daemon/specs/agents/shared/skills/` and plugin skills under
  `packages/daemon/assets/plugins/`; static context-pack sources: `packages/daemon/context-packs-src/`.
  Generated packs live in `packages/daemon/context-packs/` and are not hand-edited or committed.
- Releases: [GitHub Releases](https://github.com/mvschwarz/openrig/releases) and npm `@openrig/cli`.
