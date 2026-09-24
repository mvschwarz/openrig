# Worked example: reviewed CSV validation

Read this when adapting the recipe to a repository with CSV handling. The complete files below passed the 0.5.14 source catalog, Markdown reader and lifecycle compiler checks. The full native-agent journey and runtime commands remain untested. Use compatible installed command help and preserve first failures.

This is a concrete CSV-validation example for adaptation, not a requirement that an arbitrary repository become a CSV project or every outcome be split into two slices. This example uses two genuinely dependent slices. Select a real, authorized repository and record its starting commit and existing CSV behavior. If it has no relevant CSV code, choose two dependent changes appropriate to that repository and rewrite the example objectives before execution; ordinary user tasks retain their appropriate size.

For the example only, repository root and work root are the same absolute directory, called `PROJECT_ROOT`. The selected project ID is `csv-tool`, mission is `csv-validation`, and rig is the shipped `first-project`. These are authored example identities, not live discoveries. Resolve existing catalog/config/intent first. Never overwrite a real `project.yaml`, `workspace.yaml`, `SPEC.md`, `AGENTS.md`, or existing mission to install a template. Merge compatible fields deliberately or choose an unused work directory and preserve the existing catalog entries. If using a separate work root, launch seats in the code repository and record both roots in intent/context. Keep `project.yaml` two directories above the mission directory for this compiler path; arbitrary custom mission-root layouts are not established here.

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
6. **Refocus delivery:** use the public `refocus-channel.md` and `chain-file-convention.md`, discovered under the selected instance reference directory. The ordinary hook derives roots and emits pointers at its supported prompt/compaction boundaries; it does not mean an edited file has been read. Ask each seat to run the discovered public refocusing procedure and read the relevant named sources once as part of bootstrap, recording any trace gap. The independent trial must observe one later supported delivery boundary, without forcing a compaction/restart. If automatic delivery is not observed, report it as unverified; a manual message is not proof of the automatic hook. Existing running seats do not inherit shell environment edits. Any explicit `OPENRIG_REFOCUS_WORK_NODE` or content override belongs in an intentionally configured launch context, not a claim that setting it in the sender changed another seat.

## Deliberate runtime creation and truthful continuation

The **actual owner seat** runs the following commands after context and address checks. The example addresses below are used only after its own `rig whoami --json` confirms `dev-owner@first-project`; an unbound bootstrap shell must not pretend to be that seat. `PROJECT_ROOT` is an ordinary task variable holding the selected absolute work root. Pick and record a unique operation key once, then reuse it after a timeout. Example commands are UNEXECUTED:

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

The checker receives the cumulative candidate, both proof files, exact accepted decision and reproducible checks. Its truthful `handoff` advances to `finish`; the owner reports the exact checked cut and how the user can exercise it. A failed check is recorded honestly, routed to the owner through the selected exception path and resolved using the existing failure/repair continuation. Keep the same checker and outcome through bounded repairs; there is no routine root relay or new review lane. A workflow terminal state alone is not evidence that the user outcome passed.

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
resume as failed; do not silently replace the original sessions. No stop or
restore success is claimed by this source-only example.

## Optional growth, with the same two seats

When the same coordination obligations recur, move the reusable workflow to `project.yaml` under `lifecycle.profiles.small-change-v1`, with `required_steps: [check, finish]` and a `workflow` mapping; keep `lifecycle.profile: small-change-v1`. Remove mission-specific paths/objectives from the reusable base and supply them through each mission's context/arrangement. Missions can inherit it unchanged, explicitly `mode: extend` to add uniquely named steps, or `mode: override` with a complete arrangement that preserves required obligations. `required_steps` names real stable step IDs, not prose headings. This optional design is not a second validated manifest in this example.

Slices remain the work/spec/progress/proof home. If a project instead chooses per-slice execution, the native compiler supports `execution.actor_role`, `preferred_targets`, `depends_on` and `allowed_exits`, but do not imply those independently add steps beneath an already selected mission/profile graph. Compile the chosen single graph, inspect the result, and instantiate or explicitly revise the existing instance. Retained running inputs do not silently follow disk edits. Add more roles, SDLC advice, typed gates or release obligations only when the user's work requires them. No mandatory wave, release graph, private lifecycle helper or seven-seat factory is part of this first example.
