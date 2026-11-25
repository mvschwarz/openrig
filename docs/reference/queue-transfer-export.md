# Queue transfer export (proposed)

This is the source-side archive for [#3094](https://github.com/mvschwarz/openrig/issues/3094). It takes a point-in-time copy of selected queue work. It does not move that work: claims and dispatch continue as before, and reports recorded later do not appear in an earlier archive. Export neither reserves a destination nor requires transfer authorization.

## Select work on the source

The following command and flags are proposed. Run on the source host, with access to its local database. Name exactly one scope:

| Scope | Selects |
|---|---|
| `--whole-host` | The entire local queue and all erased ID and rig receipts; this flag takes no host argument. |
| `--rig <name...>` | Rows whose source or destination names one of these local rigs, including addresses qualified with the source's own host ID. Pass unqualified rig names. Named rig erasure receipts are included. |
| `--mission <id...>` | Rows with any exact `mission:<id>` tag. |
| `--slice <id...>` | Rows with any exact `slice:<id>` tag. |
| `--qitems <id...>` | Exactly these rows or their erased-ID receipts. If only some requested IDs match, the export refuses rather than returning a partial selection. |

Scopes include closed work. A scope that matches neither rows nor receipts warns on standard error and produces a valid empty archive. References to other work are left as written; they do not pull more rows into the selection. Mission and slice exports include erasure receipts for selected IDs and local rigs named by selected endpoints. A deleted ID with no remaining row has no tags to match: use `--qitems` to select it by ID or `--whole-host` to include all receipts.

```sh
rig queue export --rig workshop --preview
rig queue export --rig workshop --out workshop.queue.json
```

`--preview` prints the full unfrozen archive to standard output and reports `not_ready_for_activation` on standard error. `--out` writes a new private file without overwriting an existing one, then prints the selection and history counts on standard error. A later run reads a new snapshot. This is not the destination dry run, and it does not validate destination routes or conflicts.

The command opens the source database read-only. Set `OPENRIG_HOME` (and `OPENRIG_DB` if the daemon uses an override) to the same location the source uses. It refuses with `origin_identity_missing` when the store has no reconciled self-host identity. If the archive would exceed the limit (16 MiB by default, configurable with `--max-bytes <n>`), it refuses with `archive_too_large` and names the limit in bytes. Raising the limit can increase memory use. It never truncates a file to fit.

## What the archive contains

`openrig.queue-transfer/v2` holds the selected rows, including bodies, answers, lineage, return routes, claims and delivery facts. It includes both live and archived transition history, transition wake evidence and mission-control audit history, with source IDs, actors, provenance and notification facts. It preserves addresses verbatim. Wake and notification history is not an instruction to send anything. A scrubbed row keeps its marker without its scrubbed content. The archive does not contain pending delivery intents, inbox entries, native sessions, transcripts, workspace files, evidence bytes, rig specs or fleet state.

The origin identity is `(hostId, mintedAt)`. There is no `origin.generation`: the numeric host counter shown in the v3 archive and receipt examples is not a source identity field. Activation ordering and the receipt format belong to later work.

`origin.openrigVersion` is the version bundled with the exporting CLI; it can differ from the running daemon's version. `origin.schemaMigration` records the source database's schema migration.

The file uses compact UTF-8 JSON with keys in UTF-16 code-unit order. Rows are sorted by queue ID and transitions by timestamp then original transition ID. `digest.value` is lowercase SHA-256 hex over that canonical JSON with the top-level `digest` removed; `digest.coverage` names the format. Re-serializing the same archive reproduces its digest. A new export has a new ID and timestamp and need not have the same digest. The hash checks content; it is not authorization or a signature.

Treat the archive and preview output like the database: neither is encrypted, and a file can retain content scrubbed from the source later. Keep it only as long as needed, and use your own secure channel to move it. Staging, activation, fencing and reconciliation are not part of this command.
