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

**Copies held with someone else go only when they're the owner's.** These are outbox and inbox entries that point at the row or wake for it, and stream reader actions and dispositions that name it (including `duplicate_of`). For account deletion, the owner is the account: both of a copy's sessions must be members. Otherwise the owner is the row's own source and destination. OpenRig's own sessions (`daemon@kernel`, and any session starting `system:`), which send its wakes and notices, aren't counted when a copy has another session, so OpenRig's wake to the owner is the owner's. Any other copy is kept and listed under `keptCopies`:
- `mixed`: one of its sessions is the owner's;
- `foreign`: none of them are.

**A row a workflow still references is never erased.** That covers a step trail, a frontier binding, a failure record, or a live instance's frontier. It's reported under `gaps` with the code `workflow-reference`.

## Scopes

Name exactly one.

| Scope | Erases | Action |
|---|---|---|
| `--members <file>` | Account deletion. Every row whose source and destination are both in the file, or one in the file and the other OpenRig's own session, in any state, open work included. Add `--rig <id>` for the account rig's own records | delete |
| `--ids <file>` | Exactly the listed rows. A report's `qitems` entries, or a ledger's lines, keep each entry's own action. A ledger's entries are replayed only for the batches that committed (below) | `--action delete` (default for plain ids) or `--action scrub` |
| `--routine` | Closed rows past this daemon's retention windows (below) | scrub, then delete |

A file is one entry per line (blank lines and `#` comments are skipped; a line starting with `{` is a JSON entry) or a JSON array.

**Account deletion is exact.**
- The members file is the account's recorded membership: the exact session names of its seats, including departed ones. List every address form the account used, such as a host-suffixed form. Names are compared as given, never by pattern, so a row addressed through an unlisted form is neither erased nor reported.
- **OpenRig's own sessions:** `daemon@kernel` and any `system:` session send OpenRig's own wakes and notices, such as the wake for a sweep finding, a wake escalation or a health finding. They belong to no account, so a row or entry between one of them and a member is the member's and is erased. One with no member endpoint, such as an OpenRig wake to another account's seat or an entry between two of OpenRig's own sessions, is never touched.
- **Mixed rows:** a row with one member endpoint and the other outside the account is reported under `mixed` (with which endpoint is the member) and left untouched. Deciding who owns it is a separate decision. A row rerouted out of the account while the run is under way (by a fallback, say) is kept too, and reported as `changed-during-run`.
- **After the rows:** account deletion also removes outbox and inbox entries that no row owns between two members, or between a member and OpenRig's own session, and the members' stream items. An entry with one member endpoint and the other outside the account, or a stream item something still references, is counted and left.
- **Runs on earlier versions** kept OpenRig's wake for a row they erased (as a mixed copy, then a mixed entry) and reported OpenRig's rows to a member as mixed. Rerunning the same command removes them.

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
- **When nothing of the rig is left,** the record becomes a completion receipt: the rig's name is cleared, and its id, the membership digest and the time stay. An identical rerun, after a lost response say, still verifies and reports the same clean result, with `rig.completedAt`. The receipt is kept for good. It holds no content.
- **A removed rig's id that was never verified** with this membership erases nothing keyed by it. Those records are counted under `rig.left`, the name-bound tables are listed under `rig.unknown`, and the run isn't clean.

**Retention windows** (`rig config set …`, read at the daily sweep and at daemon start):

| Setting | Default | Effect |
|---|---|---|
| `retention.closed_content_days` | `0` (off) | Scrub closed rows this many days after they closed |
| `retention.closed_metadata_days` | `0` (off) | Delete closed rows, keeping only their ids, this many days after they closed |
| `retention.erasure_ledger` | empty (none) | An absolute file path, on local disk, since each batch appends to it while it holds the daemon. Every applied erasure, by the sweep or the command, appends each row's id, action and batch id there, one JSON line each, before anything in its batch changes, then a commit line once the batch commits (an abort line if it rolls back). A path that can't be written stops the run before it changes anything |

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
| `clean` | `complete`, and nothing was left: no `mixed` rows, mixed `keptCopies`, `gaps`, `unreadableEvents`, left-over entries, or rig records left or unknown. Only a clean report means the scope is fully erased. It's about this run's scope: a routine or members run's `clean` isn't affected by the ledger's other batches, and only a replay (`--ids` with a ledger) reports a batch it can't show committed, as the gap `ledger-unresolved` |
| `error` | why the run stopped (`stage` and `message`). Everything listed in `qitems` was committed before it; the command exits 2 |
| `qitems` | each row erased (or that would be), with its `action` and `state` |
| `mixed` | members scope: rows with one member endpoint and the other outside the account, left untouched |
| `keptCopies` | copies of erased rows held with someone else, kept: `table`, `id`, `qitemId`, `ownership` (`mixed` or `foreign`) |
| `gaps` | rows not erased and why: `workflow-reference`; `not-found` for an id to scrub that doesn't exist; `changed-during-run` for a row that no longer qualified when its batch ran (reopened, rerouted out of the account, or written to so it left its window) or an absent id created since selection; `unreadable-event` for a row an unreadable event names; `ledger-unresolved` for a replayed entry whose batch can't be shown to have committed |
| `skipped` | ids scope, a ledger replay: entries whose batch rolled back, with the batch id; not replayed |
| `ledger` | an applied run with a ledger: batches whose missing commit line it wrote from the database's record (`reconciled`) |
| `alreadyAbsent` | ids to delete with no row; their erased-id record is written (again), and they're listed once it's committed. They're rechecked as the record is written, so an id created during the run is reported as `changed-during-run` instead |
| `unreadableEvents` | events naming a selected row whose payload can't be read: `seq` and the row ids found in its text. They're kept, since what they hold can't be inspected, and so are the rows they name, so every rerun reports them again until the event is repaired or removed. The run isn't clean |
| `linked` | counts of the copies erased with the rows |
| `unlinked` | members scope: entries and stream items erased that no row owned, plus those left (`mixedEntries`, `referencedStreamItems`) |
| `rig` | members scope with `--rig`: `found`, `verified`, records erased per table (`erased`, counted as each chunk commits), records left (`left`), tables that can't be counted (`unknown`), and `completedAt` once the rig's erasure is complete |

**How a run works:**
- **Selection:** a run selects everything first and writes nothing.
- **Events:** it reads the events table once, in small windows, to find each row's events.
- **Batches:** each batch, of up to 100 rows, is one transaction. It rechecks its rows, writes their ledger lines, then changes their events, copies and rows.
  - **The recheck drops** a row that a workflow has taken up, or that an unreadable event names. For account deletion, it also drops a row that is no longer between two members. For a routine run, it drops one that was reopened or no longer falls in the same window.
  - **Each dropped row** is reported in `gaps`.
  - **The current endpoints** decide whose its copies are.
- **How long it holds the daemon:** the batch caps rows, not events or copies, so a row with many of either makes its batch longer. On a copy of a store with 2.4 million events, the longest single hold in a first routine run was about 0.25 s. With a ledger, a run doesn't read the ledger file: it reads the end of the file (one byte) and the database's record of batches still missing a commit line, so the ledger's size doesn't add to the hold.
- **Stopping:** a run that stops leaves whole batches done, events included. A rerun picks up the rest, and erasing a row a second time changes nothing.
- **Ledger lines and commits:** a batch's lines are written before its first change, so they can name rows that a rolled-back batch never erased. Each batch therefore also records its id in the database, in its own transaction, and appends a commit line (`{"batch": …, "committed": true}`) after it commits, or an abort line (`"committed": false`) when it rolls back.
  - **A missing commit line:** a run that can't write one stops once the committed batch is reported. The database's record notes when each batch's commit line was written. Each applied run with a ledger writes the commit line for any recorded batch still without one, from the record alone, without reading the ledger file. It lists those under `ledger.reconciled`.
  - **Neither line nor record:** a batch with neither, such as one whose transaction was cut off by a crash, is never decided from the database: on a restored database, a batch committed after the backup looks exactly like one that rolled back. A replay reports its entries as `ledger-unresolved` and doesn't apply them, until an operator resolves it by appending its commit or abort line once they know which.
  - **A line cut short:** a full disk, say, can cut a line short. Each run starts the ledger on a fresh line first, so the cut line can't fuse with the next one. A replay refuses the file until that line is deleted. That's safe: an entry line's batch rolled back when its write failed, and a commit line is written again from the record.

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

1. **Keep a ledger.** Set `retention.erasure_ledger` to a file outside the backed-up data. Every applied erasure appends its ids, actions and batch there before changing anything, and a commit line once the batch commits. That covers the daily windows, `--routine`, `--ids` and account deletion's rows.
2. **Replay the ledger:** `rig queue erase --ids <ledger> --apply`. It replays exactly the batches that committed, each line with its own action, so a scrub is replayed as a scrub, never promoted to a deletion.
   - **What's replayed:** a row that was open in the backup and erased later is erased by its id, and other open work isn't touched.
   - **What's skipped:** a batch with an abort line was never erased, and is listed under `skipped`.
   - **What's left:** a batch with neither line, which the restored database doesn't record either, is reported as `ledger-unresolved` and not replayed. The run isn't clean until an operator decides it.
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
