# Crash-cart daemon-down E2E + LOOK-gate (host-side, real-run)

Proves the whole daemon-down cockpit end-to-end: the `rig crash-cart --json` verb (real detector + C2
read) AND the TUI rendering it, with the LOOK-gate capture drop for PM's Mock-2 (3d3c90a0) comparison.
Read-only throughout. Never push.

## Build prerequisites (the verb runs in-process)
```bash
npm run build -w packages/daemon   # emits dist incl. crash-cart-surface.d.ts (the cli subpath resolves here)
npm run build -w packages/cli       # rig bin
npm run build -w packages/tui        # openrig-tui bin
```

## L1 — verb: DOWN + discovery (the money leg)
Stand a stub rig up, then STOP the daemon (down = daemon.json present, pid dead, DB on disk):
```bash
export OPENRIG_HOME="$(mktemp -d)/.openrig"; mkdir -p "$OPENRIG_HOME"
rig daemon start --db "$OPENRIG_HOME/openrig.sqlite" --no-kernel   # then bring a stub rig up (rig up in a stub workspace)
rig daemon stop                                                     # daemon DOWN; daemon.json + DB remain
rig crash-cart --json | tee cc-down.json
```
**PASS:** JSON `{ "state": "down", "discovery": { header{lastActivityAt…}, foundOnHost:[{rigName,seatCount,resumableCount,…}], whereWorkStopped:[…] } }`.
Header `stopReason`/`priorUptimeMs` are `null` (honest — no shutdown record). **Read-only proof:** capture the
sha256 of `openrig.sqlite`/`-wal`/`-shm` before + after — byte-identical (the copy-then-read never touched them).
**FAIL:** the verb renders from a live daemon (should refuse → `refusal`), or mutates the DB.

## L2 — verb: UNVERIFIED (a wedged daemon never reads as DOWN)
With a daemon whose pid is alive but /healthz hangs (or inject `OPENRIG_URL` at a black-hole port):
```bash
OPENRIG_URL="http://127.0.0.1:9  " rig crash-cart --json    # a target that times out, not refuses
```
**PASS:** `{ "state": "unverified", "evidence": { pidState, probeResult:"timeout", failedSignal } }` — NO discovery,
NO cockpit. **FAIL:** a timeout promoted to `down`.

## L3 — verb: first-run (DOWN + no DB → onboarding, not a crash)
Fresh `OPENRIG_HOME` (no daemon.json, no DB): `rig crash-cart --json`.
**PASS:** `{ "state": "down", "discovery": { foundOnHost: [] , header{lastActivityAt:null} } }` → the TUI shows the
first-run framing (below), never a crash header.

## L4 — TUI render + the LOOK-gate capture drop
Launch bare `rig` (daemon down) in a FIXED-viewport tmux (120x32), let it probe, capture the pane:
```bash
tmux new-session -d -x 120 -y 32 -s cc 'OPENRIG_HOME='"$OPENRIG_HOME"' rig'   # bare rig → TUI → probes crash-cart
sleep 2; tmux capture-pane -t cc -e -p > cc-live-cockpit.ans; tmux kill-session -t cc
```
**PASS:** the pane shows the cockpit — header (incl. the honest-null uptime/reason slots) → FOUND ON THIS HOST →
WHERE WORK STOPPED → the `⏎ RESTORE EVERYTHING` + `s/i/n` actions row — matching Mock 2's structure/ordering/emphasis.

### The deterministic LOOK-gate drop (PM Mock-2 comparison) — build it IN
```bash
node --import tsx packages/tui/scripts/capture-crash-cart.mjs \
  "$OPENRIG_WORKSPACE/artifacts/crash-cart-captures"   # 3 screens (.ans + .txt) + SHA256SUMS
```
Drops `cockpit-populated`, `unverified`, `first-run` (`.ans` = real terminal bytes — `cat` to see; `.txt` = plain) +
`SHA256SUMS`. **Deterministic** (fixed fixtures + truecolor): a re-run reproduces byte-identical hashes. PM compares
each `.ans` against **APPROVED-MOCKS-pulse-view-crash-cart-2026-08-05-source.html Mock 2** — structure/ordering/emphasis
is PM's check; taste-beyond-mock is a founder stop-category. (The live L4 tmux capture should match these captures.)

## Fences
Read-only throughout; the cockpit is DOWN-only; UNVERIFIED never offers restore; recovery (RESTORE→C1 batch) is a
labeled seam (C1 excluded this wave); the verb never mutates state. Never push.
