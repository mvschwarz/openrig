# Apprentice-Successor Seat Cutover SOP

Status: operator-proven on 2026-08-28; curated on 2026-08-30 with the physical-seat correction

Use this runbook after an apprentice successor has completed its install, observation,
and acceptance gates and the authorized decision-maker has explicitly called the
cutover. It covers the mechanical transition from the temporary successor seat to a
stable desk seat while preserving the incumbent as wakeable memory.

This SOP does not decide whether a successor is ready. The desk, owner, or other
named authority owns that judgment. The operator owns the mechanics and proof.

## Required Inputs

Record these on one durable operator baton before mutation:

- authoritative cutover instruction and decision-maker;
- target rig and host;
- stable target logical ID, node ID, and canonical session name;
- successor logical ID, node ID, canonical session name, and exact provider resume token;
- incumbent exact provider resume token;
- required runtime, model, cwd, `OPENRIG_HOME`, `OPENRIG_URL`, and managed runtime `PATH`;
- old-occupant disposition, including whether it remains wakeable;
- duty-custody artifact or ledger entry the successor must accept;
- queue rows or staged messages that must survive the swap;
- receipt destinations.

Do not infer a provider token from a label. Derive it from the live session record and
corroborate it against the active provider history file.

## Invariants

1. The stable seat identity stays stable. Successor lineage belongs in provenance, not
   in a suffixed live seat name.
2. The exact accepted provider history moves. No compact, summary, fork, or accidental
   stale-history restore is allowed.
3. Desk authority stays frozen from the incumbent's idle acknowledgment until the new
   occupant passes its post-cutover self-check.
4. The incumbent remains wakeable by its exact provider token when the ruled disposition
   is advisory reserve. Preserving the canonical physical pane does not require preserving
   the incumbent process in that pane.
5. A staged prompt is not durable merely because it is visible in a pane. Reconcile it
   against the outbox or another durable source before stopping that pane.
6. Seat binding, provider history, process environment, queue identity, and Herder
   client attachment are separate surfaces. Verify each one.
7. A timed-out operation is indeterminate. Read back by effect before retrying.

## Phase 1: Fence And Preflight

1. Claim the durable operator baton.
2. Ask the incumbent and successor to finish their current atomic action and return to
   idle prompts. Require explicit acknowledgments.
3. Freeze desk actions, folds, rulings, routing, and owner-facing writes.
4. Read the full baton and the named duty-custody artifact.
5. Derive live state:

```bash
rig whoami --json
rig seat status <target-seat> --json
rig ps --nodes --rig <rig> --json
```

6. In the host database, read the latest target and successor session rows. Confirm the
   exact successor resume token and the incumbent token.
7. Confirm both provider history files exist and that the successor file is actively
   written.
8. Inspect the successor pane and durable outbox for staged-but-unsent input. Record a
   disposition for every such input before stopping the seat.
9. Record all Herder/tmux clients currently attached to the incumbent session.
10. Take a bounded rig snapshot and record its ID.

Stop if identity, token, model, authority, custody, or staged-input evidence disagrees.

## Phase 2: Quiesce The Temporary Successor

Use supported lifecycle surfaces. The correct detach verb depends on the current
session origin:

- `claimed` or `adopted`: use `rig unclaim` as prescribed by the CLI;
- `launched`: use `rig seat stop <successor-seat>`; `rig unclaim` will correctly refuse.

Run `rig seat clean` only if a remaining managed record actually needs cleaning. A
`nothing_to_clean` result after a successful stop is acceptable.

Do not use `rig down`, kill a provider, clear the provider history, or start a generic
fresh occupant.

## Phase 3: Realize The Exact Candidate

Start an isolated, discoverable candidate from the exact accepted provider token. Give
it the target seat's canonical environment from its first byte:

```text
OPENRIG_SESSION_NAME=<target-session>
OPENRIG_NODE_ID=<target-node-id>
OPENRIG_RUNTIME=<runtime>
OPENRIG_HOME=<home>
OPENRIG_URL=<url>
PATH=<managed-runtime-bin>:<required-system-paths>
```

Launch the provider with the exact model, token, and canonical name. Put `PATH` in the
provider process environment itself. Setting tmux session environment alone is not
sufficient because an intervening login shell can replace it.

Register or discover the candidate and record its discovery ID. Before committing,
verify its process argv and environment directly:

- exact resume token;
- exact model;
- canonical `--name`;
- canonical target node and session environment;
- `node` and `rig` resolvable from the managed runtime path.

## Phase 4: Commit The Binding

Run the supported handover against the discovery record:

```bash
rig seat handover <target-seat> \
  --source discovered:<discovery-id> \
  --reason <durable-reason> \
  --operator <operator-seat> \
  --json
```

Read back the result. Require:

- `handover_result=complete`;
- target node unchanged;
- continuity outcome names the actual mode, normally `resumed`;
- provenance points to the previous occupant;
- a new target session row exists.

Do not rename panes before this commit is durable.

## Phase 5: Preserve The Physical Seat, Reconcile, And Preserve Memory

The canonical tmux session, window, and pane are part of the stable seat when humans or
agents have attached clients. Do not make those clients chase a renamed session.

1. In the original canonical pane, stop only the incumbent provider process. Keep the tmux
   session, window, and pane unchanged.
2. Keep the incumbent's exact provider token in the lineage ledger as the cold-advisor
   handle. It need not retain a permanently renamed tmux pane.
3. Stop the staged successor process only after its accepted token is durable, then resume
   that exact successor token inside the original canonical pane with the canonical name,
   model, cwd, environment, and managed `PATH`.
4. Reconcile the canonical target session through the supported seat surface and persist
   the exact resume token using the audited token-input surface.
5. Verify the canonical seat has exactly one managed occupant, the old token remains
   wakeable, and the empty staging session is removed.

Renaming the incumbent and staging sessions is a repair fallback for a run that already
changed the physical session, never the default cutover. A resumed reserve can retain a
boot-time canonical name in its own argv or environment; that residue does not make it the
bound seat. Fence reserve replies in their body and treat the topology binding as authority.

## Phase 6: Post-Cutover Self-Check

Keep authority frozen. Ask the new occupant to derive, not assume:

1. `rig whoami --json`: stable logical ID, node ID, canonical session, runtime, edges;
2. `rig queue whoami`: canonical destination and open-row census;
3. active provider UUID from the newest live history file;
4. effective model from live provider records, not only the spec pin;
5. duty-custody artifact read and accepted;
6. all cutover-window queue rows accounted for;
7. `command -v node` and `command -v rig` from the agent's own tool shell;
8. a narrow hook/tool action proving no startup-environment failure.

If any surface fails, preserve the exact provider UUID and repair only the disagreeing
surface. Relaunch the same history if needed. Repeat the full self-check before
unfreezing authority.

## Phase 7: Unfreeze And Transfer Custody

After a clean self-check:

1. explicitly unfreeze desk authority;
2. transfer each staged or cutover-window instruction exactly once;
3. require the new occupant to verify the effects by read-back;
4. notify the routing lead and incumbent reserve of completion;
5. leave the incumbent reserve idle, uncompacted, and authority-free.

## Phase 8: Verify Herder Views

Clients follow the physical tmux session and pane, not the logical binding. The default
physical-seat cutover should leave every recorded client attached to the same canonical
pane. Read the attachments back. If a repair fallback already renamed the session, retarget
each affected client explicitly:

```bash
rig seat switch-client <target-seat> --client <tty> --json
```

Read back all client attachments. A correct cutover can otherwise still look wrong in
the grid or focus tab.

## Completion Proof

The receipt must include:

- operator baton and authority source;
- snapshot ID;
- stable and temporary node IDs;
- old and new provider UUIDs;
- discovery, handover, and final session IDs;
- final process argv and critical environment;
- `rig seat status` result;
- target and successor inventory states;
- queue-row reconciliation;
- staged-input disposition and effect proof;
- reserve pane/name/token and fence;
- Herder client attachments;
- new occupant's self-check and first verified desk acts;
- deviations, failed attempts, and remaining product gaps;
- receipt path and SHA-256.

Close the baton only after the receipt exists and the new occupant has performed at
least one authority-bearing act verified by effect.

## Traps Proven In The 2026-08-28 Run

- A dry-run can accept a managed successor while the live handover refuses
  `successor_already_managed`. Quiesce the temporary seat first.
- Generic launch/restore selection can choose an older seat history. Launch the exact
  accepted resume token.
- Handover can bind a candidate without stopping the incumbent. Apply the ruled
  disposition explicitly.
- Reconciliation can create the right session identity without carrying the resume
  token. Persist and read it back.
- A canonical-looking process can still have a broken tool `PATH`. Verify from inside
  the provider's own tool shell.
- Renaming sessions makes Herder clients follow the retired pane. Preserve the physical
  canonical pane by default; retarget explicitly only when repairing an already-renamed run.
- Pane input can be visible but absent from JSONL. Reconcile the durable outbox before
  stopping the pane.
- Reserve messages can render with the stable seat name because boot-time environment
  survives unbinding. The reserve must self-identify and remain explicitly fenced.
- Success output is not effect proof. Read back queue closure, binding, client movement,
  and transferred instructions.

## Productization Candidates

The manual sequence identifies useful first-class product work:

- handover directly from an already-managed successor seat;
- an exact-resume-token candidate launcher;
- first-class `advise`/memory disposition for the old occupant;
- atomic binding plus token persistence;
- managed environment validation before commit;
- staged-input custody reporting;
- verify-or-repair all Herder client attachments for a logical seat;
- reserve attribution distinct from canonical seat attribution;
- one receipt that reports continuity and seat-binding outcomes independently.
