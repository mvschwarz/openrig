# Queue erasure: closed-work retention and account deletion

A daemon that serves several accounts sometimes needs to remove queue content for good: closed work after its retention window, or everything that belongs to an account when the account is deleted. `rig queue erase` and three retention settings do that.

Erasure can't be undone. Run every scope as a dry run first, without `--apply`. The dry run prints exactly what `--apply` would erase and changes nothing.

## What is erased

A queue row is erased in one of two ways:

- **Scrub.** The row's content is removed, and the row itself stays, marked `contentErasedAt`. A retried create with the same id still finds the row, so it makes no new work. If anything writes to the row after its scrub (a note, a summary, a reopen and close), the next run erases that content too.
- **Delete.** The row and everything linked to it are removed. Only its id is kept, in an erased-id record with no endpoints and no content. A later create that reuses the id is refused with `qitem_erased` (409), so a retried or forwarded create can't bring the work back.

| A scrub clears | A scrub keeps |
|---|---|
| body, summary, resolution, tags, blocker text, chain of record, evidence reference, human detail, questions and answers, delegated decision, the input-box reading | id, source and destination, state, priority, tier, times, closure reason, handoff links |
| a closure's target when it's a reason or note, in the row, both transition tables and events. That's every target under a reason other than the two at right, and any target under those two that isn't a session address or a queue id | a closure's target that names a successor: under `handed_off_to` or `superseded`, shaped as a session address (`member@rig`, optionally `@host`) or a queue id (`qitem-…`) |
| transition notes and recorded principals, live and archived | each transition's state, actor and time |
| events' `summary`, `reason` and `error` (the event keeps its type and ids, marked `contentErased`) | |
| mission-control audit text and snapshots | |

**The row's own copies go with it:**
- its transitions;
- events whose payload names it;
- its mission-control audit rows.

**Copies held with someone else go only when they're the owner's.** These are outbox and inbox entries that point at the row or wake for it, and stream reader actions and dispositions that name it (including `duplicate_of`). For account deletion, the owner is the account: both of a copy's sessions must be members. Otherwise the owner is the row's own source and destination. Any other copy is kept and listed under `keptCopies`:
- `mixed`: one of its sessions is the owner's;
- `foreign`: none of them are.

**A row a workflow still references is never erased.** That covers a step trail, a frontier binding, a failure record, or a live instance's frontier. It's reported under `gaps` with the code `workflow-reference`.

## Scopes

Name exactly one.

| Scope | Erases | Action |
|---|---|---|
| `--members <file>` | Account deletion. Every row whose source and destination are both in the file, in any state, open work included. Add `--rig <id>` for the account rig's own records | delete |
| `--ids <file>` | Exactly the listed rows. A report's `qitems` entries, or a ledger's lines, keep each entry's own action | `--action delete` (default for plain ids) or `--action scrub` |
| `--routine` | Closed rows past this daemon's retention windows (below) | scrub, then delete |

A file is one entry per line (blank lines and `#` comments are skipped; a line starting with `{` is a JSON entry) or a JSON array.

**Account deletion is exact.**
- The members file is the account's recorded membership: the exact session names of its seats, including departed ones. List every address form the account used, such as a host-suffixed form. Names are compared as given, never by pattern, so a row addressed through an unlisted form is neither erased nor reported.
- **Mixed rows:** a row with exactly one member endpoint is reported under `mixed` (with which endpoint is the member) and left untouched. Deciding who owns it is a separate decision.
- **After the rows:** account deletion also removes outbox and inbox entries between two members that no row owns, and the members' stream items. An entry with one member endpoint, or a stream item something still references, is counted and left.

**The account's rig.** A rig's own records outlive the rig. Events are kept past rig and node deletion by design, and snapshots, node and seat records and watchdog jobs have no key that cascades. `--rig <id>`, given with `--members`, erases them:
- the rig's events, including those of its nodes;
- snapshots, operation correlations and bootstrap runs;
- seat identity verdicts, delivery-guard changes, environment bindings and usage records for its nodes and member sessions;
- watchdog jobs aimed at a member, with their history;
- stream subscriptions and thread maps of member sessions.

Records that name the account but also belong elsewhere are counted under `rig.left` and kept. These are a member's watchdog job aimed outside the account, a workflow instance or spec bound to the rig, classifier leases and custom views.
- **While the rig exists,** its sessions and the members must match both ways, or the run is refused (`erase_rig_mismatch`). Every member's session name must carry the rig's name (departed members included), and every current session of the rig must be a member, so the rig holds no one else's seat.
- **On that verified run,** the rig's id and name are recorded with a digest of the membership.
- **Once the rig is removed,** the same command, with the same membership, uses that record to erase what's left under the rig's id. This includes the events the removal wrote, and the record still lets it count records bound to the rig's name.
- **When nothing of the rig is left,** the record becomes a completion receipt: the rig's name is cleared, and its id, the membership digest and the time stay. An identical rerun, after a lost response say, still verifies and reports the same clean result, with `rig.completedAt`.
- **A removed rig's id that was never verified** with this membership erases nothing keyed by it. Those records are counted under `rig.left`, the name-bound tables are listed under `rig.unknown`, and the run isn't clean.

**Retention windows** (`rig config set …`, read at the daily sweep and at daemon start):

| Setting | Default | Effect |
|---|---|---|
| `retention.closed_content_days` | `0` (off) | Scrub closed rows this many days after they closed |
| `retention.closed_metadata_days` | `0` (off) | Delete closed rows, keeping only their ids, this many days after they closed |
| `retention.erasure_ledger` | empty (none) | An absolute file path. Every applied erasure, by the sweep or the command, appends each row's id and action there, one JSON line each, before anything in its batch changes. A path that can't be written stops the run before it changes anything |

- **Closed** means `done`, `canceled`, `denied` or `handed-off`. `failed` and open work are never touched by the windows.
- **Age:** a row's age counts from when it entered its final closed state. A note on a closed row doesn't restart it, and a row reopened and closed again counts from its latest close.
- **Running them now:** `rig queue erase --routine --apply` runs the windows immediately. `retention.enabled false` turns off the whole sweep, these windows included.
- **When the sweep's erasure stops on an error,** that's logged, and the sweep's other passes still run.

## Account deletion, in order

1. Revoke the account's access.
2. Keep its exact membership list and rig id.
3. Run `rig queue erase --members <file> --rig <id>` as a dry run, then with `--apply`. Rerun until `complete` is true.
4. Remove the rig.
5. Rerun the same command with `--apply`, to erase the records the removal wrote.
6. The account is deleted only when the report's `clean` is true. Otherwise its `mixed`, `gaps`, `keptCopies`, `unlinked` and `rig.left` or `rig.unknown` entries need a decision. Rerunning won't resolve them.

## Output

The command prints one JSON report (`--json` makes it a single line):

| Field | Meaning |
|---|---|
| `applied` | `false` for a dry run |
| `complete` | the run finished. `false` when it stopped at its batch limit or on an error; rerun the same command to continue |
| `clean` | `complete`, and nothing was left: no `mixed` rows, mixed `keptCopies`, `gaps`, `unreadableEvents`, left-over entries, or rig records left or unknown. Only a clean report means the scope is fully erased |
| `error` | why the run stopped (`stage` and `message`). Everything listed in `qitems` was committed before it; the command exits 2 |
| `qitems` | each row erased (or that would be), with its `action` and `state` |
| `mixed` | members scope: rows with one member endpoint, left untouched |
| `keptCopies` | copies of erased rows held with someone else, kept: `table`, `id`, `qitemId`, `ownership` (`mixed` or `foreign`) |
| `gaps` | rows not erased and why: `workflow-reference`; `not-found` for an id to scrub that doesn't exist; `changed-during-run` for a row that no longer qualified when its batch ran (reopened, or written to so it left its window) |
| `alreadyAbsent` | ids to delete with no row; their erased-id record is written (again), and they're listed once it's committed |
| `unreadableEvents` | events naming an erased row whose payload can't be read: `seq` and the row ids found in its text. They're kept, since what they hold can't be inspected, and the run isn't clean |
| `linked` | counts of the copies erased with the rows |
| `unlinked` | members scope: entries and stream items erased that no row owned, plus those left (`mixedEntries`, `referencedStreamItems`) |
| `rig` | members scope with `--rig`: `found`, `verified`, records erased per table (`erased`, counted as each chunk commits), records left (`left`), tables that can't be counted (`unknown`), and `completedAt` once the rig's erasure is complete |

**How a run works:**
- **Selection:** a run selects everything first and writes nothing.
- **Events:** it reads the events table once, in small windows, to find each row's events.
- **Batches:** each batch, of up to 100 rows, is one transaction. It rechecks its rows, writes their ledger lines, then changes their events, copies and rows. The recheck drops a row that a workflow has taken up, and in a routine run one that was reopened or no longer falls in the same window; each dropped row is reported in `gaps`.
- **Stopping:** the daemon is never held for long. A run that stops leaves whole batches done, events included. A rerun picks up the rest, and erasing a row a second time changes nothing.
- **A ledger line without its batch:** if a batch's transaction fails after its lines are written, the ledger lists rows that weren't erased. Replaying it erases rows that qualified at that moment, which the rerun would erase too.

**Refusals**, with nothing erased:

| Code | Cause |
|---|---|
| `erase_scope_required` | no scope named |
| `erase_scope_conflict` | more than one scope |
| `erase_members_invalid` | an empty list, or names with surrounding spaces |
| `erase_rig_invalid` | a rig without `--members`, or an empty rig id |
| `erase_rig_mismatch` | the rig exists, and its sessions and the members don't match both ways |
| `erase_ids_invalid` | an empty ids list, or ids with surrounding spaces |
| `erase_action_invalid` | an action other than `delete` or `scrub` |
| `erase_routine_off` | both windows are `0` |

The command records who ran it from `OPENRIG_SESSION_NAME`, or from `--actor <session>` when that isn't set.

## Restores and backups

A restored database can bring erased content back: rows, copies, rig records and the erased-id records themselves. It can even bring back a row that was still open when the backup was taken and was closed and erased later. Before a restored daemon serves anyone, replay what was erased after the backup was taken:

1. **Keep a ledger.** Set `retention.erasure_ledger` to a file outside the backed-up data. Every applied erasure appends its ids and actions there before committing. That covers the daily windows, `--routine`, `--ids` and account deletion's rows.
2. **Replay the ledger:** `rig queue erase --ids <ledger> --apply`. Each line keeps its own action, so a scrub is replayed as a scrub, never promoted to a deletion. A row that was open in the backup is erased by its id, and other open work isn't touched.
3. **Replay account deletions:** rerun `rig queue erase --members <file> --rig <id> --apply` for each account deleted since the backup, from its membership list and rig id. Keep those outside the backed-up data until every backup taken before the deletion has expired. This also covers the copies and rig records the ledger doesn't list.
4. **Rerun the windows:** `rig queue erase --routine --apply`.

Backup expiry is the deployment's own schedule. Content erased from the live database stays in backups until they expire.

## What this doesn't cover

These stores need their own handling where a deployment uses them:
- terminal transcripts;
- daemon and service logs;
- gateway and Slack stores and Slack's own copies;
- downloaded files and artifacts;
- chat messages (removed with their rig);
- events tied neither to a row nor to the account's rig.

The rig itself (its nodes, sessions and bindings) is removed by removing the rig, between the two runs above.
