---
name: permission-posture
description: |
  Use when classifying or dispatching OpenRig work that needs a specific permission scope (fleet / full QA-testing window / operator auto window / Mode 3 isolated VM), when blocked by sandbox / approval / filesystem / auth / provider permission denial, or when proof posture must be declared before a slice. Covers the four practical postures, the before-dispatch checklist, the stop-and-flag rule, the VM state mutation rule, mode mapping (D/0/1/2/3), and sizing-class posture mapping (Class A/B/C).
metadata:
  openrig:
    stage: factory-approved
    last_verified: "2026-05-04"
    distribution_scope: product-bound
    source_evidence: |
      Authored 2026-05-03 as the canonical skill home for content
      previously living at openrig-work/conventions/permission-posture/README.md.
      Per founder reframe (2026-05-03 conversation): conventions are
      taxonomy + frontmatter pointers; content lives as skills (single
      source of truth). This is the pilot for the convention-pointer
      pattern. The original convention README was last updated 2026-05-02
      with status: active. Content moved verbatim, restructured for skill
      shape (when-to-use bullets at top; rule-of-the-road body; examples).
    sourced_from:
      - openrig-work/conventions/permission-posture/README.md (now a frontmatter pointer back here)
    related_doctrine:
      - openrig-work/conventions/security-and-consequence-boundary-policy/README.md (underlying security model — also a candidate for skill conversion)
    sibling_skills:
      - permission-and-capability-preflight
      - security-and-consequence-boundary-policy
      - native-session-file-lab-boundary
      - transcript-retention-cleanup-policy
      - human-agent-operator-posture
    transfer_test: pending
---

# Permission Posture

This skill is the rule of the road for permission posture in OpenRig
work. Permission posture is part of work routing — it says whether the
current seat can honestly do the work and proof the packet requires.

For the underlying security model, see
`security-and-consequence-boundary-policy` skill.
In short: OpenRig gates consequence boundaries, not ordinary work
inside the intended boundary.

## When to use this skill

Reach for this skill when:

- **Dispatching a packet** that involves QA, tests, lifecycle, topology
  mutation, VM/host operation, or provider runtime proof — you need to
  declare the required permission posture in the packet.
- **Classifying a candidate** for sizing (Class A/B/C) — sizing class
  determines posture; "fleet-ok" on a Class B/C vertical is a sizing-gate
  violation.
- **Blocked by a permission denial** (sandbox, approval, filesystem,
  auth, provider quota) — apply the stop-and-flag rule; do not silently
  degrade proof or build workaround architecture.
- **Proposing changes to permission defaults** (Codex / Claude Code /
  workspace-write roots / approval policies) — these are Mode 3 isolated
  VM territory; do not test on the live host first.
- **Operating inside a VM** for proof work — the VM state mutation rule
  governs what's allowed inside the disposable guest vs the host.
- **Writing a slice plan or synthesis selection memo** — posture must be
  declared explicitly per the sizing-class mapping.

NOT for: deciding *whether* a particular command is destructive — that's
the security-and-consequence-boundary-policy skill (or its convention).
NOT for: actually configuring Codex/Claude permissions — that's
configuration work in `~/.codex/config.toml` and `.claude/settings.local.json`,
informed by this skill but not authored by it.

## Hard Stop: No Standing Codex Auto-Review

Never use standing Codex `approvals_reviewer="auto_review"`, Codex
`--full-auto`, or Codex approval-bypass mode as a rig default. It can
burn provider quota at catastrophic speed. Normal Codex fleet seats use
full access scope with `approvals_reviewer="user"` and command rules
that prompt/forbid consequence-boundary actions. **Full access is not
auto-review.**

Claude Code auto permissions are different. They are functional on this
host and are the preferred default for Claude seats when the
consequence-boundary rules still apply.

## Core Rule

Do not silently degrade proof because the current seat lacks
permissions. If the needed command or surface requires stronger
posture, **name the exact command, blocker, and required posture, then
route to orch or the human**.

## Current Practical Postures (four)

- **`fleet`**: default Codex posture for ordinary OpenRig work. Use full
  access scope with `approvals_reviewer="user"` and command rules that
  prompt/forbid dangerous actions. Good for docs, source scans, queue
  reading/writing, normal repo edits, SSH/rsync/VM inspection, and
  broad work under `~/code`. **Not proof of permission to
  run destructive lifecycle operations.**
- **`full QA/testing window`**: manually upgraded Codex posture for
  serious local QA, test, browser, build, or proof work when `fleet`
  cannot run the commands honestly.
- **`operator auto window`**: legacy packet label for a temporary
  operator-authorized posture covering `rig up/down`, topology
  mutation, tmux/OpenRig lifecycle, VM/Tart/Docker, daemon, or
  host-sensitive operations. **This label does NOT mean Codex
  auto-review by default.** Use `approvals_reviewer="user"` for normal
  Codex seats; any Codex auto-review override must be rare, bounded,
  owned, and shut off when the run ends.
- **`Mode 3 isolated VM`**: the required posture for changing
  permission defaults or proving risky permission-system changes. **Do
  not test host permission policy changes on the live host first.**

## Before Dispatch

Any packet involving QA, tests, lifecycle, topology mutation, VM/host
operation, or provider runtime proof should state:

- required permission posture;
- exact commands or surfaces that need it;
- whether the current rig/seat appears to have it;
- acceptable fallback, if any;
- escalation route when the posture is missing.

If no stronger posture is required, say `permission_posture: fleet-ok`
or equivalent in the packet.

## Stop And Flag Rule

When sandbox, approval, filesystem, auth, or provider permission blocks
required work, report:

1. exact command or action attempted;
2. observed blocker or denial;
3. required posture;
4. whether work can continue safely without that command;
5. route requested: manual upgrade, operator window, Mode 3 VM, or
   human decision.

Do not create workaround architecture, substitute weaker proof, or keep
retrying high-token approval flows unless the packet explicitly
authorizes that fallback.

## VM State Mutation Rule

VMs are disposable proof surfaces. When the work is explicitly
VM-scoped, VM-local mutation is allowed by default unless it crosses a
named deny boundary. The point of using a VM is to move ordinary proof
work from "ask before every mutation" to "do the VM-local work,
preserve evidence, and avoid the deny list." Installing source builds,
refreshing provider auth inside the VM, writing guest config, updating
guest dependencies, and snapshotting a known-good guest state are all
valid ways to make proof repeatable.

The hard boundary is **the host and live fleet, not the VM**:

- Do not mutate host `~/.claude`, host `~/.codex`, host `~/.openrig`,
  live daemon state, or live rigs unless the packet explicitly grants
  that posture.
- Do not treat a list of example VM actions as a whitelist. If the
  action affects only the disposable guest and is needed for the named
  proof, it is in-bounds unless it touches protected host state, live
  topology, external provider account policy, or a baseline image not
  authorized for mutation.
- Do not treat provider-auth failure inside a VM as a product pass;
  either refresh auth in the VM, use a known-good auth-ready VM
  snapshot, or mark the proof deferred on substrate grounds.
- Prefer a named auth-ready snapshot or clone for repeated VM proofs.
  If a proof depends on a particular provider account or auth profile,
  record that profile in the VM proof packet or harness config instead
  of leaving it implicit.
- Mutating a baseline VM is acceptable when the human/operator intends
  that VM to become the new known-good baseline. Otherwise, mutate a
  clone and promote it only after it passes readiness.
- If a disposable clone stops on a human-actionable blocker, such as VM
  UI login, leave the clone stopped but intact by default and report
  its name/IP/evidence path. Delete immediately only when the proof is
  complete, the clone is known-bad, or the stop condition explicitly
  says cleanup now.

Provider-auth setup/refresh still needs an explicit posture decision
when it consumes real provider quota, changes accounts, or affects
proof cost. The default distinction is:

- **VM-local setup/refresh for an intended auth-ready proof VM**:
  allowed after operator approval for that VM lane.
- **Host credential mutation or live-provider account policy changes**:
  Mode 3 / human-gated.

## Mode Mapping

- **Mode D**: classify posture needs in candidate and slice packets;
  do not promote work whose proof posture is hidden.
- **Mode 0**: `fleet` is usually enough; flag if a "small" task
  unexpectedly needs host authority.
- **Mode 1**: driver states expected verification posture before
  editing; guard rejects overclaimed verification.
- **Mode 2**: QA/testing seats may need a `full QA/testing window`;
  declare it before dispatch.
- **Mode 3**: lifecycle, topology, VM, daemon, auth, persistence, or
  permission-system work needs an explicit posture plan and may need a
  `Mode 3 isolated VM`.

## Sizing-Class Mapping

Per the Product Lab ambition / sizing gate (canon at
`substrate/shared-docs/openrig-work/specs/openrig-product-lab/README.md`
§ Ambition / Sizing Gate), candidates are classified A/B/C. Each
sizing class has a default posture and a never-downgrade rule:

- **Class A** (doctrine/convention/vocabulary): `fleet-ok` almost
  always. Paper packet authoring, source/doc trace, fixture mapping,
  and applied paper review of recent flow are all `fleet-ok`.
- **Class B** (primitive/feature delivery): `fleet-ok` is **wrong**.
  Class B v0 declares `full QA/testing window` for Tier 1
  source-backed host tests, AND `operator auto window` for live
  topology/lifecycle/daemon/session/tmux/provider state mutation
  beyond read-only, AND `Mode 3 isolated VM` for permission default
  changes, provider-auth behavior, risky lifecycle/restore proof,
  host-sensitive policy, or disposable-VM provider/runtime proof. Mix
  postures across milestones as proof shape requires; do NOT collapse
  to `fleet-ok`. Disposable-Tart-VM proof is NOT human-gated unless
  protected-host or external-spend criteria apply.
- **Class C** (multi-primitive/rail/system-level capability): same
  posture matrix as Class B, typically with one or more milestones at
  `Mode 3 isolated VM` because rail-level proof exercises lifecycle/
  auth/host trust contracts. Composition-of-primitives across rail
  boundaries may require `operator auto window` for the orchestration
  proof and `Mode 3 isolated VM` for end-to-end real-runtime
  validation.

Synthesis selection-memo classification line MUST state both the class
AND the posture for v0. Two valid forms:
`Class A doctrine, fleet-ok, paper packet`
OR
`Class B/C vertical, [posture(s)], components [list]`.

Reviewer rejects Class B/C v0 declared at `fleet-ok` posture as a
sizing gate violation.

## Examples

- A Codex tester cannot run the browser or full test suite under
  `fleet`: route a `full QA/testing window` request with the exact
  command.
- An orchestrator needs to run `rig up` or `rig down`: ask the human
  for an `operator auto window` instead of trying to route around the
  blocker.
- A slice proposes changing Codex permission defaults: make it Mode 3
  and prove first in an isolated VM.

## See also

- `velocity-permission-preflight` — velocity-specific operating rule
  that builds on this skill (permission preflight before code-producing
  or host-touching velocity slices).
- `openrig-operator` — host-side runtime triage including Codex
  permission failures.
- The convention pointer at
  `permission-posture` skill exists for
  taxonomic discoverability; this skill is the source of truth.
