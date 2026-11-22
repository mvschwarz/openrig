# Queue transfer staging (proposed)

An [exported queue archive](queue-transfer-export.md) can be checked and stored on a destination without moving any work. This is the inactive import in [#3094](https://github.com/mvschwarz/openrig/issues/3094). It does not stop or relinquish work at the source, and nothing in the archive can run at the destination, even after a daemon restart.

## Review, then stage

Run the proposed commands on the destination. Use the same `OPENRIG_HOME` and, if set, `OPENRIG_DB` as its daemon. The database must already have the staging migration; the commands don't start a daemon or migrate its database.

```sh
rig queue import workshop.queue.json --dry-run
rig queue import workshop.queue.json
rig queue staging list
rig queue staging discard <importId>
```

Both import forms check the format, digest, shown selection and destination conflicts. The dry run opens the existing database read-only and prints a JSON review to stdout. Redirect it to keep it. Import without `--dry-run` keeps the original envelope and its manifest in one database transaction. The manifest names the digest, origin, shown selection, row count and status. It does not make live queue items, transitions, delivery intents, ownership records or fences.

No authorization is needed. A valid review reports `not_ready_for_activation` and `destination_unbound`; this is not a failure. The archive itself never names a destination or embeds authorization. The review lists open, terminal and erased rows separately and shows which pending or in-progress items could be runnable under the current, unchanged local addresses. That is a preview, not a readiness guarantee or a request to dispatch. Blocked items stay out of that list.

## Read the report

| Finding | Meaning |
|---|---|
| `format_unsupported`, `digest_mismatch`, `origin_identity_missing`, `selection_not_shown` | Wrong format major, different content, missing origin identity, or no matching shown selection. |
| `archive_invalid`, `archive_too_large` | Invalid envelope, or a file beyond the configured limit. The default is 16 MiB; proposed `--max-bytes <n>` changes it. Raising the limit increases memory use. |
| `qitem_id_collision`, `workspace_has_unrelated_conflict` | An ID belongs to destination work already, or a mission-control action ID collides. Nothing is replaced. |
| `qitem_erased_at_destination` | The destination already recorded an erasure for this ID. |
| `unresolved_rig`, `unresolved_seat` | A named rig or seat could not be shown locally without mapping. The report leaves the address as written. |
| `missing_evidence`, `dangling_reference` | A referenced file could not be shown under local shared roots, or the work it refers to isn't in the archive or known locally. Nothing is fetched or copied. |

Refusals exit nonzero and do not keep an envelope. Warnings do not prevent staging. Evidence checks use the local shell's `OPENRIG_FILES_ALLOWLIST`; links and relative paths without a root are not verified. Review does not compare to the current source, discover later reports, validate a receipt or check a proposed seat mapping. Those require the later transfer steps.

## Keep only what you need

An identical content key (origin host ID, origin minted-at value and digest) returns the original manifest. `staging list` prints manifests, not archive bodies. Discard removes the stored envelope and marks the manifest `discarded`; importing identical content again returns that manifest without restoring the envelope. Discard writes no fence and does not remove the original file or older backups. It is not a secure erase of SQLite pages or journal files.

Treat the archive, database and report as sensitive. The format is not encrypted, and an older archive can contain content erased at the source later. Keep the copies only as long as needed. Activation and reconciliation are not available through these commands.
