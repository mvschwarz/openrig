# What you can do here

**This is not a command reference and you are not meant to memorise it.** There is a full reference
— every flag, every JSON shape — and `--help` on the live binary is always more current than
anything written. This is the other thing: **what is possible.**

The failure it exists to prevent is specific and it is the most expensive one on this system. You
get asked for something, it sounds like new work, and you build it out of primitives — when a verb
already does it, or two verbs crossed already answer it. **You cannot look up a capability you do
not know exists.** So the point of what follows is not skill. It is recognition: that when a task
lands, something rhymes, and you go check instead of building.

Eighty-one-plus top-level verbs ship (capability canon refreshed through
`capability-delta-v0.5.14-r6`). This marker describes the pack's teaching, not publication or live
adoption. Read this once for shape, and let it make you suspicious that a thing already exists.
Model-divergence proclamations are live product (trust them; pins use canonical
model IDs).

---

## Finding out what is actually true right now

**Nearly every bad decision here starts with a stale belief about state**, and almost all of it is
one command away. Your memory of the fleet is a claim about the past.

- **`rig whoami`** — who you are, who your peers are, and the exact string you use to reach each of
  them. Ground truth over anything your startup overlay says.
- **`rig ps`** — what rigs exist. **`rig ps --nodes -A`** — the state of every seat everywhere,
  *including the broken ones*. **The bare form is the question you usually want:** `--active`
  filters to running and **hides detached, exited and attention states** — which are exactly the
  cells you were scanning for.
- **`rig ps --all-hosts --nodes -A`** — the same across every registered machine. Rollup-only
  unless you ask for nodes.
- **`rig discover`** — what is running on this box that OpenRig is *not* managing.
- **`rig queue whoami`** — what the daemon thinks you are holding. Not what you remember holding.
  When the seat's typed rows name exactly one work node, its JSON also carries `currentWork` with
  the mission, slice, and path the refocus hook uses.
- **`rig seat status <seat>`** — what the system already believes about a seat's handover state,
  and whether the thing you did an hour ago actually landed.
- **`rig view list` / `rig view show <lens>`** — named lenses over coordination state: use
  `view show escalations` for owner attention, `view show pickup` for claimed-row state, and
  `view show execution` for done/now/next and current authored planning guidance with its
  source. Mission and wave inspection shows admission and exit guidance; wave/slice details
  include review decisions. Accepted-core guidance stays separate from full-contract proof,
  live custody and executable dependencies. An `INDETERMINATE` cell stays unknown rather than
  being filled from memory. **`rig view register`** turns a query you keep re-running into a
  first-class view.
- **`rig config`** — bare, with no arguments: every key, every current value, and where each came
  from. Most agents assume compaction thresholds, snapshot cadence and scan intervals are hardcoded
  daemon behaviour. They are configuration. **Watch one thing:** `source: default` does not mean
  "the documented default" — it means *derived on this box*, and can resolve somewhere quite unlike
  the path in the help text.
- **`rig health`** — inspect bounded, explainable findings for the current seat, one stable seat,
  a rig, or the local instance; `rig health explain <finding-id>` shows the exact window, source,
  freshness, rule, evidence, confidence, and next inspection. Use the TUI's HEALTH tab for the
  same records when a human also needs to see them. Empty output is never a healthy assertion,
  list/explain never mutate, and diagnostic presentation remains explicit opt-in policy.
  INFO is a severity; Unknown and stale describe assessment or freshness, not a healthy result.
- **`rig health diagnosis show <qitem-id>`** — inspect a retained diagnosis alongside current
  selected guidance before carrying an old restriction forward; `--full --json` expands the
  evidence. `docs/reference/health-diagnosis.md#current-selected-context-and-correction` explains
  the authored selection and correction record. Authority, current applicability, an assessment,
  an action taken and a later observed effect are separate facts. Recording a correction or
  replaying a case does not establish improved behavior or authorize unrelated work.

## Reaching another agent

**The terminal is the wire.** A message is typed into another agent's prompt and it cannot be
unseen — which makes messages the one delivery channel that never gets skipped.

- **`rig send`** — put words in front of one seat, several, a pod, or a rig. **`--verify` checks
  pane-only delivery**: the text was staged at the far end, not that the agent consumed or acted
  on it. Alternate-screen and queued-command cases can still yield false negatives, so
  consequential delivery gets an effect check at the far end rather than a blind retry. A
  producer-link advisory reading `no_activity_signal` means activity could not be determined;
  confirm by effect, never relaunch on it.
- **`rig send --raw`** — send exact text or keystrokes without the From/To envelope;
  the interactive-prompt guard still applies. To deliberately drive an interactive prompt,
  **`--dangerously-interact --reason "<why>"`** is the explicit override and implies raw text.
  Inspect the prompt and establish authority for its effect before using that override.
- **`rig broadcast`** — one fact to everyone at once, rather than relaying it N times and getting
  the wording wrong on the fourth. **Blast radius is real** — on a large rig this lands in every
  seat's turn.
- **`rig capture <seat>`** — read what is on their screen right now. **`--rig` / `--pod`** captures
  every seat in one call.
- **`rig transcript <seat>`** — what has been *said* in a seat, and **seat-scoped rather than
  session-scoped**: one file spanning every agent generation that has occupied it, so it reaches
  back through handovers. Capped (`transcripts.lines`, default 1000 — raise it for depth), and
  `--tail N` returns N lines, so **do not mistake your own limit for the file's size.**
- **Read the JSONL directly** — `~/.claude/projects/<cwd-slug>/<session>.jsonl` — for what an agent
  *did* rather than said: every tool call and file opened, in order. **To find out whether an agent
  read something, do not ask it. Look.**
- **`rig ask`** — search what was said or decided, across *every generation that ever sat in a
  seat*. It reaches back past a handover that erased your predecessor's context, and costs no
  runtime tokens.
- **`rig chatroom wait`** — block until a peer actually says something, instead of polling
  `capture` in a loop. Also `history`, `watch`, `topic` for a named thread that stays retrievable.
- **`rig stream emit` / `list` / `watch` / `archive`** — drop an observation somewhere the *next*
  agent will find it. Emitting costs nothing and does not interrupt anyone; the value appears when
  someone lists the stream before starting.
- **`rig terminal open <view>`** — bring every live agent in a rig, mission or slice up as real
  typeable tiles at once.
  In the TUI, **TERMINALS** keeps Saved views prominent and Derived groups collapsed until
  expanded. Names load before detailed readiness. Select a view to inspect its members,
  layout and pages; preview is passive. Saved membership requires deliberate setup.
  **Open in Herdr** deliberately opens the inspected plan
  and reports opened, absent or degraded members. Help or a side trip returns to the same preview.
- **`rig walk <seat> --through <files> --pace <n>`** — deliver context pieces through
  file-backed terminal paste. When the current native generation record resolves, the complete
  piece and its matching Claude/Codex turn closure must arrive before pacing onward, including
  the last piece. Initial missing evidence is explicitly unverified; a record lost or replaced
  during verification stops the walk. Use `rig walk --help` for those receipts and bounds.
  Delivery and turn completion do not prove comprehension.
- **`rig slack`** — inspect and manage one connector implementation. Use registered-human
  readiness for the delivery decision and `queue create --verify` for its receipt; connector
  setup or verification is not an outbound human message.

## Making work outlive you

**Your terminal buffer is not a record and your turn is not a container.** A durable row survives
your context, your compaction and your replacement — and it is the only thing that does.

- **`rig queue create`** — a row with an owner, a body and a transition history.
- **`rig queue show`** — what a row *actually says*. The header is not the body.
- **`rig queue claim` / `unclaim`** — is this mine and running, or still pending where two agents
  might double-work it. Put it down honestly when it is not yours.
- **`rig queue update`** — record what happened in a form the rest of the system can act on. A
  `--note` does not reopen a terminal row; terminal-to-active repair requires explicit `--reopen`
  with both `--state` and `--note`.
- **`rig queue handoff`** — pass work so the close and the create are **one transaction**, instead
  of closing yours, failing to create theirs, and stranding the work in between.
- **`rig queue block` / `resolve`** — park a row on a real blocker so it stays **yours and
  visible**, with a plain-language summary and a pointer to what a human must judge; `resolve`
  writes their decision onto the durable record and wakes the owner. **Closing it would be a lie
  and sitting on it silently is indistinguishable from a crash.** `--wake-after <duration>` arms
  one wake for this park episode; a new park supersedes it and every exit route retires it.
- **`rig queue overdue`** — what was claimed and never closed in time. **Defaults to the current
  rig**; ask for more if you mean more.
- **`rig queue undelivered`** — pending create-path nudge failures only. For gateway or human
  delivery, the row's transitions are the receipt ledger; `undelivered` does not answer whether a
  person received the escalation. **`overdue` and `undelivered` are the two halves of "is anything
  silently stuck", and a rig can be clean on one and rotten on the other.**
- **`rig queue inbox-drop` / `inbox-pending` / `inbox-absorb` / `inbox-deny`** — put something in
  front of a seat that it can *refuse*. Mail, not assignment.
- **`rig queue outbox-record` / `outbox-list`** — what you dispatched, in a record that survives
  your context. Stale requests you forgot are invisible to you and expensive to everyone else.
- **`rig queue fallback`** — reroute a row whose destination cannot receive it, without losing it
  or rewriting its history.

## Arranging to be woken

**You cannot wake yourself.** When your turn ends you stop, and nothing you can schedule from
inside will start you again. Everything here is an arrangement made *in advance* by the version of
you that is still running.

- **`rig watchdog register`** — arm a wake for a condition that will become true after you are
  asleep, compacted or finished. For a context wall, use the exact
  `--policy context-usage-threshold` rather than a hand-rolled transcript timer. A scheduled
  reminder arrives as the authored message under an explicit scheduler identity, not as YAML
  syntax or anonymous agent input.
- **`rig watchdog list` / `show` / `status` / `stop`** — did it fire, is it still live, did someone
  stop it. `list` defaults to active, compact, and 100; `--all --full` is the complete history.
  **Quiet skips are not recorded**, so a healthy idle job and a job that never ran look identical
  in `status` — INDETERMINATE is the honest read until `show` says otherwise.
- **An alarm whose message has gone stale is worse than no alarm.** When the thread it refers to
  closes, kill it or rewrite it — a successor inheriting an escalation order with no thread
  attached is worse off than one with nothing.

## Running a pipeline without relaying every step

**A workflow remembers the plan and routes the next action; agents judge the outcome.** Its
conditions, packets and waits carry decisions across returns. Inspect and revise the selected
graph when reality changes, preserving completed work and current ownership. Repeated manual
relay is a reason to inspect the available routing, not to surrender judgment to a fixed pipeline.

- **`rig workflow specs`** — what can be started here, and which are shipped versus authored by
  this rig.
- **`rig workflow validate`** — will this spec instantiate at all, before a run finds out for you.
- **`rig workflow compile <mission>`** / **`instantiate-lifecycle`** — derive one executable graph
  from `project.yaml` → `mission.yaml` → `slice.yaml`, inspect it without writing, then start an
  eligible graph with an opaque replay key. Typed acceptance candidate, verdict, and evidence
  travel through `workflow project`; workflow completion alone is never release acceptance.
  A project-owned release profile carries required obligations across missions; explicit
  extensions/overrides preserve them. Reach for `docs/reference/project-release-profile.yaml`
  when release graphs keep being copied or losing stages. The release ceremony and post-release
  boundary remain distinct; no successor is required to finish. Agents judge the evidence.
- **`rig workflow instantiate`** — start a multi-step, multi-seat run as one governed instance with
  an entry packet that lands on a real owner.
- **`rig workflow status`** — which instances need attention, with reason and next action.
  Inspect the exact exception occurrence and packet: resolved overdue work is reconciled without
  closing an overdue sibling. Registered-human fallback reports missing or ambiguous selection
  instead of inventing a recipient. Follow the state/error and `workflow show`/`trace` before retrying.
- **Exception ownership before failure:** `workflow compile` and `workflow validate`
  expose `exceptionReadiness`; `workflow show` renders it alongside existing exception
  obligations and their queue/evidence pointers. Defining an ordinary role does not select
  an exception owner. Follow `selection.source` to the owning `exception_routing.orchestrator_role`
  field; project profiles own it unless the mission explicitly overrides the graph.
  Selection, registered identity, genuine capability no-match, intended registered-human
  fallback, ambiguous human selection and unavailable reads remain distinct. An advisory
  before failure is not a requirement to keep every future role/model live. A failed read
  cannot establish no-match or silently route to a human. If human selection is needed,
  inspect `rig gateway human list --json`; select `workspace.operator_seat_name` when ambiguous.
- **`rig workflow show` / `trace`** — what this instance is, and every step, actor and exit that
  got it here.
- **`rig workflow revise <instance>`** — compare the bound graph with current authored
  inputs before changing a progressed run. Ordinary show and TUI inspection distinguish
  source-only edits (such as a catalog address) from executable changes. Preview names
  changed steps, incompatibilities and an exact apply command. Supported revisions preserve
  completed/live steps, receipts, required obligations and child custody; new work must
  depend on unfinished work. A changed completed/live contract needs explicit reconsideration:
  restore it and revise unstarted successors. Revision does not guess a migration or replay
  accepted consequences. Exception-routing corrections can be adopted for future occurrences;
  existing exception obligations retain custody. Editing source alone does not change the
  running owner. Inspect `workflow show` after adoption and inspect each admitted queue row's
  evidence. Authoritative workflow recovery/completion clears obsolete overdue occurrences;
  an unresolved sibling stays visible. Closing a queue row alone is not semantic acceptance.
- **`rig workflow operation <key>`** — recover the committed creation/revision effect after
  a timeout or disconnected response, even if authored files have since changed. Retain the
  operation key and repeat only the identical decision. The original receipt and current
  instance are distinct; a terminal packet is not acceptance.
  Project profiles and mission extension/override define outer steps; bound slice manifests
  are not automatically nested execution. Waves are agent planning groups. The current
  plan's admission, review and integration guidance returns in lifecycle packets and their
  continuation, alongside the small revision move. Scope creation/move maintains manifest
  membership; `--depends-on` is advisory build order, while `execution.depends_on` defines
  executable prerequisites.
- **`rig workflow continue`** — where you are in a run you have been handed. **It is read-only. It
  does not continue anything**, despite the name — `project` is the advance verb.
- **`rig workflow route`** — the owner of the current step is gone; move *that step* to a live seat
  without pretending it completed.
- **`rig workflow resume`** — after correcting a failure, redrive its step while retaining
  completed work. A dependency branch can fail while siblings remain live. Use
  `--occurrence <failed-qitem-id>` to select that failure (required when several are
  unresolved); its obsolete exception obligation closes in the redrive transaction,
  while unresolved siblings stay visible. An identical occurrence/decision retry returns
  the existing redrive without duplicating work.
- **`rig workflow run` / `watch` / `list`** — run to completion with an exit code you can act on,
  watch it happen, or see what exists.

## Bringing things into and out of existence

**For a first useful repository change**, preview `first-project`, inspect
`rig up first-project --cwd . --plan`, and follow `docs/reference/getting-started.md`.
Its native Codex owner/checker team is the focused starting point; verify prerequisites and
actual runtime readiness before work. Existing Herdr/cmux terminals can present the managed team
through `rig terminal open`.

**Need a small team now, without authoring YAML?** Start with `rig create`, then use `rig grow`
(including `--new-pod`) while it runs. A working topology can become a reusable spec later; you do
not have to tear one down to change it, and you rarely have to start from nothing.

- **`rig up <source>`** — make a whole rig exist and run: from a spec you wrote, a shipped starter
  by name, a bundle someone handed you, or a stopped rig.
- **`rig down`** — stop a rig's seats and take it out of the running set.
- **`rig launch <rig> [seat]`** — one seat is down; start just that one, without disturbing the
  rest.
- **`rig seat launch <seat> --fresh --reason <why>`** — deliberately create a blank occupant for
  exactly one existing seat. It uses no resume, fork, rebuild, snapshot, or restore packet;
  siblings and durable work stay put, and unmanaged ambiguity refuses.
- **`rig add`** / **`rig expand`** — graft one more member, or a whole new pod, onto a rig that is
  already running. `rig grow --new-pod` and `rig expand` are one ingress; choose by input shape.
- **`rig remove`** / **`rig shrink`** — take a seat, or an entire pod, out of a running topology.
  If it holds active work, pass `--fallback <live-seat>` to reroute before mutation; without a
  valid fallback the command refuses rather than strand the rows.
- **`rig fork`** — take an existing shape and make a variant of it, rather than authoring a new one
  from nothing. Cheaper than it sounds, and the usual right answer when you want *almost* this.
- **`rig archive` / `unarchive`** — get a finished rig out of your default view without losing
  anything about it.
- **`rig attach`** — you are an agent or shell running *outside* any rig: put **yourself** under
  management, so you have an identity, an address and routing.
- **`rig discover` → `rig bind`** — something live that OpenRig found but does not manage; wire it
  to a node. **`rig adopt`** does the whole thing at once: create the structure and bind the
  running sessions into it.
- **`rig reconcile-session`** — you resumed a seat by hand and the daemon still shows it down; make
  the system see the live process **without launching anything**.
- **`rig unclaim` / `rig release`** — stop managing one adopted session, or all of them,
  **without killing the process or the agent inside it**. Handing something back to its human is a
  first-class move, not an abandonment.

> **Two words that mean different things at different altitudes.** `unclaim` and `release` each
> exist both here — *stop managing a live session* — and in the queue — *put a work row back down*.
> Same verb, very different blast radius. Check which altitude you are at before running either.

## When something is broken

**Being able to recover is a capability, not a contingency**, and most of this surface exists
because someone lost work once.

- **`rig start`** — the box rebooted and everything is gone: bring the whole topology back in one
  move, rather than hand-restoring rig by rig. Selected-rig recovery now demands positive runtime
  evidence and refuses stale identity by name rather than substituting an occupant.
- **`rig daemon start` / `stop` / `status` / `logs`** — startup reserves the local instance and
  verifies its own child on required listeners. Inspect a retained reservation before retrying.
  Stop distinguishes process/listener exit from a clean asynchronous drain: inspect the matching
  `daemon-shutdown.json` and log when completion is incomplete or unverified. No target is a
  distinct no-op, and a timeout never proves down. Use command help for exact limits and recovery.
- **`rig doctor`** — is the *installation* wired up correctly, or are you chasing a bug that is
  really a broken install. **`rig preflight`** asks whether this machine can run OpenRig at all.
- **Bare `rig`** — the same TUI for first setup, daemon-down startup and ordinary work.
  A positive observation of a running rig enters ordinary work without a repeated Startup choice.
  With no running rig, the chooser remains; slow or unverified detection does not mean stopped.
  A late observation never takes navigation away after you have chosen another route.
  **?** Help, **w** Skip and **L** Local reading remain usable during slow probes or loading,
  and when the daemon is down or unverified. Local reading shows selected disk intent with
  provenance and read errors; it does not substitute for live queue, execution or topology data.
  These reading controls do not start a daemon or resume seats; skipping an already accepted
  operation does not cancel it.
  In startup, Enter starts only the selected daemon; then choose rigs and individual seats,
  with kernel recommended first. Previously occupied seats default to their authoritative conversation.
  Missing history, ambiguous identity and unavailable authentication have distinct explanations;
  a fresh conversation requires a separate named confirmation. Declining launches nothing.
  **o** opens the existing native terminal here to handle its prompts; detach to return.
  If a fresh start paused before context delivery, **c** finishes that same occupant’s context.
  **r** refreshes actual state and **d** expands diagnostics. **S** returns to startup from work.
  Ordinary views keep the navigator usable through page/rig changes and slow or failed reads.
  Topology offers rig selection first, then loads that rig before unrelated fleet details.
  While a new page loads, useful prior content can remain under its original scope label with
  no action targets. First visits retain navigation and local loading/error feedback.
  During refresh or failure, previously loaded content in the same scope stays useful, with its last
  successful read time and Retry. A failed Feed source retains its contribution while healthy
  sources update; confirmed denial, empty results or removals clear affected content. Late responses cannot
  replace another page or project's data, and surviving selection and scroll stay in place.
- **`rig crash-cart`** — the read-only daemon verdict and saved-state discovery used by that UI.
  An unavailable runtime, unauthorized endpoint or unreadable state is not an empty instance.
- **`rig snapshot`** — take a restore point **before** the risky thing. `snapshot list` shows what
  you actually have and how old the newest is; `--intended-seats` records the topology roster the
  later restore must judge rather than treating every historical node as current.
- **`rig restore`** — put a rig back to a snapshot. **`rig restore-check` first**: what would
  actually come back, and for everything that would not, which check fails and what the fix is.
  Use `rig launch ... --snapshot-id <id>` when selection must be exact, and `rig restore status
  <attempt> --rig <rig>` for the derived intended-set receipt after an asynchronous restore.
- **`rig restore-packet write` / `read` / `validate`** — a seat is about to die or must move
  runtimes; capture what it knows into a portable artifact instead of losing it with the process.
- **Upgrading is agent-led** — load the shipped `openrig-upgrade` skill for the bounded inspect,
  backup, plugin-refresh, and 0.5.9 instance-migration helpers. The migration is an
  Agent-Operated Workflow: inspect, take one bounded reversible action, verify its effect, and
  continue from the receipt. There is no `rig upgrade` verb, and `rig down` is not part of a
  continuity-preserving upgrade.
- **A seat's `compaction_strategy` is declared, not improvised at the wall.** Pair a threshold-
  managed seat with the `context-usage-threshold` watchdog above so continuity is arranged while
  the seat can still act.
- **`rig handover <seat>`** — replace the **occupant** of a seat while the seat, its name, its
  edges and its inbound work stay exactly where they are. **`rig seat handover` uses the same
  effectful handover path.** Both forms perform the operation by default; pass `--dry-run`
  to plan without changing the seat. Check the selected source and continuity evidence first.
- **`rig seat clear-attention` / `set-resume-token`** — clear a stale attention flag, or repair a
  lost resume handle so restore works next time.
- **`rig seat set-model` / `stop` / `clean`** — persist the model for later managed resumes, stop
  exactly one live seat, or clear a dead seat's stale binding. When the topology is right and only
  the occupant is wrong, use these seat lifecycle verbs or `rig handover`, not a rig down/up cycle.
  Effective-model detection follows the identity-verified current occupant, not a retained
  predecessor; a `<synthetic>` transcript record is skipped, so a PENDING model check is not a
  divergence.
- **`rig compact-plan`** → **`rig compact`** — who is near the context wall, then act on it.
  **Ordering matters: running `compact` without the plan is guessing which seat needed it.**
- **Know what compaction costs before you reach for it.** On some runtimes what comes back has
  enough context left to believe it knows everything and not enough to actually know anything — and
  **the compacted agent is the only one who knows it happened**, while every other seat keeps
  routing to that address as though it still holds what it held. It is a last resort, not an
  unblock.
- **`rig destroy`** — the genuine last resort: local state is corrupt beyond repair, wipe it and
  come back up on an empty state root. Named here so you know it exists and know it is the end of
  the list, not the start of it.
- **`rig heartbeat`** — is in-flight work actually being *proven*, or are there owners sitting on
  rows with no evidence behind them.

## Tracking what is being built

**Work lives on disk as missions and slices**, with intent in frontmatter, in a shape the rest of
the tooling already reads. An agent who does not know this exists invents a private markdown
scheme, and nothing downstream can see it.

- **`rig scope mission ls` / `show` / `create`** — what work exists, what a mission is for, and how
  to open one so it gets a stable dot-ID rather than being a bare folder nothing can address. In
  `rig tui`, **PROJECTS** → choose a project → mission → slice shows the work story with row
  drill-in, current source and Escape back. Project IDs and roots distinguish equal display
  names; an unavailable project read does not substitute another project's work.
  The mission overview puts outcomes, current work/owner, blockers, next dependencies and
  readable slice boxes before process prose. Accepted required proof judgments determine
  completion; attached evidence, quiet activity and handoff do not. Reopened and assigned
  unfinished work stays open even when no unassigned next slice exists. Actual custody and
  planned ownership remain distinct, as do outcome completion and mission lifecycle or
  publication. Unknown owners and eligibility stay unknown. Narrow views keep boxes and scroll.
  Malformed mission or slice sources stay visible as local unavailable entries while healthy
  neighbors remain readable. Open the affected source to inspect it, then refresh after correction.
- **TUI Feed** — inspect **Human requests** separately from **Updates**, with the scope shown as
  **Instance / All humans**. Explorer lists these categories; their entries appear in the
  content pane. Human destinations and explicit human blockers show the recipient,
  relevant project, needed decision and work it unblocks; agent priority alone is not a human
  request. Confirmed delivered quiet FYIs remain in a bounded update window after their delivery
  obligation closes, with a receipt and **No action needed**. Failed or ambiguous delivery is not
  delivered history. Existing outcome and health updates retain their source and history.
  Open detail and evidence, then Back. Reading does not approve or deliver a request, and queue
  closure alone does not accept an outcome. Direct `attention`, `needs` and `feed` commands remain.
- **`rig scope slice ls` / `show` / `create`** — the same at the altitude where work is actually
  buildable. `show` gives you intent, frontmatter and children without guessing which of five files
  to open.
- **`rig scope slice progress` / `mission progress`** — record that a step moved, in a form the
  progress view can parse.
- **`rig scope slice approve`** — freeze a decision — *this is the plan* or *this is delivered* —
  so the freeze is recorded rather than asserted in chat.
- **`rig scope slice close` / `ship` / `move`** — retire it with the reason attached, move it into
  the release it belongs to preserving git history, or re-file it under a different mission.
- **`rig scope slice stage` / `verified`** — how mature is this, and *when was it last checked and
  against what*. The second half is the part everyone drops, and it is what makes the first half
  mean anything.
- **`rig scope audit`** — broken rails, ghost registrations, missing convention sections, amended
  approvals. **Advisory and fail-open by design** — fix what it flags or say why not; a clean audit
  is never evidence the work is good.
- **`rig scope slice repair` / `mission repair`** — conform missing progress files and malformed
  frontmatter without hand-editing YAML.
- **`docs/reference/sdlc-conventions.md`** — choose from the SDLC component menu with its planning
  dial when shaping mission/slice YAML. It is a menu sized to the work, not a fixed pipeline.
- **`rig proof add`** — put evidence where the slice, the audit and the UI will all find it,
  instead of pasting it into a message. **The contract it pairs to is chosen by source-selection
  law, and a pristine scaffold PRD can never silently become that contract**: the drop derives
  from the authored SPEC with a named advisory, and `contractSource` in the echo records which
  source actually bound. When someone later asks where the contract items came from, the drop's
  own echo is the answer — not a re-read of the files.
- **`rig proof judge` / `rig proof show`** — record an attributed judgment on a contract item once,
  then read derived proof, slice, mission and project readiness. The owning scope selects
  `proofPolicy.judges` (nearest slice, mission or project policy wins); consult `rig proof --help`
  for that setup and the item/evidence selectors. Accept, reject or withdraw against readable
  evidence; corrections preserve history and unrelated judgments without ancestor status edits.
  Non-code work can name its actual artifact instead of inventing a commit. Evidence capture,
  policy acceptance, higher outcome judgment and publication remain separate decisions.
- **`rig workspace doctor` / `validate`** — does the daemon agree with you about where the work
  tree is, and which files are missing the frontmatter their kind requires.
- **OpenRig Software Factory** — when a first team needs continuing reviewed work or one or two more seats in its running rig; covers queue-only and optional Workflow paths, context/work ownership, wake and token costs, permissions, and optional custom-rig authoring. Discover the bundled recipe with `rig context show skills/core/openrig-software-factory --json`, then load `rig context get skills/core/openrig-software-factory/SKILL.md`; use guidance compatible with the installed build.
- **`rig context work-install --project … --mission … --slice … [--deliver]`** — resolves the ordered
  System World, topology, and Project World plan. Add `--runtime` to see the composed managed skill
  loadout, `--apply-skills` to reconcile its owned harness projection, or `--deliver` to emit the
  exact extant files in order while marking absent pieces visibly. Without the flags it remains
  plan-only.
  `context profile` and `context work-install` both accept `--runtime claude-code` (alias
  `claude`) or `codex`; explicit invalid values refuse before projection. This does not rename
  every other command's runtime vocabulary.
- **`rig context show` / `sync` / `rm`** — what is inside a context pack before you prime a seat
  with it, and how to make the library catch up when you edit one.
- **`rig context add <repository-path-or-URL> --git`** — select a pack while retaining its Git
  source and checkout; `--pack <path>` chooses a repository-relative pack. Inspect that relationship
  with **`rig context source inspect <ref>`**; it does not fetch or prove agent consumption.
  **`rig context source update <ref>`** explicitly fetches and merges, preserving committed local
  authorship before selecting clean content. Dirty work, conflicts, unavailable upstreams and
  edits to the served selection refuse without a reset or push. Resolve and commit, or abort,
  in the retained checkout before retrying; conflicts leave the prior served selection available.
  Read the selected bytes with `context get` and check the actual consumer separately. This is
  explicit update, not automatic synchronization of libraries or running agents.
- **`rig context get <name-or-ref>`** — pull exact context by address instead of reading files:
  `<pack-ref>/<file>#<H2-slug>[/<H3-slug>]` serves the exact span bytes of one section, and **the
  `/<file>` component is required even in a one-file pack**. A bogus slug fails loud and lists the
  addressable sections. **Compose by ref rather than copying**: library content pasted into a seat
  or mission file is a second copy that drifts, nothing will catch the copy automatically, and it
  is a defect by rule.
- **`rig context list`** — every shipped entry's canonical ref (`skills/<namespace>/<name>`) and
  name: the ask → ref → load path when you do not know which context applies. Expertise packs
  serve the same way — but read a pack's own framing before trusting it: the context-engineering
  pack is a dated snapshot, provisional and non-normative by ruling, and current OpenRig skills,
  explicit rulings and measured practice outrank it on any conflict.
- **`rig context profile <ref>`** — compose a situation-shaped profile from a pack's declared
  atoms. Cross-source access (`seat:` / `mission:` atoms) is an **authoring** affordance: declared
  in pack manifests and granted via `--rig/--seat/--mission` at composition time — never an
  ad-hoc argument to `get`.
- **Stable position knowledge is `taxonomy: lore`, not a public skill.** Route it with
  `docs/reference/lore-routing.md` so private seat knowledge stays reusable without entering the
  shipped capability world.
- **`rig context recap-write`** — a durable, seat-scoped RECAP beside LEARNED with a
  collision-safe superseded chain, written at the handover or compaction boundary; restore
  packets carry the pointer, so a successor reads decisions-with-rationale instead of scrollback.
- **`rig project classify` / `list` / `show`** — turn a raw observation into a routed, typed,
  deduped record instead of hand-creating a row from a hunch.

## Making a shape exist somewhere else

**A topology is a describable artifact, not a thing you set up by hand each time.** This is how a
working arrangement becomes something someone else can instantiate.

- **`rig spec validate` → `preflight` → `audit`** — three different questions, in order: is the
  file well-formed, would it boot *on this host*, and **will the agents it launches actually know
  anything when they arrive**. The third is the one people skip. Unknown structural keys refuse
  with their path instead of being normalized away.
- **`rig context trace --pod <pod>`** — walk the context chain through instance → rig → pod → seat
  when the pod altitude matters.
- **`rig specs show` / `preview` / `add` / `sync` / `rename` / `remove`** — where a spec lives,
  what you would get if you launched it, and how to put yours in the library so it is launchable
  by bare name.
- **`rig export <rig>`** — turn a rig that is *running right now* back into a spec you can read,
  diff or hand to someone. **`rig import`** goes the other way.
- **`rig import <workspace.yaml> --workspace-only --target-rig <id>`** — apply a validated
  workspace declaration to an existing rig without changing topology; `rig export` preserves it.
- **`rig bundle create` / `inspect` / `install` / `history`** — one file that rebuilds a rig on a
  machine with none of its content, what is inside one before you trust it, and what has actually
  been installed here.
- **`rig bootstrap`** — spec file to running rig in one command. **`rig requirements`** — what this
  spec needs installed first.
- **`rig plugin show` / `used-by` / `validate`** — what a plugin actually gives an agent, and
  **whose specs break if you change it**.
- **`rig agent-image list` / `show` / `preview` / `pin`** — productive seat snapshots you can start
  from instead of cold-starting, and what a seat begun from one would already believe.
- **`rig package validate` / `plan` / `install` / `rollback`** — install a file-level payload into
  an existing repository, and take it back out.

## Reaching another machine

**The world does not end at this box.** Other agents are running on other machines right now, and
reaching them is ordinary work rather than an escalation.

- **`rig host add` / `rename` / `doctor`** — make another machine reachable as one pasted address,
  see which host you are acting on, and check a registered host is *actually* usable end to end.
- **Which machines exist and how each is reached is a declared registry** — read the entry rather
  than guessing a hostname, because entries do not all use the same transport.
- **`rig file copy`** — move a file between hosts without hand-rolling `scp` and guessing the
  address.
- **`rig gateway human list` / `show`** — discover registered humans and inspect configured,
  enabled, active, ready, reason, and next action. Use the returned `<entityId>@external`
  address; a username or kernel seat is not a human delivery address.
- **`rig queue create --destination <entityId>@external --verify`** — persist one human
  request, then boundedly inspect its transport receipt. Posted means posted, not read;
  pending, failed, or indeterminate delivery leaves the row intact. Inspect the same row's
  transitions before retrying. `rig send` remains agent-terminal delivery only.
- **When project policy calls for human judgment or an update, load `messaging-the-human`.**
  Use `rig context get skills/core/messaging-the-human/SKILL.md` for a complete decision brief,
  related supplemental detail and explicit quiet-update intent. An FYI creates no approval
  obligation; writing “FYI” in ordinary request prose does not select that intent.
  System World teaches these mechanics; Project World decides when and why they apply.
  Existing `<entityId>@host` blockers are internal custody labels mapped through the registry
  to the external participant, not a separate outbound route.
- **`rig gateway human add`** — register a person and their connector binding. Registration or
  connector changes do not themselves authorize a message.
- **During local-daemon outage, remote HTTP sender attribution still uses the originating
  instance's durable identity.** A selected remote or forwarded endpoint never becomes the origin.
  Missing local identity remains explicitly unknown; transport success is not operation success.
- **Across a host boundary, "it didn't work" has four distinct shapes** — unreachable machine,
  permission gate, remote runtime down, or the remote command itself failed. Collapsing them throws
  away a diagnosis you already had. **And a transport that succeeded says nothing about whether the
  operation did.**

## Changing your own situation

**You are a user of this system exactly as a human operator is.** Most of what looks fixed about
your circumstances is configuration, and the ones that are not, another agent can change for you.

- **`rig config get` / `reset` / `init-workspace`** — read one value, change a system-wide setting
  and put it back exactly as it was, or additively lay down the canonical project scaffold on a
  box that has none. Instance startup uses the same additive initializer for the surrounding
  `state`, `context`, `skills`, `topology`, and operational roots.
- **`rig policy list` / `show` / `current`** *(v0.5.2)* — what permission policy is actually in
  effect: discovers custom policy specs, validates refs (malformed can never read as valid OR
  absent), shows what would apply.
- **`rig policy cite` / `defaults`** — what posture the operator is in: how autonomous to be, how
  loudly to report, whether to batch permission questions or block on them. **This declares a
  posture; it does not grant or deny permissions** — the harness's own settings are the control
  surface for that.
- **`rig mode effective --rig <id> --json`** — inspect scoped human-led/delegated posture, phase
  and source; project, mission and qitem selectors are also available in help. Resolved unset
  scopes default to human-led; missing or ambiguous identity stays unknown. To deliberately
  change a mission, `rig mode set delegated --scope mission --qualifier <project>/<mission>
  --evidence "<decision>"` proposes it without writing; add `--confirm` to apply an authorized
  choice, or select `human-led` to return to interactive work. Posture grants no authority.
  Human-led process diagnosis is quiet; operational health and ordinary reminders remain.
  See `docs/reference/scoped-operating-posture.md` for precedence and other scopes.
- **Project World declares the human authority boundary.** Read the current project and mission
  policy for actions requiring approval; the system mechanics do not impose a universal list.
  A script's explicit-path authoring guard (for example `OPENRIG_SKILL_CANON_ROOT`) asks for a
  missing source path and does not itself create a permission gate.
- **`rig auth list` / `validate` / `seats`** — is this seat's runtime actually logged in, which
  accounts exist, and which account each seat is *supposed* to be on.
- **`rig provider accounts` / `bindings` / `signals` / `switch`** — which seats are bound to which
  accounts, what the usage signals say, and whether a seat can be moved without stranding the
  conversation it is in the middle of. **`provider signals` reports anomalies rather than a
  listing** — unbound seats, accounts shared across several seats.
- **Codex configuration fragments** — a `codex_config_fragment` must open with a table header and
  never overrides a user-declared table; see `docs/reference/agent-spec.md`.
- **`rig env`** — the real services behind a rig: are they up, what are they saying, how do you
  stop them without killing the rig.
- **`rig setup`** — what OpenRig would change about this machine, shown before it touches anything.
- **`rig usage series`** — what a seat's token curve has looked like over time: climbing steadily,
  reset, or stopped reporting entirely. The last one is a signal, not a gap.
- **`rig tui`** — the interactive view over rigs, pods, seats and specs. `rig tui --shared`
  attaches to the existing kernel terminal; Ctrl-b then d detaches, and no missing seat or
  terminal is implicitly launched. Plain `rig tui` remains a separate view.
  Open the instance row for one continuous cross-rig agent table with pod separators and material
  `RECENT` transitions; drill into a rig, mission, slice, or agent without losing the owning
  identity. Use the mission's workflow/packet view and Specs purpose/source to understand work.
  In **Specs**, kind groups start collapsed and expand explicitly. Selection previews purpose,
  contents and provenance; Enter opens details.
  **View current source** reads disk within the explicitly configured readable roots. Relative
  Markdown links resolve against that source; headings open with a labelled starting point.
  Escape or `back` restores the caller's selection and scroll. Detail uses the full width on
  narrow terminals. The TUI command `read <root>/<path>#heading` also opens a named source;
  missing, denied, binary, truncated and missing-heading results stay explicit. HTTP(S) links
  show a selectable destination without opening a browser; `v` enables terminal text selection.
  Tab completes commands and snapshot arguments; Recent opens original events. **System** opens
  to instance **Health**, with **Configuration** and **Connections** beneath it. Contextual Health
  remains available in the owning rig or agent view. **Configuration** browses instance/work
  roots, context, display, waiting, recovery, activity and advanced settings;
  Slack and people are one category. Select a category, use right/left to change panes,
  Enter for full value/default/source/scope, `/` to search labels and keys, and Escape or `back`
  to return. Long detail scrolls; `v` enables terminal text selection. `refresh` reads the current
  view again without changing settings or verifying delivery. Sources & coverage names exclusions,
  daemon/CLI identity and the client timezone separately. Resolved settings do not prove runtime
  adoption. Direct `config` and `connections` commands remain; Connections inspects gateway
  services and human routes. Dated verification does not prove delivery. `timezone` gives
  persistent local-time guidance.
  **?** opens full-screen Help with command grammar and examples; Escape returns to the caller.
  **`rig tui commands`** lists everything it can do without launching it. **`rig ui open`** is
  unmaintained, best-effort, and replaced by the TUI, so never diagnose product behaviour from
  the web UI. The TUI plus Slack are the human surface; the CLI plus terminal are the agent surface.
- **`rig mcp serve`** — how an agent that speaks MCP rather than shell drives OpenRig, and which
  operations are exposed that way. Relevant the moment a tool you are integrating cannot run a
  shell command.
- **`rig skill loadout --runtime <claude-code|codex>`** — inspect the exact catalog revision,
  selectors, target, and current/missing/shadowed/conflicting state for one working directory.
  `--apply` writes only the managed ownership set, is idempotent, and refuses local edits or
  unowned collisions.
- **`rig startup-proof submit`** — answer an explicitly selected authenticated startup challenge.
  Startup adds no proof exercise by default. Declare `startup_proof` with `authenticated` or
  `none` in the applicable startup layers; see `docs/reference/rig-spec.md#startup-block/startup-proof-selection`.
  Terminal nodes never challenge, and resume/adoption does not create a new challenge.

---

## Crossing them — where the leverage actually is

**Everything above is a single verb answering a single question. Almost every question you
actually have is a JOIN**, and no surface here holds one. This is the part that separates knowing
the list from being able to use it.

**And the joins that matter most cross OUT of `rig`** — into your shell, your subagents, the
database. It is one more set of primitives on a machine full of them.

- **"Who should be working and isn't?"** — `rig ps --nodes` knows who is alive; the queue knows who
  owes. **Neither knows the interesting cell.** Cross them and *alive, holding work, and not
  moving* falls out — which is the actual question behind every "is the rig stuck."
- **"Is that seat stuck or thinking?"** — the row face answers this now (S04 pickup receipts):
  every list/show projection carries a derived `pickup` state — `working`, `stalled-after-claim`
  (with its evidence named: time since meaningful queue change and current activity confidence), `parked`, or
  `unclaimed` — and `rig view show pickup` lists every claimed row with it. The old by-hand join
  (capture + `claimedAt` arithmetic + `queue transitions`) is RETIRED as a first move; `rig
  capture` remains the second question (is the pane alive), never the state derivation.
- **"Is this a park or a strand?"** — the row face answers the pickup half: `parked` means the row is blocked,
  whether or not it has a wake; a strand reads `stalled-after-claim` with named evidence. Wake
  health and fired-but-unconsumed diagnosis come from `rig parked`, not the pickup projection.
  `queue transitions` remains the audit trail for WHAT happened, not the tool for deriving pickup.
- **"Did that actually land?"** — `rig queue show <qitemId>` gives a bounded preview,
  original byte size and the exact expansion command. Read the complete original record with
  `rig queue show <qitemId> --full --json`; a preview or a compact list is not the whole body.
  Delivery status is separate from content: inspect its receipt before claiming it was consumed.
- **"What am I waiting on?"** — the queue row's `waiting` view derives its owner, exact blocker
  and blocker owner, last meaningful change, activity confidence and next backstop from live
  domain facts. A failed handoff names the delivery ladder before the later unclaimed safety
  net; its due time is earliest eligibility, with suspension or current recovery disposition
  shown explicitly. The executing scheduler still checks live state at that time. A working activity observation is not proof of task progress; unknown stays
  unknown. A repeating wait sends one compact notice per blocker transition, with the existing
  stuck sweep owning a failed or unconsumed notice after the pickup grace. Real changes use the
  event path; scheduler reconciliation repairs missed events. A returned result and its dependent
  resumes share one delivery while retaining their separate rows and receipts.
  For a workflow waiting on a slice outcome, add `--wait-for-proof <slice-scope>` to
  `rig workflow project --exit waiting`: it binds the current proof `attention` revision.
  Proof events invalidate that observation; the authored wait timer repairs a missed event
  by reading the same current proof source. Inspect `rig workflow project --help` for the
  required instance, packet and actor arguments; this opt-in does not accept a slice.
- **"What does this whole corpus say about X?"** — bigger than your window, so do not read it.
  **Fan out**: one region per subagent, N in parallel, each returning a structured report, and you
  read reports rather than sources. **This is the move that beats your own context limit** — it
  changes what is answerable, not just how fast.
- **"Is what I folded actually running?"** — `git` says what is in the tree; `curl -s
  localhost:7433/healthz` says what the daemon is executing. **Folded is not running**, and only
  the cross tells you which you have.

**The pattern, and it generalises well past this list: when a question feels unanswerable, it is
usually one join away.** A second source rarely adds — it multiplies, because it can disambiguate
things the first source cannot express at all.

**Composing is free while you are looking** — searching, counting, tracing, reading. Chain as
aggressively as you like. It earns its danger only when you **mutate**. Be fearless reading and
deliberate writing.

---

## The one to remember when nothing here matches

**`rig --help`**, then `rig <verb> --help`.

Eighty-one verbs ship, and this page named most of them once. **You will not remember which — you
are meant to remember only that the list is long enough to be worth reading before you build
anything.** The question is never *how do I write this*; it is **does this already exist**.
