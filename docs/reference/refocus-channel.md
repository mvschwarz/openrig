# The Refocus Channel

**How orientation content reaches a RUNNING seat.** Editing a file is not
delivery: a running seat read its configuration at session start, and nothing
in its context re-reads disk on its own. The refocus channel closes that gap —
it is the mechanism that makes shipped chain files (see
`chain-file-convention.md`) live doctrine rather than boot-time decoration.

## The mechanism

`openrig-core` ships `hooks/scripts/refocus.cjs`, registered on both runtimes:

| event | Claude Code | Codex | why |
|---|---|---|---|
| UserPromptSubmit | ✓ | ✓ | deliver due or on-demand context at a model-visible boundary |
| Stop | ✓ | — | catch a long Claude turn crossing the growth threshold |
| PostCompact | ✓ | ✓ | retain exact compaction due-state; deliver on the next actionable prompt |

**How the hooks reach a seat.** A Claude seat whose resolved plugin selection includes the shipped `openrig-core` plugin
(for example `plugins: [shared:openrig-core]`, or the same plugin under another name) starts with `CLAUDE_CODE_PLUGIN_DIRS`
set to the vendored plugin (`$OPENRIG_HOME/plugins/openrig-core`), so Claude loads `hooks/claude.json` with no setup step, on a
fresh launch, a restore, a handover successor and a launch with a permission mode. A seat that didn't select the plugin is
launched as before and doesn't load these hooks. The folder a spec's plugin selection projects into the seat's workspace is
not what Claude loads. A list the seat declares itself in `CLAUDE_CODE_PLUGIN_DIRS` keeps working, with the vendored plugin
added after it.
Claude Code reads this variable from v2.1.280. OpenRig doesn't check the Claude version at launch: an older Claude ignores the
variable, starts normally, and doesn't load these hooks. The behaviour was checked on Claude Code 2.1.296 and not on
earlier versions.
A Claude started from inside a seat (its shell or Bash tool) inherits the seat's environment and so loads the plugin as well.
A seat that loads the plugin is also given `OPENRIG_SEAT_PROJECT_DIR`, its launch project, and the plugin's seat effects (the
activity and session-identity posts, the compaction hooks, refocus, and the first-launch marker) run only when that Claude's
`CLAUDE_PROJECT_DIR` names the same folder (compared by real path, so a trailing slash or symlink doesn't matter). A nested
Claude in another project, or in a subfolder of the seat's project, therefore changes nothing for the seat, and a `cd` inside
the seat's own session keeps working because `CLAUDE_PROJECT_DIR` is fixed when Claude starts. A nested Claude in the seat's
own project folder is the same project and still acts as the seat, as before this change. Without either variable (a seat
launched before this change, a manual run) the hooks do what they always did. The plugin's activity relay stays quiet next to
the seat's own `settings.local.json` copy only when that entry is exactly OpenRig's and the script it names is the same
script; an entry from an older install doesn't match, so both report until the seat's next launch refreshes it.
Codex has no way to load a plugin from a directory; its hooks come from the daemon's
managed block in `config.toml`, which today carries the activity relay only, so the Codex column above describes
`hooks/codex.json`'s registration and not a hook a Codex seat currently runs.

Claude's additional firing signal is **transcript growth** — not turns (one turn
can burn 200k tokens across fifty tool calls) and not wall-clock (the failure is
sustained work, not elapsed time). Its default threshold is ~2.6MB of JSONL
growth (≈300k tokens); tune with `OPENRIG_REFOCUS_BYTES`. Codex never uses that
threshold: its exact `PostCompact` lifecycle hook is the trigger, avoiding a
redundant double-fire around Codex's own compaction cadence. Set
`OPENRIG_REFOCUS_NOW=1` for an on-demand refocus and
`OPENRIG_REFOCUS_ENABLED=0` to disable the feature. Fresh `SessionStart` is
always a no-op: the default onboarding pack owns fresh orientation. Both
runtimes retain `PostCompact` due-state for the next prompt. After a managed Claude
compaction, the acknowledgement-only boundary and other prompts (for up to 10 minutes)
are skipped without consuming that state, so the hook delivers on the restore request
(after 10 minutes, on the next prompt);
that request asks the seat to read the refocusing skill and consume the delivered
traces rather than rerun them, and the read-depth audit accounts for them. Otherwise the hook
is a no-op (it writes a stderr advisory when the transcript shrinks or the
session has no identity), and it degrades to silence on unrelated hook errors.
**Time budget.** By default each lookup (the trace, the content REF, `rig queue whoami`, `rig config`) gets 2 seconds,
as before, and a slow one ends as a reported gap (`TRACE GAP`, `REFOCUS CONTENT REF FAILED`, or a role marked
unknown). Set `OPENRIG_REFOCUS_BUDGET_MS` in a seat's environment to give a slow trace more time, up to 52000 (52 s).
Each lookup's cap then grows in proportion (at 45000 the trace may take 20 seconds; at 52000, about 23), and every lookup
is also cut to what is left of that budget, so the attempt delivers what it has and counts as failed. After a failed
attempt, the issue report gets its own 1.5 seconds once the lookups are done. Both registrations allow `refocus.cjs` 60
seconds, where they used to stop it at 5; the other OpenRig hooks keep theirs. So a default fire whose lookups together
pass 5 seconds now completes instead of being stopped with nothing delivered, and a hook that hangs outside its lookups
can hold a prompt for up to those 60 seconds.

A configured REF resolution failure degrades loudly in the delivered payload while still completing the hook — a
refocus must never break a seat's turn.

**Overlapping events (unresolved).** Two hook runs for the same seat and occupant are not serialized. If they overlap,
a `PostCompact` recorded while a prompt is delivering can be lost, and one refocus can be delivered twice. This is
reproduced between hook processes; whether a harness overlaps these events for one session is not established, so it is
an open gap, not one shown to be safe.

Failed trace or configured-content resolution keeps refocus due. After three
consecutive failed attempts for the same seat and occupant, the hook emits one
idempotent issue-stream item tagged `issue,refocus`, visible through `rig stream
list --tag refocus`. A successful delivery resets that failure episode. An
unconfirmed stream write keeps the same item ID for the next failed attempt; it
does not send a wake, change seat status, or prove the agent read the content.

Because the hook runs at the seat's own turn boundaries, delivery to a
RUNNING seat needs no relaunch, no operator action, and no message traffic:
the next prompt the seat processes carries the content. The latency bound is
"the seat's next turn," which is also the earliest moment new orientation
could have been acted on anyway.

## The content is configurable — and never project-specific in source

Resolution order:

1. `OPENRIG_REFOCUS_CONTENT_REF` — a path-like context-library ref resolved
   through `rig context get`, so refocus receives the same assembled bytes as
   on-demand pull. This wins when REF and FILE are both set.
2. `OPENRIG_REFOCUS_CONTENT_FILE` — an operator-authored file, set in the
   environment the seat's harness runs in (rig and agent specs have no `env`
   key).
3. `$OPENRIG_HOME/refocus/REFOCUS.md` — the instance's standing content.
4. The generic default at
   `skills/refocusing/references/refocus.md`: three project-neutral orientation
   questions, the ladder itself, and a pointer to the separately shipped
   onboarding assets.

The hook names a resolved REF in the delivered payload. If REF resolution
fails, the payload starts with `REFOCUS CONTENT REF FAILED`, the exact ref, and
the resolver's reason, then continues with generic orientation. A broken ref
therefore stays visible without blocking the seat's session boundary. With REF
unset, the existing FILE and generic paths are unchanged.

Mission-, project-, or box-specific refocus text belongs in a context-library
entry or one of those FILES on the instance that needs it. **It must never be committed into product
source** — the shipped default carries no path, seat name, mission, or
practice that is not generally applicable.

Every delivered refocus pairs its content with the public `refocusing` skill's
path-only trace. Configure `OPENRIG_REFOCUS_TREES=topology|work|both` and
`OPENRIG_REFOCUS_DEPTH=light|full`; optional `OPENRIG_REFOCUS_TOPOLOGY_NODE`
and `OPENRIG_REFOCUS_WORK_NODE` select starts that cannot be derived. The
script resolves `topology.root` and `workspace.root` through live config and
reports broken links as gaps rather than following pointers.

This automatic hook path is additive to one-shot manual injection through
`rig send --context`; neither mode substitutes for the other.

## The work packet (switched off by default)

Set `OPENRIG_REFOCUS_WORK_PACKET=1` in a seat's harness environment so its
refocus carries the work it is actually doing as text rather than as pointers.
With the switch on:

- The hook asks `rig queue whoami --work-candidates` for labelled evidence.
  That is each in-progress row's own `mission:` tag (a slice tag is optional),
  or for an untagged row the nearest local handoff ancestor's mission, plus
  blocked rows as held work and pending rows as possible next work. The
  strict `currentWork` derivation is unchanged.
- One direct, resolved tag is shown as the work, labelled with its source so
  the agent can correct a stale tag. Anything less certain lists every
  candidate's one-line intent and asks the agent to name its mission (or to say
  it has no current work), giving the `--work-start` route that then shows
  that mission's intent as text. The project-level chain appears only as
  labelled orientation.
- A tag that does not resolve on this host is named, never replaced. A
  retargeted handoff or a remote ancestor gives no assumed mission. A mission
  named only in body text is not evidence.
- The seat's `LEARNED.md` contributes its `MY JOB HERE` and `STANDING DUTIES`
  sections, and notes and each node's `PROGRESS.md` contribute their
  `Current state` section. When a file has
  no such heading, the packet says so and shows a bounded excerpt. No heading
  is required.
- A notes or `LEARNED.md` file older than
  `OPENRIG_REFOCUS_NOTES_MAX_AGE_DAYS` (default 14) is named with its age, the
  age's source (`updated:` frontmatter, else mtime) and the threshold: a cue
  for judgment, not a staleness verdict.

`trace-to-root.py --packet --work-candidates <path|->` renders the same packet
by hand.

## Relation to chain files

The chain files are the durable, altitude-addressed home of orientation
content; the refocus channel is its delivery schedule. A practice added to a
rig's `LEARNED.md` today reaches running seats through their next refocus
trace, which reads `LEARNED.md` at each topology level. The default light trace
shows only about the first 800 characters of each `LEARNED.md` body, so a
practice appended to a longer file reaches seats only with
`OPENRIG_REFOCUS_DEPTH=full` or through the configured refocus content. A `CRAFT.md` practice
reaches them only through the configured refocus content (REF or FILE), and future
installs through the shipped defaults
(discovery → curation → ship, per the convention doc).

## What a refocus is NOT

A refocus corrects drift; it is not a wake (which restores liveness and must
not reframe work) and not a checkpoint (a deliberate phase-boundary pause).
Sending the heavy intervention when the light one was due is the most common
self-inflicted stall — the hook fires the light one automatically, which is
the point.
