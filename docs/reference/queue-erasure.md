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
| `--members <file>` | Account deletion. Every row whose source and destination are both in the file, in any state, open work included | delete |
| `--ids <file>` | Exactly the listed rows. Use this to reapply a ledger after a restore | `--action delete` (default) or `--action scrub` |
| `--routine` | Closed rows past this daemon's retention windows (below) | scrub, then delete |

A file is one entry per line (blank lines and `#` comments are skipped) or a JSON array of strings.

**Account deletion is exact.**
- The members file is the account's recorded membership: the exact session names of its seats, including departed ones. Names are compared as given, never by pattern.
- **Mixed rows:** a row with exactly one member endpoint is reported under `mixed` (with which endpoint is the member) and left untouched. Deciding who owns it is a separate decision.
- **After the rows:** account deletion also removes outbox and inbox entries between two members that no row owns, and the members' stream items. An entry with one member endpoint, or a stream item something still references, is counted and left.

**Retention windows** (`rig config set …`, read at the daily sweep and at daemon start):

| Setting | Default | Effect |
|---|---|---|
| `retention.closed_content_days` | `0` (off) | Scrub closed rows this many days after they closed |
| `retention.closed_metadata_days` | `0` (off) | Delete closed rows, keeping only their ids, this many days after they closed |

- **Closed** means `done`, `canceled`, `denied` or `handed-off`. `failed` and open work are never touched by the windows.
- **Age:** a row's age counts from when it entered its final closed state. A note on a closed row doesn't restart it, and a row reopened and closed again counts from its latest close.
- **Running them now:** `rig queue erase --routine --apply` runs the windows immediately. `retention.enabled false` turns off the whole sweep, these windows included.

## Output

The command prints one JSON report (`--json` makes it a single line):

| Field | Meaning |
|---|---|
| `applied` | `false` for a dry run |
| `complete` | `false` when the run stopped at its batch limit; rerun the same command to continue |
| `qitems` | each row erased (or that would be), with its `action` and `state` |
| `mixed` | members scope: rows with one member endpoint, left untouched |
| `gaps` | rows not erased and why: `workflow-reference`, or `not-found` for an id to scrub that doesn't exist |
| `alreadyAbsent` | ids scope with delete: ids with no row; their erased-id record is written (again) |
| `linked` | counts of the copies erased with the rows |
| `unlinked` | members scope: entries and stream items erased that no row owned, plus those left (`mixedEntries`, `referencedStreamItems`) |

Each batch of rows is one transaction, so a run that stops leaves whole rows done. A rerun picks up the rest, and erasing a row a second time changes nothing.

**Refusals**, with nothing erased:

| Code | Cause |
|---|---|
| `erase_scope_required` | no scope named |
| `erase_scope_conflict` | more than one scope |
| `erase_members_invalid` | an empty list, or names with surrounding spaces |
| `erase_ids_invalid` | an empty ids list, or ids with surrounding spaces |
| `erase_action_invalid` | an action other than `delete` or `scrub` |
| `erase_routine_off` | both windows are `0` |

The command records who ran it from `OPENRIG_SESSION_NAME`, or from `--actor <session>` when that isn't set.

## Restores and backups

A restored database can bring erased rows back, and with them their ids. Before a restored daemon serves anyone:

1. Keep a ledger of every applied run's erased ids, outside the backed-up data. The `qitems` and `alreadyAbsent` ids in the report are what to keep. They carry no content.
2. After a restore, reapply it with `rig queue erase --ids <ledger ids> --apply`. It deletes the restored rows again and writes back their erased-id records.
3. Run `rig queue erase --routine --apply` too, so restored closed work past its windows is erased before the daemon serves.

Backup expiry is the deployment's own schedule. Content erased from the live database stays in backups until they expire.

## What this doesn't cover

These stores need their own handling where a deployment uses them:
- terminal transcripts;
- daemon and service logs;
- gateway and Slack stores and Slack's own copies;
- downloaded files and artifacts;
- chat messages (removed with their rig);
- events not tied to a row.

Removing the account's rig is a separate, last step, after erasure. The rig's membership is what scopes the erasure.
