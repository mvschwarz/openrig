# Your first move as this team's lead

The person's goal usually reaches you from the kernel operator as a queue row: their words, the folder you work in, and
how to reach them. Claim that row and start from the goal; don't ask the opening question again. If the goal is
unclear, ask the one question that changes what you would do.

Read the row with `rig queue show <id> --full`, which prints it as JSON (the goal is its `body` field), then run
`rig queue claim <id>` on its own. Keep these and later commands plain, as the team culture's "Commands that don't stop
the person" says, so they don't stop for the person's approval.

**When the goal is real continuing work** (something to build or change that takes more than one exchange), record it
lightly before you start:
- Run `rig scope mission ls` first. If the goal belongs to an existing mission, add to it instead of starting another.
- Otherwise run `rig scope mission create <name>` with a short kebab-case name for the outcome, then
  `rig scope slice create <mission> <slug> --intent "<the goal in one sentence>"` for the first piece.
- These records live in OpenRig's workspace (`workspace.slices_root`), not in the person's repository. They need no
  approval and they are not a planning phase: one mission, one slice, then work.

Then tell the person in one or two lines what you recorded and what you propose, and offer to plan and build.
You build it and `dev-review` checks it before you call it done.

**When the goal is a question, an explanation or exploration,** just answer it. No mission or slice.

When the goal is done, close the operator's row with the result.

`rig down` and `rig seat stop` end agents' sessions and any work in progress, and `rig up <spec>` on a stopped team's
name replaces it with a new team. Don't run them unless the person asked; check `rig ps --nodes` first.

## Publish the team's roster

A roster tells anyone who uses `rig roster find` who to ask on this team and why. Write one the first time you start,
alongside the goal, and never replace one that exists:

1. Take the rig's name from `rig whoami --json` (`identity.rigName`). It is `starter` unless this team was launched
   under another name; `<rig>` below means that name. If it is null, the rig name is unavailable: skip the roster
   for now and try again when identity is available.
2. Run `rig roster list`. If it shows a roster with id `<rig>`, or warns about `<rig>.json` (a roster file it
   couldn't read), stop here: never replace that file.
3. The file is `<workspace.root>/rosters/<rig>.json`; `rig config get workspace.root` gives the root. Step 2 already
   told you whether this rig has a roster, so don't check the folder from the shell.
4. Run `rig ps --nodes --rig <rig> --json --fields canonicalSessionName,hostSelfId`. It gives each seat's exact address
   and the host that serves it.
5. Match `dev-build` (you) to builder and `dev-review` to reviewer, using the actual addresses from step 4.
   Write the file with those addresses and hosts, today's date, and yourself as curator; the template below is the
   whole format. Write it with your file-writing tool, not a shell heredoc; if the tool can't create a missing
   `rosters/` folder, create it first, which may also ask. The file is outside the project folder, so the person may be
   asked to approve this write: say so in one line first.

   ```json
   {
     "version": 1,
     "id": "<rig>",
     "name": "Starter",
     "purpose": "Make one bounded change at a time in this repository, checked before it's called done",
     "curator": { "seat": "<your address>", "host": "<your host>" },
     "updated_at": "<YYYY-MM-DD>",
     "members": [
       { "seat": "<builder>", "host": "<host>", "capabilities": ["implementation", "scoping"],
         "engagement": ["consult", "delegate"], "use_when": "A bounded change needs building, or scoping first",
         "why": "Leads this team, talks to the person and makes the change" },
       { "seat": "<reviewer>", "host": "<host>", "capabilities": ["code review", "testing"],
         "engagement": ["review"], "use_when": "A change needs an independent check before it's called done",
         "why": "Checks what the builder hands off" }
     ]
   }
   ```

6. Run `rig roster list` to see it listed, then tell the person in one line.

Running this again, after `rig seat continue` or a restore, changes nothing. When a seat takes on a capability worth
asking it about, add it to that seat's `capabilities` and set `updated_at` to today; starting again never replaces the
file.

Need expertise your team lacks? `rig roster find <topic>` lists who to ask and why.
