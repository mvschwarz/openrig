---
name: cross-host-rig-commands
description: Use when issuing `rig` commands against a remote host via `--host <id>` flag (single-hop SSH to a host declared in `~/.openrig/hosts.yaml`). Covers the 4 structured failure modes (ssh-unreachable / permission-gate / remote-daemon-unreachable / remote-command-failed), the `--verify` honest pass-through (SSH success is NOT verify success), and the host-registry shape. v0 supports `rig send / capture / ps / whoami --host <id>`.
metadata:
  cli_surfaces_referenced:
    - capture
    - daemon start
    - host list
    - host show
    - ps
    - send
    - whoami
  openrig:
    stage: factory-approved
    sibling_skills:
      - rig-lifecycle
      - topology-mutation-and-seat-management
      - seat-scaling-and-specialization
      - sidecar-operator
      - rig-bundles-and-shareable-artifacts
      - specification-system
      - extension-and-user-workspace
---

# Cross-Host Rig Commands

A first-class OpenRig surface for issuing `rig` commands against a
remote host via single-hop SSH. v0 productizes the existing SSH-envelope
operator pattern (`ssh <host> rig <cmd>`) with declared host identity,
explicit cross-host invocation path, preserved `--verify` semantics, and
4 named failure modes.

**Current-host note (2026-07-14):** this skill still preserves the original
SSH-v0 doctrine below, but the live host registry may also contain HTTP
read-through/tunnel entries such as `your-vm` and `your-other-vm`. Use the
host registry entry as ground truth for transport shape, and use
`conventions/multi-host-naming/README.md` for host-id naming. HTTP entries
require `url` plus exactly one of `bearer_file` or `bearer_env`.

**v0 is CLI-side shell-out only — `packages/daemon/` is NOT touched.**
The remote host has its own managed `rig` available on `$PATH`.

## Use this when

- Driving a Tart VM from the host (the immediate cross-host consumer)
- Operating Mac host A against Mac host B
- Reading remote state via `rig ps --host` / `rig whoami --host`
- Sending or capturing on a remote rig session (`rig send/capture --host <id>`)
- Authoring a `~/.openrig/hosts.yaml` registry entry

## Don't use this when

- The target is local. Don't pass `--host` for local commands.
- You need multi-hop SSH (host A → host B → host C). v0 is single-hop only.
- You want reverse direction (remote initiates back to local). v0 is originator-pull only.
- Cross-host **seat handover** (moving a durable owned seat across hosts) — deferred to higher-level primitives. (Cross-host **queue writes**, by contrast, now ship — see "Cross-host queue writes" below.)
- The transport isn't SSH. v0 supports `transport: ssh` only.

## Cross-host queue writes (updated 2026-07-21 vs main d37a08ad)

Cross-host **queue writes** are no longer deferred — they ship — but the rule
differs from the interactive verbs (`send`/`capture`/`ps`/`whoami`):

- **Queue writes are EXPLICIT-only.** Address the target host explicitly with
  `--host <id>` or the `member@rig@<host>` form. A queue write **never** follows a
  persisted host selection.
- **`host select` stickiness does NOT apply to queue.** `host select` affects the
  `resolveEffectiveHost` verbs (`send`/`capture`/`ps`/`whoami`) — those follow the
  selected host — but a queue write ignores it and requires explicit addressing.
- **Host address parsing differs** between the interactive verbs and the queue
  verbs; do not assume the interactive form carries over. When unsure, address the
  host explicitly.

## Host registry shape (`~/.openrig/hosts.yaml`)

Host ids should follow the OpenRig-work multi-host naming convention:
`conventions/multi-host-naming/README.md`. In this environment that means
physical hosts such as `your-vm`, local OpenRig development VMs such as
`your-vm`, persistent product VMs such as `your-other-vm`, and VPS hosts such
as `your-vps`. Keep old aliases during migration until no live routing
depends on them.

```yaml
hosts:
  - id: a-test-vm
    transport: ssh                       # v0 supports "ssh" only
    target: a-test-vm.local         # DNS name, SSH config alias, or IP
    user: wrandom                        # optional
    notes: "Tart VM"                     # optional
  - id: laptop-b
    transport: ssh
    target: laptop-b.tail-scale-net
    user: wrandom
```

Validation rules:

- `hosts` required, non-null array
- Each entry: `id` required (non-empty, unique), `transport` required (`ssh` only), `target` required
- `user` and `notes` optional
- Operator-managed file; v0 does NOT include any sub-command to add/remove/list hosts (operators edit YAML directly)
- Missing or invalid file returns a clear error pointing at the canonical path

## CLI surface (v0 shipped)

```bash
rig send <session> "msg" --host <id> --verify
rig capture <session> --host <id>
rig ps --host <id> [--nodes] [...]
rig whoami --host <id>
```

Forwards every shaping flag (`--nodes`, `--full`, `--limit`, `--fields`,
`--summary`, `--filter`, `--json`) to the remote `rig` invocation. The
remote rig's output is verbatim passthrough on success.

## The 4 structured failure modes (load-bearing API contract)

The CLI distinguishes 4 failure modes; operators get an actionable error
per mode; JSON output preserves the `failedStep` enum:

| Mode | Cause | Action |
|---|---|---|
| `ssh-unreachable` | SSH itself failed (connection refused, host key mismatch, DNS failure, timeout) | Verify SSH access and the registry entry |
| `permission-gate` | SSH hit auth/permission gate (Permission denied, Keychain) | Error includes hint to keychain-over-SSH field note (L4-3 D6) |
| `remote-daemon-unreachable` | SSH succeeded but remote `rig` reported the remote daemon was not reachable | `ssh <target> rig daemon start` |
| `remote-command-failed` | SSH succeeded but remote `rig` exited non-zero for some other reason; remote stderr is surfaced | Read remote stderr; debug remote command |

Each is distinct and routable. Don't conflate them.

## `--verify` honest pass-through (load-bearing)

`--verify` against a remote target must:

- **Propagate** the verification request to the remote daemon (or remote `rig` invocation that talks to it)
- **Bring back a structured verification result** (true/false + reason if false), NOT just SSH exit code 0
- **Distinguish "SSH succeeded but verify returned false" from "SSH itself failed"** — these are different operator actions

**SSH success is NOT verify success.** The remote rig is authoritative
on `--verify`; its `Verified: yes/no` line is surfaced verbatim. Verified
at 3 layers (executor unit, command integration, source impl).

## Hard boundaries (do-not list)

- **Do NOT collapse `--verify` honest result into SSH exit code.** Operators and agents rely on the distinction.
- **Do NOT silently retry SSH failures inside the primitive.** Surface them; let the caller decide.
- **Do NOT introduce non-SSH transports in v0.** Goal is productizing the existing shipped pattern, not replacing it.
- **Do NOT touch host-side daemon code as part of v0.** Cross-host shape is on the originator side.

## Cross-host annotation

Every cross-host invocation is observable as cross-host:

- **Operator output**: `[via host=<id> (<target>)]` annotation
- **JSON output**: `cross_host: { host, target }` field

Annotation is PRESENT when `--host` is set and ABSENT otherwise
(compat regression).

## Currently shipped (v0) vs deferred

Shipped at openrig `cdce3a6` (2026-04-30):
- `--host <id>` flag on `rig send / capture / ps / whoami` (initial 2 commands; promoted to 4 at `6b7043a` same day)
- Read-only host registry validation
- Single-hop SSH executor with 4-mode `failedStep` enum
- `--verify` honest pass-through
- Cross-host annotation (operator + JSON)
- Daemon untouched

Deferred:
- Tier 2 real-runtime cross-host proof (disposable Tart VM cycle)
- `rig host list / show` read-only sub-namespace (only if host count grows past comfortable manual editing)
- Non-SSH transports
- Multi-hop SSH
- Reverse direction (remote initiates)
- Connection pooling/caching

## See also

- `seat-continuity-and-handover` skill — host-aware seat-binding semantics for cross-host handover (deferred to v1 on top of this v0 baseline)
- `openrig-user` skill — the local CLI surface that cross-host commands wrap

## Sender identity carries the ORIGIN host (51-09, 2026-08-06)

The `@host` sugar on a TARGET is **addressing** (`member@rig@<host>` routes to that host).
The **From:** sender now ALWAYS carries the **origin** host: a cross-host (and local) message's
signature is **`member@rig@<originHost>`** — the sender reflects the host it was sent from, so a
received signature names the ORIGIN, and the `↩ Reply:` hint round-trips **verbatim** back to that
origin (never a same-named local lookalike). This is the always-suffix rule — deterministic and
collision-proof: a signature means one thing to every receiver. (This SUPERSEDES the pre-51-09
asymmetry — "the sender carries no `@host` suffix" — that pm@your-rig flagged as a core gap on
2026-07-25; 51-09 closed it.) Per BR-1 the host is NEVER folded into the session string on the
wire: the CLI edge renders/strips it, the daemon refuses an in-band 3-part destination with a
teaching hint, and a stale 2-part same-name destination is closed by `--host` + that teaching —
not by any in-string magic.
