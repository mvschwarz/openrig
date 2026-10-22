# Keeping a Watch for a Person

**How an operator turns "remind me in 20 minutes" or "tell me when X happens, check every hour" into a watch it
keeps, using today's queue commands.** The person speaks in sentences. They never see YAML, a job ID or a policy name
unless they ask.

> **Status (0.7.0).** The kernel operator's role guidance points here: when a person asks it to watch something or
> remind them, it reads this page (installed at `$OPENRIG_HOME/reference/keeping-a-watch.md`) first. Every step below
> was exercised with the CLI on an isolated private daemon: create, set aside, fire, re-arm, list, change, stop, a
> daemon restart and a handover. A native run with a real operator, install and channel has **not** been run yet.
> The usage warning's command and field names are checked against the served command on a test fixture; it hasn't
> been run as a watch.

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

**2. Create it for yourself,** with a `watch` tag so it can be listed later (tags can't be changed after creation).
`<your session>` is your session name from `rig whoami --json`:

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

- Always pass `--evidence-ref`; the watch task's ID is a durable pointer the person can open.
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
- **Handing a watch to another session** (`rig queue handoff <task> --to <session>`) closes the old task and retires its
  timer (unless another task shares that timer through `--wake-watchdog`; a watch set up as above never does). The new
  task arrives pending, with its body and `watch` tag but no timer: the new owner sets it aside again with a fresh
  timer, as in step 3.

## A usage warning: "warn me when my allowance runs low"

This is a conditional watch like any other: the same task, timer, re-arm, stop and human channel. Only the check is
specific.

**The check is `rig provider status --all-hosts --json`.** It returns what every registered machine already holds,
this one included, and never starts a read on any account. With no host registry it covers this machine only, and
says so. Use it rather than the single-machine `rig provider status --json`: one allowance used from several
machines appears once, with each machine's own observation beside it, so you can't count it twice. If it answers that
usage windows are off, tell the person that before setting the watch, as you would an unreachable channel.

**Never put `--refresh` in the timer's check.** `rig provider status --all-hosts --refresh` starts a native read of the
accounts on every machine. Run it only when the person asks for a fresh reading now.

**Choose the allowance with the person once, and write its identity into the body.**
- **The allowance:** its `items[].key` and `items[].provider`, read from one run of the check. Show them the allowance
  by its label in the plain `rig provider status --all-hosts` view, never a key they have to type. An item whose key
  is null (a login that hasn't been identified) can't be watched: say so, and offer to watch it once it's identified.
- **For Codex, the login email too:** `items[].observations[].row.identity.email`, shown on each machine's line in the
  plain view. The same Codex account can appear as more than one item with the same key, one per login email (or none)
  it was seen under. So on each fire, use the one item whose key matches and whose observations carry the recorded
  email. If none or several do, you can't tell. A Codex allowance whose login email is missing can't be pinned this
  way, so it stays can't tell. A changed email isn't followed: if the person's login email changes, set the watch
  again with them.
- **The window:** `items[].observations[].row.windows[].window`. Claude's are `five_hour` and `weekly`; Codex's are
  `primary` and `secondary`, with `items[].observations[].row.windows[].durationMins` saying which is which.
- **The threshold:** on `items[].observations[].row.windows[].remainingPercent`. It's a percentage, and no absolute
  amount is served. Remaining is 100 minus `items[].observations[].row.windows[].usedPercent`, never below 0. Both are
  null when the machine reported no usage for the window.

**What each part of the answer means:**

| Field | What it tells you |
|---|---|
| `items[].linkage` | `single`: one machine saw it. `same`: several machines saw one allowance. Compare their observations; **never add or average them**. `conflict`: the machines' fresh observations disagree (their reset times are more than 60 s apart); every observation is kept and none is chosen. `unknown`: the same id seen under another login, or with no login email, and not merged with it. `items[].notes` says why. For Codex, the one item carrying the person's recorded key and email is still theirs: its `unknown` is about the other login's item (see the decision). Any other `unknown` item is not theirs to watch |
| `items[].observations[].hostId`, `items[].observations[].readAt` | Which machine the observation is from, and when this daemon read it |
| `items[].observations[].row.windows[].observedAt` | When that machine's reading was taken: the time to tell the person |
| `items[].observations[].row.windows[].resetsAt` | When that window resets: tell the person this too |
| `items[].observations[].row.windows[].freshness` | `fresh`, `stale` or `unavailable`, with `items[].observations[].row.windows[].freshnessReason` saying why. A reading is fresh for 15 minutes |
| `items[].observations[].row.windows[].level` | The served level, with `items[].observations[].row.windows[].levelReason`. Compare the person's threshold, not this level. But **`unknown` means the number can't be used**: no usage was reported, the window's reset time has passed (the number is from before it), or Claude seats report different windows (possibly different logins) |
| `items[].observations[].row.lastRefresh` | **Codex:** that machine's last native read. When `items[].observations[].row.lastRefresh.outcome` is `failed`, the reading it kept is older and reads `stale`. **Claude:** the last read of the daemon's own Claude login (its identity) only. Claude's windows come from the seats' status-line readings at their own times, so they can stay `fresh` beside a failed identity read |
| `items[].observations[].row.identityNote` | **Claude:** which login the identity is (as of the last identity read) and which seats the windows came from. The windows aren't proven to be that login. Say so when you tell the person |
| `hosts[].usage`, `hosts[].usageReason` | Whether each machine's usage was read: `served`, `off`, `older` or `unavailable`, and why. A machine that wasn't read contributes nothing, never a zero |
| `hosts[].lastRefresh` | The last refresh started from here for that machine, per provider. A `failed` one sits beside the older observation the machine kept |
| `seatAccounts[].seats[].configured`, `seatAccounts[].seats[].allowance` | The account each seat is **configured** to use. `seatAccounts[].seats[].allowance.linked` is always false: configuration isn't proof of which allowance a running seat draws on, or that a Claude seat's windows are the identity's login. Never tell the person a seat uses this allowance because of it |
| `seatAccounts[].seats[].observed` | What the seat itself was seen reporting: whether its status line has sent windows and when (`seatAccounts[].seats[].observed.lastSampledAt`), and `seatAccounts[].seats[].observed.differsFrom`, the seats whose readings disagree with it. Observed facts, still not a link to an allowance |

**The decision on each fire,** using the table in "Every time the timer fires". A usable reading is a `fresh`
observation of the chosen window whose `level` isn't `unknown`.
- **Met:** a usable reading is below the threshold. Tell them the lowest one, with its machine, `observedAt` and
  `resetsAt`. If the linkage is `conflict`, also tell them the machines disagree, from `items[].notes`, rather than
  presenting the lowest as the reading.
- **Not met:** every usable reading is at or above the threshold, and there is at least one.
- **Another login on the same Codex account:** when the item matched by key and recorded email has `items[].notes`
  saying the account is also observed under another login email (or with none), its linkage reads `unknown` on one
  machine, or `same` on several. Use its own usable readings as above. When you tell the person, say that login's
  observations are unlinked: not added, and not merged.
- **Can't tell:** no usable reading: none `fresh`, or the fresh ones' `level` is `unknown`, which includes a null
  `remainingPercent`. Also when the allowance is missing from the answer or its key is null, or (Codex) no login email
  was recorded, or no item, or more than one, carries both the key and the recorded email. Use the once-then-quiet
  unknown rule, and give the reason (`freshnessReason`, `levelReason`, or the machine's `usageReason`).

The task body, for the person's own allowance, window and threshold:

```markdown
Person's words: "Warn me when my Claude allowance drops below 20% of its 5-hour window; check every 30 minutes."
Check: `rig provider status --all-hosts --json` (served readings only; never --refresh).
Allowance: key <allowance key>, provider claude, window five_hour. Chosen with the person.
(For Codex, also: login email <email shown in the label>.)
Usable: a fresh observation of that window whose level isn't unknown.
Met: a usable reading with remainingPercent below 20. Report the lowest, with its machine, observedAt and resetsAt.
Never add machines' numbers. If the linkage is conflict, say the machines disagree (items[].notes).
Claude: say the windows come from seats' status lines and aren't proven to be the identity's login (identityNote).
Codex: the one item with the recorded key and email is theirs even if its linkage is unknown; say the other login's
observations are unlinked (items[].notes).
Can't tell: no usable reading (none fresh, or level unknown: give its levelReason), the allowance missing or its key
null, or (Codex) no email recorded, or no item, or more than one, carries both the key and the recorded email. Give the
reason.
Interval: 30m.
Tell them: <entityId>@external (human channel), once, when met.
Stop: after telling them once, or when they say stop.
Unknown: not said yet.
```

## What not to use

- **`rig watchdog register --policy periodic-reminder` for a person's watch.** It repeats every interval until it's
  stopped (the first fire comes one interval after you register it), and it stops when the agent that registered it
  is replaced. It's fine for agent-to-agent reminders. Your own watch timers also show as `periodic-reminder` in
  `rig watchdog list`: that's the one-shot timer `--wake-after` arms, not a registered repeating reminder. It's retired
  when it fires or when the task stops being set aside. A wake held back because you were typing (a retained
  delivery) wasn't delivered, so it doesn't use the timer up: it's tried again at each interval until an attempt goes
  through (delivered or failed), which retires it. A timer another task shares through `--wake-watchdog` stays live
  for that task when this task is handed off or stopped, and the same rule applies to its wake. None of this is a
  delivery guarantee.
- **Transcript bytes as "usage".** `context-usage-threshold` measures an agent's transcript, not an account's
  allowance. For an allowance, see "A usage warning" above.
