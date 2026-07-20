# Product-Factory VPS Runbook (product-factory-vps)

OPR.0.4.4.13 — the productized form of the 2026-06-23 OVH smoke test: a fresh
Ubuntu VPS becomes an OpenRig product factory managed from a home base, with
the proven security posture as the encoded default. The bootstrap is a
SCRIPT + THIS RUNBOOK by design — host verbs are capped at `add`/`list`/
`doctor`, and the acceptance anchor is the observable end state: home-base
`rig host doctor <id>` all green.

## 1. Prerequisites

- A fresh Ubuntu 22.04/24.04 VPS (any provider; the lived reference was OVH).
- A Tailscale tailnet you administer; the home base already on it.
- A home-base SSH keypair for the factory (`ssh-keygen -t ed25519 -f ~/.ssh/openrig-factory`).
- The published OpenRig artifact (`@openrig/cli@<version>`) or the packaged
  tarball a release branch builds (`npm pack` output) for pre-release proof.
- Dedicated Claude/Codex accounts for THIS factory. Never copy home-base
  credentials (`~/.claude`, `~/.codex`, `~/.openrig`) onto a VPS.

## 2. Tailscale tag + ACL (one-time per tailnet)

In the Tailscale admin console (the UI's words, mapped):
- **tag name**: `openrig-vps` (enter as `tag:openrig-vps` in ACL JSON).
- **tag owner**: your tailnet admin group/user (`"tagOwners": {"tag:openrig-vps": ["autogroup:admin"]}`).
- ACL: home base may reach `tag:openrig-vps` on 22/7433 over the tailnet;
  `tag:openrig-vps` gets NO grants toward the home base (the reverse path is
  the explicit recipe in §6, never standing policy).
- Auth keys for `tailscale up` must be EPHEMERAL or revoked after use.

## 3. Bootstrap (fresh VPS → factory-ready)

On the VPS, as root:

```bash
curl -fsSLO <your-copy-of>/scripts/bootstrap-product-factory-vps.sh
chmod +x bootstrap-product-factory-vps.sh
./bootstrap-product-factory-vps.sh \
  --artifact @openrig/cli@<version> \
  --authorized-key "$(cat ~/.ssh/openrig-factory.pub)" \
  --ts-authkey tskey-...   # ephemeral
```

The script is stepwise and loud: non-root `openrig` user (key-only) → sshd
hardening drop-in (`PermitRootLogin no`, `PasswordAuthentication no`,
`KbdInteractiveAuthentication no`, `X11Forwarding no`) → UFW default-deny +
tailnet ingress (public SSH stays open as a BOOTSTRAP ESCAPE HATCH only) →
Tailscale with `tag:openrig-vps`, no routes/exit-node/Tailscale SSH → Node 22 →
`npm install -g` of the artifact (must succeed with NO manual package
patching) → daemon + kernel.

On the home base:

```bash
rig host add --id ovh-01 --transport ssh --target <tailnet-alias> --user openrig
rig host doctor ovh-01                                   # expect 4/4 green
rig host doctor ovh-01 --posture product-factory-vps --public-addr <public-ip>
```

Then close the escape hatch on the VPS: `sudo ufw delete allow OpenSSH` and
make sure Tailscale SSH is off: `tailscale set --ssh=false`. Re-run the
posture check. UNKNOWN posture items are NOT passes — each carries the command
that verifies it from the right vantage.

## 4. Transport posture (the decided partition)

See the per-command transport table in `docs/as-built/cli-reference.md`
(§Cross-host execution). The partition IS the intended posture: ssh carries
interactive pane ops (`send`/`capture`); http carries daemon REST ops
(`up`/`down`/`launch`); `ps`/`whoami` follow the host's DECLARED transport;
fan-out (`--all-hosts`) is http-only. There is NO cross-transport fallback and
NO http parity for send/capture in 0.4.4 (parity = new attack surface with no
scope-locked need).

## 5. Safe UI access (recipe, not a verb)

The daemon binds loopback/tailnet — never public. View the factory UI through
a local tunnel (the smoke test's exact form):

```bash
ssh -N -L 127.0.0.1:17433:127.0.0.1:7433 <tailnet-alias>
# then open http://127.0.0.1:17433
```

Tear the tunnel down when done. Do not add public allow rules for :7433.

## 6. Restricted reverse path (supported recipe — NOT always-on)

Boundary first: home-base-initiated ONLY; no broad VPS→home SSH; the tunnel is
torn down after use. The factory cannot freely reach into the home base.

1. On the home base, create a dedicated key the FACTORY will use through the
   reverse tunnel, and gate it with a forced command in
   `~/.ssh/authorized_keys`:

```text
command="$HOME/.openrig/bin/openrig-reverse-gate",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty ssh-ed25519 AAAA...factory-reverse-key
```

2. The gate script (generatable template — allowlists EXACTLY the four verbs
   the smoke test proved; everything else is refused, fail-closed):

```bash
#!/usr/bin/env bash
# openrig-reverse-gate — forced-command allowlist for the reverse path.
set -euo pipefail
case "${SSH_ORIGINAL_COMMAND:-}" in
  "rig send "*|"rig capture "*|"rig ps"*|"rig whoami"*)
    exec $SSH_ORIGINAL_COMMAND ;;
  *)
    echo "refused: only rig send/capture/ps/whoami are allowed on this key" >&2
    exit 77 ;;
esac
```

3. Open the reverse tunnel FROM the home base when you want the channel:

```bash
ssh -N -R 127.0.0.1:2222:127.0.0.1:22 <tailnet-alias>   # home-base initiated
```

4. On the factory, agents reach home through it:
   `ssh -p 2222 -i <factory-reverse-key> operator@127.0.0.1 rig send <session> "..."`.
5. Kill the tunnel after use. The REFUSAL of any out-of-allowlist verb is the
   proof artifact that the gate works — test it on purpose.

## 7. Credential + teardown discipline

- Runtime credentials (Claude/Codex) live ON the VPS, provisioned for it —
  never copied from the home host.
- Snapshot/backup expectations and clean teardown follow the provider's
  tooling; `rig down --snapshot` before destroying a factory.
- Revoke the Tailscale node + one-time keys when a factory is retired.
