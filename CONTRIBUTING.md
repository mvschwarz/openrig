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

## Setting up

Node `^20 || ^22 || ^24` and a working `tmux` are required. Then:

```bash
git clone https://github.com/mvschwarz/openrig.git
cd openrig
npm install
npm run build          # all workspaces
npm test               # repo checks + daemon, cli, tui test suites
npm run lint           # typecheck every package
```

`npm test` builds the daemon and runs repository checks before the package suites. Read the
specific failure: `npm run mirror-skills` updates skill mirrors, and
`npm run generate-context-packs` updates generated packs. Use them when their source changed and
review the generated diff; neither command fixes every documentation failure. The UI unit-test
suite is advisory and separate: `npm run test:ui`.

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

- Repository reference: `docs/reference/`; user documentation: [openrig.dev/docs](https://openrig.dev/docs).
- Skills: `packages/daemon/specs/agents/shared/skills/` and plugin skills under
  `packages/daemon/assets/plugins/`; static context-pack sources: `packages/daemon/context-packs-src/`.
  Generated packs live in `packages/daemon/context-packs/` and are not hand-edited or committed.
- Releases: [GitHub Releases](https://github.com/mvschwarz/openrig/releases) and npm `@openrig/cli`.
