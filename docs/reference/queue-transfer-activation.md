# Queue transfer activation (proposed)

A [staged queue import](queue-transfer-staging.md) can be made runnable on a destination once the source has given the work up. This is the active transfer in [#3094](https://github.com/mvschwarz/openrig/issues/3094): contract §2.1 steps 5-9. Until `activate` runs, a staged archive changes nothing at the destination and restricts nothing at the source.

## Sequence

Outside a managed seat, supply `--actor <name>` to each write command, including `activate` and `reconcile`; it does not carry over from earlier commands.

```sh
# destination
rig queue import workshop.queue.json
rig queue transfer authorize <importId> --map <from>=<to> --intervention-kind online-handshake --actor <name> --intervention <text> --out authorization.json
# source (add --host <registered host> to reach a remote source)
rig queue transfer relinquish --archive workshop.queue.json --authorization authorization.json --intervention <text> --actor <name> --out receipt.json
# destination
rig queue transfer activate <importId> --authorization authorization.json --receipt receipt.json --out activation.json
# source
rig queue transfer reconcile --archive workshop.queue.json --receipt activation.json --out reconciliation.json
# either host
rig queue transfer status --archive workshop.queue.json
```

The order matters. An authorization binds the digest of the staged archive to one destination host. The source issues a receipt only for an authorization that names its own identity, its own current copy of the archive and another host as the destination. Activation requires both records. The source is therefore restricted before the destination becomes runnable, whichever host's operator runs first.

| Command | Runs against | Writes |
|---|---|---|
| `authorize <importId>` | destination daemon (reads the staging manifest) | a file only |
| `relinquish` | source daemon | ledger, fence, a receipt file |
| `attest` | no daemon | a receipt file |
| `activate <importId>` | destination daemon | live queue rows, a result file |
| `reconcile` | source daemon | ledger, a report file |
| `replay <file>` | either daemon | fence rows only, on the origin |
| `status` | either daemon | nothing |

`authorize`, `attest` and `activate` take no `--host`: they run against the destination's daemon. `relinquish`, `reconcile`, `replay` and `status` accept `--host <registered host>`, which calls that host's daemon directly with its registered bearer, as the other queue verbs do. No verb chooses a host on its own.

An unreachable source replaces `relinquish` with `attest`, and `--intervention-kind operator-attestation` on `authorize`. The attestation says the source was isolated by the operator; its receipt reports the source's workflow state as unknown, because nothing could read it. Such a transfer cannot be reconciled afterwards: `reconcile` accepts only the result of an online handshake.

## Records

Each record is canonical JSON in a new file with mode `0600`. An existing path is never replaced.

| Record | Kind | Carries |
|---|---|---|
| authorization | `openrig.queue-transfer.authorization/v1` | archive digest, origin, destination host, seat mapping, the planned intervention, optional per-item dispositions |
| receipt | `openrig.queue-transfer.receipt/v1` | transfer id, archive and authorization digests, origin, destination, source state and method, the rows digest |
| activation result | `openrig.queue-transfer.activation/v1` | operation id, import id, what was created, projected, left blocked or remapped, imported history counts, warnings |
| reconciliation | `openrig.queue-transfer.reconciliation/v1` | one outcome per archived item and the evacuation flag |

The database holds the same JSON in a transfer ledger, so a repeated call returns the recorded result with `replayed: true` instead of repeating the write. The files are what survives a restore: no daemon looks for them at startup, and after a restore the operator runs `replay` with the file.

## The source fence

`relinquish` re-reads the archived items. If any differs from the archive, or no longer exists, it refuses with `archive_stale` and writes nothing; export, import and authorize again. On success each archived item is fenced with one transition. A fenced item cannot be claimed, unclaimed, handed off or moved back to an open state; the daemon answers `409 qitem_fenced`. A late report that closes the item is still recorded. Its state and claim stay as history. Wake delivery leaves a fenced item alone; the stuck sweep does not read the fence.

The fence restricts daemon dispatch only. Work already running at the source has to be stopped by the operator, which is what `--intervention` records.

## Activation

`activate` checks the staged digest, the authorization, the receipt and the destination's readiness before writing anything. `--dry-run` runs every check and reports `ready_for_activation`. A pending or in-progress item whose destination does not resolve locally after `--map` refuses the whole archive with `mapping_incomplete`.

| Source state | Destination state |
|---|---|
| `pending` | `pending`, with a wake intent |
| `in-progress` | `pending`, unclaimed, the body prefixed with an instruction to reconcile partial work at the origin |
| `blocked` | `blocked`, its source continuation kept current |
| terminal | the same state |

Source transitions and mission-control actions are imported as the item's history and marked as imported: they are not destination activity, and no imported action is notified. Source wake evidence is copied onto the imported transitions without an imported marker, so this release does not guarantee that it stays inert; treat it as a known limit. Each item gets the tag `transferred:<operationId>`.

Activation is two commits. A crash between them leaves an `activating` ledger row and the staged manifest; the same call again resumes it. A crash after both is an exact retry.

## Reconciliation

`reconcile` takes the activation result, not the receipt, as `--receipt`, and accepts only the result of an online handshake. An item whose source columns still equal the archive, and which the destination lists as created, closes as `superseded` with a cross-host successor. An item whose columns differ from the archive in any way is reported as a `late_report` and left alone, whether it changed before or after the fence. The fence stays on every item, so nothing transferred can be reopened at the source.

`status` reports, per transfer, whether the source has a record of the intervention, whether a destination result was verified, how the source reconciliation ended, which items are still fenced, and `evacuation: complete` or `incomplete`. An empty ledger reports `recordsUnavailable`; it does not say no transfer happened.

## Limits

- No failover, heartbeat detection, replication or automatic routing between hosts.
- Receipts are not signed. A file can be edited; the digests tie records to each other, not to an identity.
- Workspace and transcript contents are not transferred.
- `rig queue import` stays stage-only. Discard a stage before activation with `rig queue staging discard`.
- The staged envelope stays in the destination database after activation, so the database remains sensitive for as long as it is kept.
