# Community harness presets

A community harness is a coding harness an outside contributor maintains. You install it as one small data file, and a
rig member runs it by naming it as its `runtime`. OpenRig doesn't test these harnesses. It shows them as community
harnesses, and it reads their activity only from what the screen shows.

## The preset

One YAML file per harness: `$OPENRIG_HOME/community-harnesses/<name>.yaml`. `rig community-harness list` shows what's
installed.

```yaml
format: 1
name: example-harness           # must match the file name: lowercase letters, digits and hyphens
command: example-launch         # one program and its arguments, typed into the seat's pane
maintainer: Example Maintainer
limits:                         # what the maintainer says doesn't work
  - fork unsupported
launch_result: true             # optional: the launcher reports the conversation it created (below)
resume: true                    # optional, needs launch_result; declare it only once your harness's resume is checked
```

- **`command`** is a single program and its arguments. Shell syntax such as `|`, `&&`, `;`, redirections or `$(…)`
  is refused: put it in a script and name the script.
- **Built-in runtime names are reserved.** A preset can't replace `claude-code`, `codex` or the other built-ins.
- **Unknown fields are refused,** so a preset written for a newer OpenRig says so instead of half-working.
- **Fork isn't supported, and resume only as described below.** Neither is placing skills, guidance or startup files. The seat is
  called ready while something other than a shell runs in its pane, which says nothing about which conversation it is.

## Reporting the conversation a launch created (`launch_result: true`)

Some harnesses create their own conversation id before they start. Cursor's `cursor-agent create-chat` is one. With
`launch_result: true`, the harness's launcher tells OpenRig that id for each launch.

1. **OpenRig names one file per launch attempt.** It starts `command` with two variables:
   - `OPENRIG_LAUNCH_RESULT`, a new file path inside `$OPENRIG_HOME/state/launch-results/`;
   - `OPENRIG_LAUNCH_ATTEMPT`, this attempt's id.
2. **The launcher writes one JSON record to that path,** then starts the harness:
   ```json
   { "format": 1, "attempt": "<OPENRIG_LAUNCH_ATTEMPT>", "harness": "cursor", "nativeRef": "<the conversation id>", "producer": "openrig-cursor-launch 1.0" }
   ```
3. **OpenRig reads that attempt's record once,** waiting up to 20 seconds for it. It records `nativeRef` on the session,
   and the seat shows its identity as **reported by its launcher, not observed**. That's what the launcher says, not
   proof that the harness used it.

The seat still starts, with its identity **unavailable** and the reason named, when the record:
- wasn't written;
- belongs to another attempt or another harness;
- isn't JSON, isn't format 1, or is larger than 64 KiB;
- has an unusable `nativeRef` (empty, too long, or containing spaces or control characters);
- names no producer;
- or is reached through a link.

None of these means the conversation is gone.

A reported id doesn't make the harness resumable on its own. Without `resume: true`, nothing resumes it: a restore
stops and asks, as it did before (re-run it with `--fresh <seat>` only if you want a new conversation), and elsewhere a
resume says it's unsupported, and a new conversation starts only where the caller allows a fresh start.

**Good to know:**
- **The variables are passed with `/usr/bin/env`,** so `launch_result` needs a POSIX system.
- **A launcher that never writes its record** adds up to 20 seconds to each launch, while OpenRig waits for it.
- **Records are kept,** one small file per attempt, under `$OPENRIG_HOME/state/launch-results/<session>/`. A record
  larger than 64 KiB isn't read.

## Reopening a reported conversation (`resume: true`)

With `resume: true` as well, a resume (a restore included) starts the launcher with `OPENRIG_RESUME_REF` set to the
conversation to reopen. The launcher reports what happened in the same attempt's file:
- **Reopened:** the usual record, with that conversation as `nativeRef`.
- **Gone:** `{ "format": 1, "attempt": "…", "harness": "cursor", "error": "missing", "producer": "…" }`. The launcher
  starts nothing. OpenRig reports the conversation missing and starts nothing either: it never replaces it with a new one.

OpenRig also says so plainly when:
- **no usable record is written:** the resume isn't confirmed. The seat needs attention and keeps the conversation it
  asked for; nothing is restarted;
- **the record names a different conversation:** the seat needs attention and keeps the conversation it asked for.
  OpenRig doesn't switch it to the reported one;
- **the saved conversation isn't one this harness's launcher reported** (a former runtime's id, say): it isn't passed to
  the launcher. A restore stops and asks, and elsewhere the resume says it isn't possible;
- **the record's folder can't be made:** the launcher couldn't be told what to reopen, so nothing starts.

**Not supported for community harnesses:** restarting a seat in place (`rig seat restart` is for Codex seats) and
switching harness on a running seat. Each says so before anything changes.

The launcher is the contributor's code, in the contributor's package. OpenRig runs no code from a preset and loads no
module into its daemon. A preset that sets `launch_result` is refused by an older OpenRig, which doesn't know the field.
