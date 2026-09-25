# Worked example: reviewed CSV validation

Read this when adapting the recipe to a repository with CSV handling. The complete files below passed source catalog, Markdown reader and lifecycle compiler checks on a private 0.5.14-based candidate. The prior bounded native trial also used a private 0.5.14-based candidate and completed reviewed work and next-task pickup with setup assistance and 48 one-time approvals; it did not demonstrate a genuine product-decision wait/answer or automatic refocus. The revised guidance below has source checks only. Use compatible installed command help and preserve first failures.

This is a concrete CSV-validation example for adaptation, not a requirement that an arbitrary repository become a CSV project or every outcome be split into two slices. This example uses two genuinely dependent slices. Select a real, authorized repository and record its starting commit and existing CSV behavior. If it has no relevant CSV code, choose two dependent changes appropriate to that repository and rewrite the example objectives before execution; ordinary user tasks retain their appropriate size.

For the example only, repository root and work root are the same absolute directory, called `PROJECT_ROOT`. The selected project ID is `csv-tool`, mission is `csv-validation`, and rig is the shipped `first-project`. These are authored example identities, not live discoveries. Resolve existing catalog/config/intent first. Never overwrite a real `project.yaml`, `workspace.yaml`, `SPEC.md`, `AGENTS.md`, or existing mission to install a template. Merge compatible fields deliberately or choose an unused work directory and preserve the existing catalog entries. If using a separate work root, launch seats in the code repository and record both roots in intent/context. Keep `project.yaml` two directories above the mission directory for this compiler path; arbitrary custom mission-root layouts are not established here.

## Manual work and the queue loop

For one small change, start with repository instructions, an observable result,
a named owner and the chosen checker. Let the owner carry the result through
implementation and independent judgment. You do not need the manifests below
or a Workflow instance to begin. Retain useful acceptance, decisions and evidence
in the project's existing files.

When work should outlive a turn, the actual owner verifies its identity and uses
the queue. In this example, owner/checker addresses are synthetic until verified
against the real `first-project` team. The task file contains the real outcome,
boundary, acceptance and evidence pointers; create it before sending:

```sh
rig whoami --json
rig queue create --destination dev-owner@first-project \
  --body-file ./TASK.md --summary 'Implement the agreed CSV inspection' --json
rig queue claim <returned-qitem-id> --json
```

After implementing and checking the cumulative candidate, the current owner uses:

```sh
rig queue handoff <owned-qitem-id> --to dev-check@first-project \
  --body-file ./REVIEW-REQUEST.md --json
```

The request binds exact candidate, acceptance, commands and evidence. Read the
successor back with `rig queue show <id> --full --json`; the checker claims it,
judges it independently, then hands that lineage back to the owner. Keep repairs
with this outcome and checker. The owner reports the checked result and explicitly
hands off remaining work or closes with the truthful outcome using installed
`rig queue update --help`. A terminal queue state alone is not acceptance.
A message can clarify scope; `rig send` alone does not transfer queue ownership.

For a genuine local dependency, retain the owned row with a continuation:

```sh
rig queue block <owned-qitem-id> --on <live-blocker-qitem-id> \
  --continuation 'Read the result, then resume the agreed CLI change' --json
```

For a real external wait, name its actual blocker. If a reminder is useful within
the agreed time/spend budget, add `--wake-after 2h` to that blocking command; the
example duration is a choice, not a required cadence. A reminder requests a fresh
look, never supplies the answer. Read back state, owner, blocker and wake. On a
real answer, preserve it and resume the same obligation through the supported
claim/update path; do not create a duplicate task. If no question is unresolved,
do not manufacture one to demonstrate waiting.

After completion the same owner can pick up the next authorized outcome. Keep
useful project context and progress current. Neither a long roadmap nor an empty
queue authorizes the agent to invent work.

## What wakes work, and what it costs

The following behavior is source-checked for this private 0.5.14-based candidate. Inspect the
installed configuration and `rig watchdog list` for actual jobs; old jobs in an
upgraded installation are not proof of fresh-install defaults.

| Mechanism | Trigger and boundary |
| --- | --- |
| Queue create/handoff | Normally nudges the destination after persistence; `--no-nudge` opts out. Read delivery/pickup receipts; an accepted write is not completed work. |
| Local dependency resolution | A row blocked on a live local qitem can return to pending and wake its owner when the blocker resolves. If work is handed onward to another owner, the blocker can follow that successor instead of falsely announcing completion. External prose blockers do not self-resolve. |
| Explicit blocked `--wake-after` | Arms a reminder with the park, timed from registration. No timer is implied by merely writing a deadline in prose. Repeated reminders can wake a model while a real blocker remains. |
| Parked-owner anti-park check | A daemon-registered per-rig supervisor checks for an eligible idle owner holding open work; it reserves one wake per park episode. It is not an idle-work generator. |
| Stuck sweep / wake-or-escalate | Standing daemon checks surface stuck obligations and route recovery; failed handoff wakes get bounded retries/escalation. Unconfirmed delivery follows its confirmation path rather than blind resending. They do not override interactive prompts or provider limits. |
| Idle-gate | Opt-in: `policies.idle_gate_qitem.auto_register` defaults to `off`, and `policies.idle_gate_qitem.opt_in_sessions` defaults to an empty list. Existing jobs may persist. Do not assume every fresh seat has this periodic nudge. |
| Workflow keepalive | Explicit runtime instantiation arms keepalive for its entry packet; authoring YAML or compiling alone does not. Automatic keepalive is deadline-gated, not a promise that every check causes a model turn. |

Wake scheduling, refocus and health have different jobs: wakes seek renewed
attention, refocus supplies pointers/context, and health reports observations.
None proves that useful work happened or that newly authored context was read.
Background checks are ordinary daemon computation, not themselves model turns.
**Delivered wakes and resumed work can consume tokens.** Agree work/time/spend
limits before choosing reminders or more automation; prefer dependency events
and a useful stop condition over short repeated empty prompts. No wake changes
permissions, supplies a missing product decision or authorizes more work.

## Permissions at the point of work

Before launching or giving the owner the first task, choose the ordinary prompted
route or a deliberate permissive setup using the installed getting-started guide's
“Opt-in permissive operation” and “Custom settings and precedence” sections.
The public source entry links those same sections. Keep the user's defaults unless
they choose otherwise. Codex sandbox and approval policy are distinct controls;
actual native/provider behavior and managed restrictions determine what prompts.
More permissive operation exposes files/network with fewer confirmations and
still grants no extra product scope. Do not silently enable YOLO, global trust or
network access. The prior bounded trial needed 48 one-time approvals (34 owner,
14 checker), so do not sell this path as unattended or free of permission friction.

## Grow the running team

Keep `first-project`'s owner and checker when they are enough. When there is useful
independent work, add one or two seats to that running rig. The example below adds
two builders; it does not require a larger starter, new Workflow or replacement
sessions. Use the actual rig name if yours differs.

### Prepare one small pod fragment

From the operator or coordinating seat, inspect the existing team and the installed
implementation agent:

```sh
rig ps --json
rig ps --nodes --rig first-project --json
rig queue list --destination dev-owner@first-project --json
rig specs show implementer --kind agent --json
rig expand --help
```

Set `RIG_ID` to the `rigId` value for the running `first-project` in the first result;
the expansion/export commands below take that ID, not the starter spec name.
Verify the existing `dev.owner` and `dev.check` identities and their current work;
choose another pod ID if `build` is already present. The spec result's `sourcePath`
names an `agent.yaml`: use its containing directory for the `path:` reference
below. Preserve the installed agent's imports/resources; do not copy only that
one YAML file. If the library result is missing or ambiguous, resolve it through
`rig specs ls` and the returned exact ID before proceeding.

Set `PROJECT_ROOT` to the actual absolute code repository. Put the following
complete pod fragment in the new user-owned file
`$PROJECT_ROOT/.openrig/factory/add-builders.yaml`, creating the parent directory
if needed. Replace both `/absolute/path/to/implementer` values with the discovered
agent directory and both `/absolute/path/to/project` values with the repository.
YAML does not expand shell variables. Use a model supported by the selected
runtime/account; this example matches the Codex starter. Keep the existing
permission choice and check the new seats' effective native permissions.

```yaml
pod:
  id: build
  label: Builders
  members:
    - id: a
      label: Builder A
      agent_ref: "path:/absolute/path/to/implementer"
      profile: default
      runtime: codex
      model: gpt-6-astra
      cwd: "/absolute/path/to/project"
    - id: b
      label: Builder B
      agent_ref: "path:/absolute/path/to/implementer"
      profile: default
      runtime: codex
      model: gpt-6-astra
      cwd: "/absolute/path/to/project"
  edges: []
crossPodEdges:
  - kind: delegates_to
    from: dev.owner
    to: build.a
  - kind: delegates_to
    from: dev.owner
    to: build.b
```

For just one new seat, omit member `b` and its `crossPodEdges` entry **before** the
first expansion. This is an expansion fragment (`pod` plus `crossPodEdges`), not a
complete RigSpec with `version`, `name` and `pods`. Do not pass it to `rig up` or
claim a full-spec validator tested it. The expansion service validates/preflights
the new pod against the existing rig before adding it. There is no expansion
`--dry-run` option in this command surface.

### Add, inspect, then assign

The next command creates topology and starts only the new pod's members. Run it
once when the user has authorized this growth and its cost:

```sh
rig expand "$RIG_ID" "$PROJECT_ROOT/.openrig/factory/add-builders.yaml" \
  --rig-root "$PROJECT_ROOT" --json
rig ps --nodes --rig first-project --json
```

`--rig-root` supplies the resolution root; the fragment's explicit `cwd` supplies
the working directory. Expected logical IDs are `build.a` and `build.b`, with
addresses `build-a@first-project` and `build-b@first-project`. Derive the actual
addresses from the result. Confirm the original seats and their work remain
present. Inspect every node's status/error and the native pane, even if the
overall result says `ok`; a created node or tmux session is not proof of readiness.
A partial result can leave new nodes persisted. After a timeout, read topology
before any retry. Do not repeat expansion against a pod that was already added.
If a newly created seat failed to start, resolve its reported cause; the supported
single-seat retry is `rig launch "$RIG_ID" build.a` for that existing node.
`rig launch` does not create a missing seat. Preserve other sessions and work.

New seats do not inherit the owner's conversation or task. Record the agreed
division in the project's existing working agreement and prepare each task file
with exact project/mission/slice source addresses, outcome, file/worktree boundary,
checks, next owner and stopping condition. Then deliver the context instruction,
for example for the first builder:

```sh
rig send build-a@first-project "Read $PROJECT_ROOT/SPEC.md and the addressed sources in $PROJECT_ROOT/.openrig/factory/TASK-A.md. Run rig whoami --json and rig queue list --owned --json in your own seat; report your identity, scope and any native readiness/permission blocker. Await the bounded queue assignment."
rig capture build-a@first-project
```

Read the actual reply and pane; resolve startup/login/permission prompts under the
chosen policy before dispatch. Repeat for B only if B was added. The operator must
not impersonate either seat. Context delivery does not claim the work. Once ready,
the coordinator creates the distinct agreed task (or hands off an existing owned
task instead of duplicating it):

```sh
rig queue create --destination build-a@first-project \
  --body-file "$PROJECT_ROOT/.openrig/factory/TASK-A.md" \
  --summary 'Implement the agreed independent change A' --json
```

Use actual project/mission/slice tags where applicable. Read back the returned ID
with `rig queue show <id> --full --json`; A claims it as itself. Use the earlier
queue loop for results, review and blockers. Existing Workflow-bound work keeps
its packet/projection contract: adding a seat does not revise a running graph or
automatically bind its roles. The fragment's labels/edges describe relationships;
responsibilities and ownership come from the working agreement and assigned work.

### Specialize only when the work warrants it

| Seat in this example | Deliberately agreed responsibility |
| --- | --- |
| `dev-owner@first-project` | Initially implements and coordinates; can become the dedicated orchestrator, selecting outcomes, separating tasks, owning integration and retaining next-work custody. |
| `build-a@first-project`, `build-b@first-project` | Implement distinct authorized tasks and return exact candidates/evidence. Neither silently edits the other's files or folds both candidates without integration ownership. |
| `dev-check@first-project` | Retains independent judgment under the project's review policy. The implementer does not count its own check as independent review. |

This is one progression, not a required four-seat layout. One extra builder may
be enough; a different workload may justify a specialist or additional independent
review capacity instead. Use suitable discovered agent specs for those duties.
Follow the user's review policy rather than adding a reviewer to every trivial edit.
Start concurrent tasks only when their inputs and edits can proceed independently;
use explicit disjoint files or separate worktrees and one integration owner. Shared
files, serial dependencies and a review bottleneck can erase any speed gain.
More active seats and delivered wakes can spend more tokens. Agree model choices,
active concurrency, time/spend limits and a stop condition; adding a seat changes
neither permission authority nor the authorized outcome. Existing wake policies
still apply to idle seats, so an idle label is not a zero-token guarantee.

### Save the expanded shape without replacing the live rig

Expansion persists new topology in the running instance's database. It does not
rewrite the starter, the fragment or your original authored `rig.yaml`. Save a
separate live export to an unused user-owned path:

```sh
rig export "$RIG_ID" -o "$PROJECT_ROOT/.openrig/factory/first-project-expanded.yaml"
```

Inspect the export and reconcile it with your user-owned authored RigSpec, retaining
original culture/startup/context files, agent imports, permissions and other settings.
The export reconstructs stored topology; it is not a lossless copy of every original
authoring field or a backup of native conversations. If exported agent references
are relative, resolve them from their original root and correct them for the new
file location; a changed file location does not move those resources. Validate the
reconciled full RigSpec with `rig spec validate <path> --json`, then compare its
seat membership with the live rig using `rig doctor --spec <path>`. That comparison
does not prove all startup/context fields or native recovery.

Keep the fragment, reconciled spec and existing continuity evidence. A bundle made
from an old authored spec can omit the added seats. A snapshot taken before growth
cannot establish recovery of the new seats; use the compatible lifecycle guide for
any later authorized snapshot/restore. Do not stop, rebuild or replace the running
rig merely to save its definition. The fragment/parser checks for this recipe are
offline evidence; no new native live-growth or restore trial is claimed.

For a different team structure, use the optional
[OpenRig Architect](../../openrig-architect/SKILL.md) path from the main recipe.
Custom-rig authoring is not a prerequisite for adding this pod.

## Advanced: an explicit Workflow contract

Use the following complete example when explicit runtime prerequisites/exits are
useful. Manual and queue-only work above do not require this graph. Keep the same
repository purpose, owner/checker and evidence habits when moving between modes;
do not run a queue-only task and a second Workflow task for the same implementation.

Authored layout (the user's code and tests remain in their existing locations):

```text
PROJECT_ROOT/
  workspace.yaml
  project.yaml
  SPEC.md
  missions/csv-validation/
    mission.yaml
    SPEC.md
    PROGRESS.md
    NOTES.md
    slices/01-inspect/
      slice.yaml
      SPEC.md
      PROGRESS.md
      PROOF.md
    slices/02-cli/
      slice.yaml
      SPEC.md
      PROGRESS.md
      PROOF.md
```

`workspace.yaml` — complete example YAML:

```yaml
schema: openrig.workspace/v0alpha1
projects:
  - id: csv-tool
    root: .
```

`project.yaml` — complete example YAML:

```yaml
schema: openrig.project/v0alpha1
kind: project
metadata:
  id: csv-tool
install:
  intent: SPEC.md
  context:
    - SPEC.md#working-agreement
  skills: []
missions:
  root: missions
lifecycle:
  profile: small-change-v1
```

`missions/csv-validation/mission.yaml` — complete example YAML:

```yaml
schema: openrig.mission/v0alpha1
kind: mission
metadata:
  name: csv-validation
composition:
  mission_markdown:
    spec: SPEC.md
  slices:
    - ref: slices/01-inspect/slice.yaml
      order: 10
      active: true
    - ref: slices/02-cli/slice.yaml
      order: 20
      active: true
lifecycle:
  profile: small-change-v1
  workflow:
    objective: Add reviewed CSV validation without modifying input data
    target:
      rig: first-project
    entry:
      role: owner
    roles:
      owner:
        preferred_targets: [dev-owner@first-project]
      checker:
        preferred_targets: [dev-check@first-project]
    context_refs:
      - SPEC.md#intent
      - SPEC.md#acceptance
      - PROGRESS.md
      - NOTES.md#blank-required-cells
      - slices/01-inspect/SPEC.md
      - slices/02-cli/SPEC.md
    exception_routing:
      default: orchestrator
      orchestrator_role: owner
    steps:
      - id: inspect
        actor_role: owner
        objective: Implement and check the pure CSV inspection contract in slice 01-inspect
        depends_on: []
        allowed_exits: [handoff, waiting, failed]
      - id: cli
        actor_role: owner
        objective: Use the inspected result in the CLI; resolve the real blank-cell decision before completing slice 02-cli
        depends_on: [inspect]
        allowed_exits: [handoff, waiting, failed]
      - id: check
        actor_role: checker
        objective: Independently check both slices on the exact candidate and record evidence; do not claim an implementation self-check as review
        depends_on: [cli]
        allowed_exits: [handoff, waiting, failed]
      - id: finish
        actor_role: owner
        objective: Reconcile the exact checked candidate, report how to try it, and retain the next authorized outcome or explicitly report none
        depends_on: [check]
        allowed_exits: [done, waiting, failed]
```

`missions/csv-validation/slices/01-inspect/slice.yaml` — complete example YAML:

```yaml
schema: openrig.slice/v0alpha1
kind: slice
metadata:
  id: inspect
composition:
  mission: ../../mission.yaml
  slice_markdown:
    spec: SPEC.md
    progress: PROGRESS.md
    proof: PROOF.md
```

`missions/csv-validation/slices/02-cli/slice.yaml` — complete example YAML:

```yaml
schema: openrig.slice/v0alpha1
kind: slice
metadata:
  id: cli
composition:
  mission: ../../mission.yaml
  slice_markdown:
    spec: SPEC.md
    progress: PROGRESS.md
    proof: PROOF.md
```

These are two slice artifacts and four coordination steps, not four product slices. Order in `composition.slices` describes membership; `steps[].depends_on` supplies the runtime prerequisite. The mission graph is selected explicitly. The compiler calls this supported path `legacy-mission` and emits an advisory because there is no project-owned reusable graph yet; retain that result rather than disguising it. Do not add simultaneous slice `execution` contracts: an authored mission graph takes precedence over them. Explicit preferred targets avoid assuming the starter's display labels are declared topology roles. The two addresses must be verified against the launched seats before use.

Each of the four `SPEC.md` files must start with its complete frontmatter block below, immediately followed by its body from the table. The opening `---` is the first line, before any heading. All four blocks passed the source reader checks. The refocus reader needs a leading literal `intent:` field; an `## Intent` heading alone does not supply it. A missing field must remain visible in the trace.

`SPEC.md` — complete example frontmatter:

```yaml
---
intent: Help a person detect invalid CSV input before an import changes data.
---
```

`missions/csv-validation/SPEC.md` — complete example frontmatter:

```yaml
---
id: OPR.99.0.1
mission: csv-validation
stage: wip
intent: A user can inspect a CSV and receive a useful validation result without changing the input file or imported data.
depends_on: []
---
```

`missions/csv-validation/slices/01-inspect/SPEC.md` — complete example frontmatter:

```yaml
---
id: OPR.99.0.1.1
slice: 01-inspect
mission: csv-validation
status: placeholder
stage: wip
intent: A CSV user can identify missing required headers and locate blank required cells without changing the input or choosing the pending CLI policy.
depends_on: []
---
```

`missions/csv-validation/slices/02-cli/SPEC.md` — complete example frontmatter:

```yaml
---
id: OPR.99.0.1.2
slice: 02-cli
mission: csv-validation
status: placeholder
stage: wip
intent: A user can validate a CSV through the existing CLI with useful errors and the agreed blank-cell behavior while preserving input data.
depends_on: ["OPR.99.0.1.1"]
---
```

These identity fields follow the shipped mission/slice templates and scope readers, not a second schema. The dot-IDs shown are for a new empty example; the native default prefix is `OPR`, and `99.0.1` is the non-release mission escape band, not this CSV product's version. Preserve existing IDs or use the scope scaffold's next available identity in an occupied work tree, then update the sibling dependency consistently. `mission: csv-validation` and `slice: 01-inspect` / `02-cli` match directory identities; `status: placeholder` and `stage: wip` declare initial planning state. No `verified` or execution date is fabricated. Project frontmatter needs its outcome `intent`; the project catalog identity remains `workspace.yaml`'s `csv-tool`, matched by `project.yaml`'s `metadata.id`.

Frontmatter `depends_on` names sibling work-node dot-IDs for discovery/advisory ordering; it does not cause runtime dispatch and the path-only trace does not follow those edges. This is distinct from manifest membership/order and the existing workflow step dependency `cli -> inspect`. The mission manifest's `metadata.name: csv-validation` and slice manifest metadata `inspect` / `cli` retain their existing lifecycle meaning. Project-specific queue views also require actual `project:csv-tool` attribution with the mission/slice identity; frontmatter cannot invent that linkage or imply automatic tags on runtime packets. See the shipped `project-workspace.md` reference, sections “UI mapping” and “Queue mapping”, and the scope templates for attribution.

Complete initial Markdown bodies are specified below, after those frontmatter blocks for the four SPEC files. Each heading is literal; each body is the entire initial text beneath it. Record actual repository-specific paths and check commands in these bodies during bootstrap before work starts; no private installation authority belongs in the public example. The other Markdown files keep the listed initial contents; these initial files make no status-badge or proof-registry claim.

| File relative to `PROJECT_ROOT` | Initial headings and bodies |
| --- | --- |
| `SPEC.md` | `# CSV tool`; `## Purpose`: “Help a person detect invalid CSV input before an import changes data.” `## Working agreement`: “Preserve existing repository rules, data and unrelated edits. The first-project owner coordinates implementation and continuity; dev-check independently checks the exact cumulative candidate. The user decides unresolved product behavior. Agreed local implementation, regression checks and review need no repeated approval; publication, destructive data changes and new external effects remain outside this task. Read the current queue and mission before acting; record evidence and unresolved facts, not invented completion.” |
| `missions/csv-validation/SPEC.md` | `# CSV validation`; `## Intent`: “A user can inspect a CSV and receive a useful validation result without changing the input file or imported data. First implement a pure inspection result; then expose it in the existing CLI.” `## Acceptance`: “Missing required headers name every missing column. Valid input passes. The CLI uses the inspection result and its chosen blank-cell rule, returns the repository's documented success/failure status and preserves input bytes. Tests exercise both slices. One independent checker records the exact candidate, commands, results and limits. The owner explains how to try it and preserves next-work custody. No publication.” |
| `missions/csv-validation/NOTES.md` | `# Decisions`; `## Blank required cells`: “PENDING — the user must decide whether a present required column containing blank cells is rejected or accepted. Slice 01 can report those cells without choosing policy; slice 02 must not guess the CLI rule. Record the user's decision, timestamp and source here.” |
| `missions/csv-validation/PROGRESS.md` | `# Progress`; `## Current position`: “Planned; no implementation, runtime instance or review result yet. Record the operation key, instance/frontier IDs, current owner, candidate and next action when observed.” |
| `missions/csv-validation/slices/01-inspect/SPEC.md` | `# Inspect CSV`; `## Intent`: “Add or adapt a pure inspection function using the repository's CSV handling. Return missing required headers and blank required cells with row/column locations; do not modify input or choose the pending CLI blank-cell policy.” `## Acceptance`: “Missing-header, valid-input, quoted-field and blank-cell cases produce the documented result. Input bytes and existing import behavior remain unchanged. Record actual commands and candidate for the cumulative checker.” |
| `missions/csv-validation/slices/02-cli/SPEC.md` | `# CLI validation`; `## Intent`: “Expose slice 01's inspection result through the existing CLI. Reuse its result rather than implementing a second parser. Resolve `../../NOTES.md#blank-required-cells` with the user before choosing the CLI outcome.” `## Acceptance`: “The CLI names missing columns, applies the recorded blank-cell rule, uses documented exit statuses and preserves input bytes. Focused valid/invalid cases and the existing relevant regression checks pass on the candidate supplied to dev-check.” |
| Both slices' `PROGRESS.md` | `# Progress`; `## Current position`: “Planned; no implementation or proof claimed. Record the exact candidate, completed checks, open dependency and current queue packet as work proceeds.” |
| Both slices' `PROOF.md` | `# Proof`; `## Evidence`: “No evidence yet. For each executed check record candidate, command, result, evidence path and limits. The independent checker attributes its own judgment separately from author checks.” |

The CLI implementation interface and check commands are repository-derived facts, not a new universal code template.

## Bootstrap, context and refocus

1. **Current agent:** inspect the selected installation, repository instructions and existing project catalog. Use `rig --help`, `rig config get workspace.root`, `rig config get workspace.catalog_path`, `rig config get workspace.slices_root` and `rig workspace doctor` as appropriate. Preview an additive `rig config init-workspace --root <chosen-root> --dry-run` if no work tree exists. That scaffolder does not bind the roots or supply the metadata/lifecycle graph above. When setting up the intended instance, use ordinary config help to bind only the intended instance to the selected workspace/catalog/slices root; preserve other catalog entries. Do not silently point a shared daemon at a different project. Scope creation helpers may write the skeleton, but inspect and complete the actual manifests before compiling.
2. **Current agent, with the user's existing authority:** follow the public guide's prerequisite and permission choice once, preview `first-project`, plan it with the real code cwd, then deliberately launch it. Derive both live addresses and native readiness. Reuse existing appropriate seats; do not start duplicates just to clear prompts. Daemon/kernel readiness and each native seat's readiness are separate facts.
3. **Owner and checker:** read the repository instructions and relevant intent; derive their own identity and queue. For example, the owner can run `rig context work-install --project csv-tool --mission csv-validation --slice 01-inspect --deliver --runtime codex --cwd <actual-code-root> --json`; use `02-cli` for the dependent work and give the checker both exact slice addresses. `--deliver` returns composed bytes to its caller: it is not a transport acknowledgment. Do not use `--apply-skills` merely to make this example work. `install.skills: []` adds no private or invented skill requirement; discover applicable public skills normally.
4. **Bootstrap context delivery:** send the two seats a short instruction naming the exact work root and addressed files to retrieve; obtain their scope/role reaction before assigning implementation. A registered context pack can be sent with `rig send --context <discovered-ref>`; an arbitrary filesystem address is not automatically a context-pack ref. Deliver the actual composed bytes when a receiver cannot retrieve them. Keep instruction delivery separate from queue ownership.
5. **Minimal durable topology context:** derive `topology.root`, then preserve existing chain files. In a new dedicated example instance, put purpose/root pointers in `LEARNED.md`, the two-seat relationship in `rigs/first-project/LEARNED.md`, and short duties in `rigs/first-project/seats/dev-owner/LEARNED.md` and `.../dev-check/LEARNED.md`. Owner text: “Own the user's bounded outcome, implementation, exact check handoff, result and next-work custody; derive the current packet.” Checker text: “Independently judge the supplied candidate against project/mission/slice acceptance, record evidence and limits, and return judgment without self-assigning broader work.” Rig text points to the user's `SPEC.md#working-agreement` and active mission; instance text points to the configured work root. Do not copy a status roster into these files. Optional pod files and eight-region trees are unnecessary.
6. **Refocus delivery:** use the public `refocus-channel.md` and `chain-file-convention.md`, discovered under the selected instance reference directory. The ordinary hook derives roots and emits pointers at its supported prompt/compaction boundaries; it does not mean an edited file has been read. Ask each seat to run the discovered public refocusing procedure and read the relevant named sources once as part of bootstrap, recording any trace gap. Automatic delivery is confirmed only when delivery at a supported boundary is actually observed; until then report it as unverified. Do not force compaction/restart to obtain that observation; a manual message is not proof of the automatic hook. Existing running seats do not inherit shell environment edits. Any explicit `OPENRIG_REFOCUS_WORK_NODE` or content override belongs in an intentionally configured launch context, not a claim that setting it in the sender changed another seat.

## Deliberate runtime creation and truthful continuation

The **actual owner seat**, after choosing the Workflow path, runs the following commands after context and address checks. The example addresses below are used only after its own `rig whoami --json` confirms `dev-owner@first-project`; an unbound bootstrap shell must not pretend to be that seat. `PROJECT_ROOT` is an ordinary task variable holding the selected absolute work root. Pick and record a unique operation key once, then reuse it after a timeout. These are adaptable examples; the prior trial executed its own bound instance. The genuine product-decision wait below remains unproven:

```sh
rig workflow compile "$PROJECT_ROOT/missions/csv-validation/mission.yaml" \
  --operation-key csv-tool-csv-validation-run-1 --json

rig workflow instantiate-lifecycle "$PROJECT_ROOT/missions/csv-validation/mission.yaml" \
  --operation-key csv-tool-csv-validation-run-1 \
  --root-objective 'Reviewed CSV validation without changing input data' \
  --created-by dev-owner@first-project --rig first-project --json

rig workflow operation csv-tool-csv-validation-run-1 --json
rig workflow continue <returned-instance-id> --json
```

Inspect compilation identity, all source paths/digests, four steps, prerequisites, resolved or explicitly unresolved routes, advisories and `eligible`. File presence is insufficient. If compilation is ineligible, correct the named authoring issue within the user-authorized scope; do not instantiate by guessing a different graph. The lifecycle command, not the earlier scope edit or compile, creates the instance and entry queue item. Read back the returned packet and owner, claim normally, and preserve any initial durable bootstrap task's linkage to that runtime rather than leaving two competing implementation obligations.

At each completed step, the **current packet owner** projects its own result. Example for owner slice 01; packet IDs come from live readback:

```sh
rig workflow project --instance <instance-id> --current-packet <inspect-packet> \
  --exit handoff --actor-session dev-owner@first-project \
  --result-note 'Inspection contract implemented; exact candidate and checks recorded' \
  --evidence-ref <absolute-slice-01-proof-path> --json
```

Read the resulting `cli` packet before work. Generic `rig queue handoff` is not a substitute for advancing a workflow-bound packet. `workflow continue` only inspects; it does not run a step. The owner must carry source/candidate/evidence and the exact second-slice context when advancing. It must not describe the first implementation handoff as independent acceptance.

For a **real unresolved blank-cell product choice**, ask the user the concrete question and record the request. The owner of the `cli` packet can park it with an explicit blocker:

```sh
rig workflow project --instance <instance-id> --current-packet <cli-packet> \
  --exit waiting --actor-session dev-owner@first-project \
  --blocked-on external:user/blank-required-cells \
  --result-note 'Need the user decision recorded in mission NOTES before selecting CLI behavior' \
  --evidence-ref <absolute-mission-notes-path> --json
```

Read back waiting state, blocker, owner and retained frontier packet. A timer or reminder is not a user answer. Once the actual decision arrives, retain it in NOTES, read the same frontier, finish that same step and use its permitted `handoff` exit; do not instantiate again or claim that `workflow resume` is the wait verb. That command is for failed-instance recovery. If the real repository already settles this choice, do not fabricate uncertainty: select another genuine external input for the bounded trial, or report wait coverage absent.

The checker receives the cumulative candidate, both proof files, exact accepted decision and reproducible checks. Its truthful `handoff` advances to `finish`; the owner reports the exact checked cut and how the user can exercise it. A failed check is recorded honestly, routed to the owner through the selected exception path and resolved using the existing failure/repair continuation. Keep the same checker and outcome through bounded repairs; keep the implementation/check exchange with that owner and checker. A workflow terminal state alone is not evidence that the user outcome passed.

On `finish`, the owner records completion and uses `done`. The human can then send the next bounded outcome to the same address, referencing the prior result. The owner creates/claims its durable task and acknowledges the actual boundary; it need not create another mission or full workflow for every small change. If nothing else is authorized, explicitly record no next work. For a bounded demonstration, observe next-task pickup separately from its implementation.

That pickup establishes only bounded continuation from the first result. Repeated operation across multiple missions remains a future observed claim; neither this example nor a successfully picked-up next task proves it.

## Stop safely

Before stopping, read each seat's current queue and preserve the candidate, evidence,
next owner and exact resume step. Do not leave an in-flight command or an owned
obligation silently abandoned. Retrieve the compatible lifecycle guide with
`rig context get skills/core/rig-lifecycle/SKILL.md` and inspect `rig down --help`.
When the user has authorized stopping this team, use `rig down <verified-rig>`
for that exact rig, then read back the reported state. Preserve the repository,
context and evidence; stopping is not deletion. A later `rig up <verified-rig>`
requires actual native readiness checks before work resumes. Record a failed
resume as failed; do not silently replace the original sessions. The prior bounded trial observed a supported stop; restore remains untested.

## Optional growth, with the same two seats

When the same coordination obligations recur, move the reusable workflow to `project.yaml` under `lifecycle.profiles.small-change-v1`, with `required_steps: [check, finish]` and a `workflow` mapping; keep `lifecycle.profile: small-change-v1`. Remove mission-specific paths/objectives from the reusable base and supply them through each mission's context/arrangement. Missions can inherit it unchanged, explicitly `mode: extend` to add uniquely named steps, or `mode: override` with a complete arrangement that preserves required obligations. `required_steps` names real stable step IDs, not prose headings. This optional design is not a second validated manifest in this example.

Slices remain the work/spec/progress/proof home. If a project instead chooses per-slice execution, the native compiler supports `execution.actor_role`, `preferred_targets`, `depends_on` and `allowed_exits`, but do not imply those independently add steps beneath an already selected mission/profile graph. Compile the chosen single graph, inspect the result, and instantiate or explicitly revise the existing instance. Retained running inputs do not silently follow disk edits. Add more roles, SDLC advice, typed gates or release obligations only when the user's work requires them. No mandatory wave, release graph, private lifecycle helper or seven-seat factory is part of this first example.
