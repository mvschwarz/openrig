# Keeping a Watch for a Person

**How an operator turns "remind me in 20 minutes" or "tell me when X happens, check every hour" into a watch it
keeps, using today's queue commands.** The person speaks in sentences. They never see YAML, a job ID or a policy name
unless they ask.

> **Status (0.7.0, not on by default).** No agent's guidance points here yet, and no profile loads it. It's switched
> on by adding one line to the kernel operator's role guidance, after a native run on a real install shows the
> pattern holds. Until then, hand this page to an operator by hand (`docs/reference/keeping-a-watch.md`) to try it.

## The shape

A watch is a **queue task the operator owns**, set aside with a **one-shot timer**:

1. The person asks. The operator creates one task for itself and sets it aside with `--wake-after`.
2. The timer fires once and wakes the operator. The operator reads the task and checks the condition.
3. Then it tells the person, re-arms the timer, or both. **A timer fires once: a watch that isn't re-armed goes
   quiet.**

OpenRig keeps the record and the timer. The operator does the judgment: what to check, and whether it's worth telling
the person.

## Before you set one: can you reach the person?

Run `rig gateway human list --json`. A watch tells the person through the registered human channel (Slack today,
also shown in the TUI Feed), at `<entityId>@external`. **A terminal is never a person's address.** If no human is
registered, say so now, before setting anything up: a watch that can't reach them is a watch they'll never hear from.

## Setting a watch

**1. Write the task body for a successor.** You may be restarted, compacted or replaced before the watch ends. A new
operator must be able to act from the task alone. Put these in the body:

```markdown
Person's words: "Tell me when the release PR merges; check every hour."
Check: `gh pr view <n> --json state` — met when state is MERGED.
Interval: 1h.
Tell them: <entityId>@external (human channel), once, when met.
Stop: after telling them once, or when they say stop.
Unknown: not said yet.
```

**2. Create it for yourself,** with a `watch` tag so it can be listed later (tags can't be changed after creation):

```bash
rig queue create --destination <your session> --tags watch \
  --summary "Watch: tell <person> when the release PR merges (hourly)" --body-file <file>
```

**3. Set it aside with the timer.** A new pending task can be set aside directly; no claim is needed:

```bash
rig queue block <task> --on external:<what you check> --wake-after 1h \
  --continuation "check <what>; tell <person> if met, else re-arm 1h"
```

`--on` is always required; `external:<what>` names the outside thing you're waiting on. The timer first fires after
the interval, not now.

**4. Say back what you set, in one or two plain lines:** what you'll check, how often, how they'll be told, and when
it stops. For example: "I'll check the release PR every hour and message you here once it merges. Then I'll stop."

A plain reminder ("remind me in 20 minutes to look at the release notes") is the same with no condition. Set it aside
with `--wake-after 20m`, and when it fires, tell them and close it.

## Every time the timer fires: read the record first

When the timer's message arrives, **run `rig queue show <task> --full --json` before doing anything.** A message already
on its way can still arrive after the watch was stopped or changed. If the task is no longer set aside (done, canceled, or replaced),
do nothing.

Otherwise, check the condition, then do exactly one of these:

| What you found | Do |
|---|---|
| **Met, and the watch was "once"** | Tell the person (below), then close: `rig queue update <task> --state done --closure-reason no-follow-on --note "<what you saw>"` |
| **Met, and it's "every time"** | Tell the person, then re-arm |
| **Not met** | Re-arm. Say nothing to the person: never send "nothing yet" |
| **Can't tell** (no fresh reading) | The first time, tell them once that you can't tell, and why. Record that in a note (`Unknown: said <time>`), then re-arm. **Never say "all fine" for an unknown.** Stay quiet on later unknowns until the reading returns or changes |

**Re-arm** by setting it aside again with a fresh timer:

```bash
rig queue block <task> --on external:<what> --wake-after 1h --note "checked <time>: not met"
```

A new set-aside replaces the old one and retires any earlier timer, so a task never carries two live timers.

**Put what changed in `--note` or `--continuation`, not both.** When `rig queue block` gets `--continuation`, that is
the note it records, and `--note` is dropped.

Each check costs one of your turns on the person's subscription. **Use the longest interval that serves the ask.**

## Telling the person

```bash
rig queue create --destination <entityId>@external --human-intent update \
  --summary "<subject>" --body-file <brief> --evidence-ref <watch task id> --verify --json
```

- `--evidence-ref` is required for anything sent to a person. The watch task's ID is a durable pointer.
- Later messages about the same watch can thread with `--reply-to <earlier message's id>`.
- **`posted` means the connector posted it, not that they read it.** Don't say they saw it.
- **If delivery fails or is indeterminate,** inspect that task before anything else. Never resend blindly.

## "What are you watching for me?"

List **every active state**, not just set-aside ones. A watch being checked can be in progress, and a new one can be
pending:

```bash
rig queue list --owned --state pending,in-progress,blocked --full --limit 200 -o json
```

Then keep the tasks tagged `watch`. Two rules:

- **Check that the number of tasks returned is below the limit.** The limit applies before you filter by tag. If you got
  exactly the limit, raise it and list again. **Never report "no watch" from a page that was cut off.**
- **Use `--full`.** Compact output leaves out the body and the waiting view.

For each watch, say what it checks, how often, how they'll be told, and the next check. The next check is
`waiting.nextBackstop.dueAt` when `waiting.nextBackstop.mechanism` starts with `watchdog:`. If a set-aside watch shows
no timed backstop instead, its timer has fired and wasn't re-armed. Check it now and re-arm it.

Answer from the records, so a second reader would give the same list.

## Changing or stopping a watch

| The person says | Do |
|---|---|
| **"Check every 2 hours instead"** | Re-arm with the new interval and a note saying what changed: `rig queue block <task> --on external:<what> --wake-after 2h --note "<person's words>"` |
| **"Watch Y instead"** (what's checked changes) | A task's body can't be edited. Create the new watch, then retire the old one: `rig queue update <old> --state canceled --closure-reason superseded --closure-target <new> --note "<person's words>"` |
| **"Stop watching that"** | `rig queue update <task> --state canceled --note "<person's words>"`. Leaving the set-aside state retires its timer. A plain cancel takes no other closure fields |

Tell the person in one line what changed. After a stop, take no further action for that watch.

## Across a restart or handover

A set-aside watch's current timer is **kept** when the operator is restarted or replaced, and it fires at whoever is
the operator next. That's why the body must stand alone.

**One gap:** a timer fires once. If the operator is replaced **after a fire and before the re-arm**, the successor
inherits a set-aside watch with no live timer. OpenRig's idle-owner check may remind the new operator once, but only
under some conditions, with no delay guarantee. So:

- **Re-arm promptly** after every fire.
- **After a restart or handover, list your watches** (above) and re-arm any that show no timed backstop.

## What not to use

- **`rig watchdog register --policy periodic-reminder` for a person's watch.** It fires on the first scheduler tick,
  repeats forever, and stops when the agent that registered it is replaced. It's fine for agent-to-agent reminders.
- **Transcript bytes as "usage".** `context-usage-threshold` measures an agent's transcript, not an account's
  allowance.
