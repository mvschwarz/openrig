# Occupant-owned stream classification and shadow capture (experimental)

> **Experimental in 0.6.0, optional and off by default.** The Jev classification path and shadow
> capture may be incomplete or not work, and no accuracy or production-reliability claim is
> made. OpenRig's delivery, watchdog and routing decisions do not use their output. If they do
> not behave as described here, please
> [open an issue](https://github.com/mvschwarz/openrig/issues/new/choose) or send a pull request
> ([CONTRIBUTING.md](../../CONTRIBUTING.md)).

This source provides a bounded receiver for one real classifier occupant. It does
not start an agent, register a watchdog job, or enable capture by default.
Taxonomy, questions and decisions belong to the occupant; the daemon supplies
source facts and enforces its existing lease, execution and idempotency fences.
An explicit optional Jev mode supplies advisory decisions through the same worker.
Experimental labels have no demonstrated accuracy or calibrated confidence and
do not replace delivery, watchdog, or routing decisions.

## Optional foreground Jev experiment

With no configuration, the experiment is off. Choose an explicit local JSON path
in an existing private directory; the file contains only enabled state and bounds:

```sh
rig project experimental status --config ./experiment.json --json
rig project experimental enable --config ./experiment.json --max-requests 3 --timeout-ms 10000 --json
rig project experimental disable --config ./experiment.json --json
```

Enable does not start processing, capture, a daemon or an agent. Status and disable
make no provider request. The invoking process needs `OPENROUTER_API_KEY` in its
environment for an enabled run; this entry never searches credential files or
copies credentials into configuration. Missing credentials fail before attempts
or provider work. Normal key provisioning remains with the operator.

The selected route is `https://openrouter.ai/api/alpha/decisions`, pinned to
`typesafe/jev-1.13`, without provider fallback or HTTP redirects. A request declares
maximum provider prices of $0.05 per million prompt tokens, zero completion and
request price. These are admission ceilings, not a price quote, spend estimate or
credential-access claim. Each foreground run allows 1–20 requests (default 3),
each with a 1–30 second deadline (default 10), 24 KiB request and 256 KiB response
limits. Failed requests consume their count. Nothing retries in the background.

To process stream items from the actual selected occupant:

```sh
rig project wake --project PROJECT --taxonomy ./taxonomy.yaml \
  --classifier-version experimental-jev-1.13 --evidence-epoch OWNER_EPOCH \
  --limit 3 --experiment ./experiment.json --json
```

Use the taxonomy format described below. Each criterion must have a nonempty
string description; `__unknown__` is reserved. Questions stay outside the daemon.
The request sends the selected item's body, supplied taxonomy questions/criteria,
canonical scope IDs and current roster destinations to OpenRouter. Select inputs
appropriate for that external processing. It does not transmit the credential
in evidence or store it in the classification. The output binds current source,
taxonomy, candidate version, lease, occupant generation and attempt execution.
No action or confidence label is inferred. Duplicate judgment remains manual.

The smaller of `--limit` and the configured request maximum bounds the wake.
Unknown answers remain null; a wholly unknown answer abstains. Invalid model,
provider, answer keys, choices, probabilities or response bytes reject the whole
answer. Probability sums retain the strict 0.001 tolerance; there is no rounding
repair or partial salvage. Unavailable/invalid provider work, Ctrl-C or SIGTERM
stops that run with no classification write; the item in hand is recorded as an
abstention, final for that classifier version, taxonomy version and evidence epoch. Inspect the returned attempt state: terminal abstentions
are not reopened, and failed/unknown daemon writes must be reconciled through the
existing ledger. Never change the evidence epoch merely to retry an experiment.

Disable, a changed `--max-requests` or `--timeout-ms`, or an unreadable configuration
is checked before each call and before applying its result, and stops the run. A separate
disable command cannot cancel an already forwarded remote request; its late
result is discarded, with the existing deadline bounding the wait. Ctrl-C or
SIGTERM requests immediate cancellation of the foreground run. An uncooperative
request remains reported pending and cannot cause a late write or a second call
in that run. Remote cancellation or refund is not proven by local cancellation.
The command registers no wake, returns no automatic continuation, and requires
an explicit later invocation to do more work.

For selected observations from an existing shadow archive:

```sh
rig project experimental capture --config ./experiment.json \
  --input ./selected-shadow.jsonl --output ./new-advisory-results.jsonl --json
```

This reads at most 8 MiB and considers only the first configured maximum number
of records. It never captures a terminal. The input remains unchanged; output is
exclusively created at mode 0600. Keep prior output and choose another filename
only for a deliberately selected new run. It sends captured post-screen text to
the same provider, and retains the original attempt/node/occupant/pane binding and
capture hash beside the answer. Missing capture or binding is unavailable and
makes no provider call. State answers are experimental hints; delivery remains
`INDETERMINATE` because screen text cannot prove submitted/consumed/effect and the
archive does not retain the original sent text. No result feeds back into live
transport or inventory. Failed runs preserve already written output; inspect
`unavailable`, `remaining`, call count and stop reason rather than treating a file
as proof of success.

## One bounded wake

From the selected occupant, read candidates using the configured project ID:

```sh
rig project candidates --project PROJECT --taxonomy /private/taxonomy.yaml \
  --classifier-version VERSION --evidence-epoch OWNER_EPOCH --limit 20 --json
```

The result includes eligible stream IDs, authored scope IDs with exact source
paths/hashes, the current running roster of the occupant's rig, observation time,
and a candidate version. Taxonomy YAML supplies `version` and
`fields.{kind,urgency,maturity,area}` with a `question` and `values` mapping. These
questions are returned to the occupant; draft values are not verified truth.
Confidence has no selectable values until calibration selects that contract.
Destination choices are the current roster sessions plus explicit `pool`.
Null/omitted destination remains unknown; it is not converted into `pool`.
The candidate hash binds the selectable values as well as source and taxonomy
hashes. Packets prepared before this pool correction require fresh preparation;
it does not reopen historical attempts or change the evidence epoch.

Read each eligible item with `rig stream show ITEM --json`. Duplicate candidates
are the latest 100 nonarchived items with exact body-hash evidence references;
their preview is capped at 2,000 characters and marked when truncated. Read the
complete candidate before selecting a duplicate. A retrieval miss means unknown.
Directory names, issue IDs and bare membership never supply scope IDs. Source
errors are explicit, and partial source snapshots cause abstention.

Write an occupant-owned decision file (at most 100 unique item IDs, at most 1 MiB):

```json
{
  "candidateSetVersion": "sha256:<version returned by candidates>",
  "decisions": [{
    "streamItemId": "<eligible ID>",
    "bodyHash": "sha256:<SHA256 of the exact UTF-8 item body>",
    "decision": { "kind": "classify", "labels": {
      "classificationType": "<selected taxonomy value>",
      "scopeRef": "<selected canonical mission or slice ID>",
      "needsHuman": null
    }}
  }]
}
```

An explicit abstention is `{"kind":"abstain","reason":"why unknown"}`. Other
label keys are `classificationUrgency`, `classificationMaturity`,
`classificationDestination`, `area`, and `classificationConfidence`. Omitted or
null labels stay unknown. A duplicate needs both `duplicateOfStreamItemId` and
the matching `duplicateEvidenceRef` from the candidates, plus occupant judgment
that it really is a duplicate. An existing item alone is not that judgment.

```sh
rig project wake --project PROJECT --taxonomy /private/taxonomy.yaml \
  --classifier-version VERSION --evidence-epoch OWNER_EPOCH --limit 20 \
  --decisions /private/decisions.json --json
```

This command actually invokes one `StreamClassificationWorker.wake()` through
the existing HTTP services. It derives sender identity through `DaemonClient`,
requires a current running occupant, and carries the captured generation through
each lease/attempt/classification request. It never invents a daemon holder.
Existing direct HTTP callers keep their documented sender-provenance behavior.

The command refreshes source candidates before acquiring a lease. Missing or
stale decision packets return unavailable without starting attempts; refresh
preparation if the roster, scopes, taxonomy or recent stream changed. During a
wake, an item with no exact body-bound decision, missing sources, or a selected
candidate that is unavailable abstains. This is deliberately strict; continuous
source churn can require repeated preparation and is not a throughput claim.

Each wake processes at most `--limit` items (1–100; default 20), starting with the
oldest eligible work rather than relying on a lossy notification cursor. Durable
terminal attempts stay excluded. A new candidate version does **not** authorize
another pass: only a new classifier version, taxonomy version or owner-selected
evidence epoch changes that attempt identity.
Retain the candidates output beside the decisions and result so its version is
reproducible. The CLI does not keep a second local ledger.

The result carries per-item outcomes, `moreEligible`, `nextWakeAt`, and a watchdog
`wakeRequest` descriptor with the real session/generation and a receiving
instruction. `registered:false` is literal. A periodic-reminder message asks the
occupant to prepare and run this entry; delivery of that message is not execution.
Registration/placement remains an explicit later action. Honor `nextWakeAt`:
lease maintenance uses TTL/3 opportunities; lease loss or an unavailable service
backs off 60 seconds. The daemon's retry/exhaustion ledger remains authoritative.
The ordinary client bounds each request at five seconds; a timed-out write has
an unknown outcome until the ledger is read, and is never reported as written.

There is no provider in the manual-decision path. The reusable asynchronous worker has one
pending classifier slot; timeout requests cancellation but cannot force it. An
uncooperative classifier blocks further calls in that instance and late results
cannot write. That in-memory pending slot is not cross-process cancellation.

## Separate bounded shadow drain

The production transport and inventory probes accept the same optional observer.
They record only captures already taken, with the node, occupant, pane and capture
target bound before awaits. The ordinary cheap inventory path still takes no
capture. Retained-no-write is a separate event, never delivery evidence.

Activation requires explicitly supplied `OPENRIG_SHADOW_CAPTURE` JSON at a later
authorized daemon start. Absence or invalid configuration leaves capture disabled.
Daemon start checks only that `destination` is an absolute normalized path and the
numeric ceilings; the private-directory checks and exclusive file creation happen
at the first drain, and a failure there stops the sink.
This document supplies no live destination or activation instruction. Required
fields and engineering ceilings are:

| Field | Meaning | Maximum |
|---|---|---|
| `destination` | New absolute JSONL file in a canonical, current-user-owned 0700 directory | Explicit path |
| `maxRecords` | Total reserved sink records | 100,000 |
| `maxBytes` | Total reserved sink bytes, including newlines | 1 GiB |
| `capacity` | Queued observation count | 1,000 |
| `maxQueuedBytes` | Serialized bytes waiting in the queue | 8 MiB |
| `maxObservationBytes` | Serialized bytes per observation | 1 MiB |

All numeric fields are required positive safe integers. These are engineering
capacity limits, not approved corpus sizes or classification thresholds. One
in-flight drain can hold up to 64 additional observations, bounded by the queue's
byte allowance; queue plus drain can therefore retain up to twice that allowance.
The standalone observer defaults are 256 entries, 4 MiB queued and 256 KiB per
observation; explicit production configuration supplies each value.

`rig project shadow-status` only inspects configuration/counters.
`rig project shadow-drain` asks the existing HTTP service to drain up to 64 rows;
it requires an actor (outside a managed seat, name one with `--actor <name>`)
and never enables capture. No background drain timer is added.
`rig project shadow-stop` (which needs an actor the same way) disables new enqueueing immediately, finishes any active
drain and the finite retained queue, then closes the sink. Repeated stop is
idempotent; it cannot enable capture or delete the existing archive. Existing
quota and sink-failure losses remain counted. A slow disk can leave stop pending;
inspect status after a client timeout instead of assuming the flush completed.
Enabling capture again requires a separately authorized daemon start with a new
destination; enabling the local provider experiment does not enable capture.
The file is exclusively created with mode 0600. An existing file is refused,
never overwritten, appended, rotated or deleted. A restart requires a new selected
destination. Private-file creation currently requires POSIX ownership support.

The hot path only performs bounded synchronous enqueue work; it never awaits disk
or drain completion. Slow sinks leave one drain pending; concurrent drains do not
start another writer. Overflow drops new observations. Capacity exhaustion stops
the sink. Errors stop writes, count losses and preserve any partial file; failed
batches are not replayed. `reservedRecords/Bytes` include attempted writes, while
`completedRecords/Bytes` count successful appends. `drained` means removed from
the observer, not necessarily persisted. Queue drops (count-bound and byte-bound
together in `dropped`; `droppedBytes` adds the bytes of byte-bound drops), record
errors, missing/unavailable captures and sink failures remain separate.

Live collection, private destination/retention selection, corpus labels, hosted
calibration, native placement, package/install proof and independent visible /
submitted / consumed / effect evidence remain outside this source entry.
