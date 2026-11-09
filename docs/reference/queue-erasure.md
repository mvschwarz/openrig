# Queue erasure: closed-work retention and account deletion

A daemon that serves several accounts sometimes needs to remove queue content for good: closed work after its retention window, or everything that belongs to an account when the account is deleted. `rig queue erase` and two retention settings do that.

Erasure can't be undone. Run every scope as a dry run first, without `--apply`. The dry run prints exactly what `--apply` would erase and changes nothing.

## What is erased

A queue row is erased in one of two ways:

- **Scrub.** The row's content is removed: body, summary, resolution, tags, blocker text, chain of record, evidence reference, human detail, questions and answers, and delegated decision. The row itself stays, with its id, endpoints, state and times, marked `contentErasedAt`. A retried create with the same id still finds the row, so it makes no new work.
- **Delete.** The row and everything linked to it are removed. Only its id is kept, in an erased-id record with no endpoints and no content. A later create that reuses the id is refused with `qitem_erased` (409), so a retried or forwarded create can't bring the work back.

Either way, the row's copies go with it:
- its transitions, live and archived (their notes and recorded principals);
- the outbox entries that point at it or wake for it;
- the inbox entry it was absorbed from;
- stream dispositions and reader actions that name it;
- events whose payload names it;
- its mission-control audit rows.

A scrubbed event keeps its type and row id, and loses its summary, reason and error text.

**A row a workflow still references is never erased.** That covers a step trail, a frontier binding, a failure record, or a live instance's frontier. It's reported under `gaps` with the code `workflow-reference`.

## Scopes

Name exactly one.

| Scope | Erases | Action |
|---|---|---|
| `--members <file>` | Account deletion. Every row whose source and destination are both in the file, in any state, open work included. Add `--rig <id>` for the account rig's own records | delete |
| `--ids <file>` | Exactly the listed rows. A JSON array of a report's `qitems` entries keeps each entry's action | `--action delete` (default for plain ids) or `--action scrub` |
| `--routine` | Closed rows past this daemon's retention windows (below) | scrub, then delete |

A file is one entry per line (blank lines and `#` comments are skipped) or a JSON array.

**Account deletion is exact.**
- The members file is the account's recorded membership: the exact session names of its seats, including departed ones. Names are compared as given, never by pattern.
- **Mixed rows:** a row with exactly one member endpoint is reported under `mixed` (with which endpoint is the member) and left untouched. Deciding who owns it is a separate decision.
- **After the rows:** account deletion also removes outbox and inbox entries between two members that no row owns, and the members' stream items. An entry with one member endpoint, or a stream item something still references, is counted and left.

**The account's rig.** A rig's own records outlive the rig. Events are kept past rig and node deletion by design, and snapshots, node and seat records and watchdog jobs have no key that cascades. `--rig <id>`, given with `--members`, erases them:
- the rig's events, including those of its nodes;
- snapshots, operation correlations and bootstrap runs;
- seat identity verdicts, delivery-guard changes, environment bindings and usage records for its nodes and member sessions;
- watchdog jobs aimed at a member, with their history;
- stream subscriptions and thread maps of member sessions.

Records that name the account but also belong elsewhere are counted under `rig.left` and kept. These are a member's watchdog job aimed outside the account, a workflow instance or spec bound to the rig, classifier leases and custom views.
- **While the rig exists,** every member must be one of its sessions, or the run is refused (`erase_rig_mismatch`).
- **Once the rig is removed,** the same command erases what's left under the rig's id (`rig.found: false`). This includes the events the removal itself wrote.

**Retention windows** (`rig config set …`, read at the daily sweep and at daemon start):

| Setting | Default | Effect |
|---|---|---|
| `retention.closed_content_days` | `0` (off) | Scrub closed rows this many days after they closed |
| `retention.closed_metadata_days` | `0` (off) | Delete closed rows, keeping only their ids, this many days after they closed |

- **Closed** means `done`, `canceled`, `denied` or `handed-off`. `failed` and open work are never touched by the windows.
- **Age:** a row's age counts from when it entered its final closed state. A note on a closed row doesn't restart it, and a row reopened and closed again counts from its latest close.
- **Running them now:** `rig queue erase --routine --apply` runs the windows immediately. `retention.enabled false` turns off the whole sweep, these windows included.

## Account deletion, in order

1. Revoke the account's access.
2. Keep its exact membership list and rig id.
3. Run `rig queue erase --members <file> --rig <id>` as a dry run, then with `--apply`. Rerun until `complete` is true.
4. Remove the rig.
5. Rerun the same command with `--apply`, to erase the records the removal wrote.
6. The account is deleted only when the report's `clean` is true. Otherwise its `mixed`, `gaps`, `unlinked` and `rig.left` entries need a decision. Rerunning won't resolve them.

## Output

The command prints one JSON report (`--json` makes it a single line):

| Field | Meaning |
|---|---|
| `applied` | `false` for a dry run |
| `complete` | the scan finished. `false` when the run stopped at its batch limit; rerun the same command to continue |
| `clean` | `complete`, and nothing was left: no `mixed` rows, `gaps`, or left-over entries or rig records. Only a clean report means the scope is fully erased |
| `qitems` | each row erased (or that would be), with its `action` and `state` |
| `mixed` | members scope: rows with one member endpoint, left untouched |
| `gaps` | rows not erased and why: `workflow-reference`, or `not-found` for an id to scrub that doesn't exist |
| `alreadyAbsent` | ids scope with delete: ids with no row; their erased-id record is written (again) |
| `linked` | counts of the copies erased with the rows |
| `unlinked` | members scope: entries and stream items erased that no row owned, plus those left (`mixedEntries`, `referencedStreamItems`) |
| `rig` | members scope with `--rig`: `found`, records erased per table (`erased`), records left per table (`left`) |

Each batch of rows is one transaction, so a run that stops leaves whole rows done. A rerun picks up the rest, and erasing a row a second time changes nothing.

**Refusals**, with nothing erased:

| Code | Cause |
|---|---|
| `erase_scope_required` | no scope named |
| `erase_scope_conflict` | more than one scope |
| `erase_members_invalid` | an empty list, or names with surrounding spaces |
| `erase_rig_invalid` | a rig without `--members`, or an empty rig id |
| `erase_rig_mismatch` | the rig exists and some members aren't its sessions |
| `erase_ids_invalid` | an empty ids list, or ids with surrounding spaces |
| `erase_action_invalid` | an action other than `delete` or `scrub` |
| `erase_routine_off` | both windows are `0` |

The command records who ran it from `OPENRIG_SESSION_NAME`, or from `--actor <session>` when that isn't set.

## Restores and backups

A restored database can bring erased content back: rows, unlinked entries, rig records and the erased-id records themselves. Before a restored daemon serves anyone, replay what was erased after the backup was taken:

1. **Account deletions:** rerun `rig queue erase --members <file> --rig <id> --apply` for each account deleted since the backup. This needs the membership list and rig id. Keep them, outside the backed-up data, until every backup taken before the deletion has expired; after that no restore can bring the account back, so they can be dropped.
2. **Explicit id runs:** keep each applied report's `qitems` entries, which are ids with their action and no content, outside the backed-up data. Replay them with `rig queue erase --ids <ledger.json> --apply`. Each entry keeps its own action, so a scrub is replayed as a scrub, never promoted to a deletion. Ids under `alreadyAbsent` replay as plain deletes.
3. **Routine windows:** run `rig queue erase --routine --apply`. The windows are recomputed from each row's age, so routine erasures need no ledger.

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
