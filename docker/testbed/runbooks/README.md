# openrig-testbed verification runbooks (51-04 step-2, plan §2)

These are **host-executed, evidence-defined** runbooks — the 51-09 live-legs pattern. The VM seat has
no container runtime (locus ruling (a) host-side), so the daemon/operator lane runs them **host-side**
against the image `scripts/build-testbed-image.sh` produces, and returns evidence per the
census-receipt discipline. Each leg is a scripted check that never asserts from memory (the clause
that caught the Apple-container premise): run it, capture the real bytes, verdict against them.

## Legs

| Leg | Proves | Runbook |
|---|---|---|
| L0 | the digest-pinned base + stub-assets census are resolved (prerequisite to a build) | `L0-resolve-inputs.md` |
| L1 | PTY allocation: `docker run -t` + tmux capture-pane returns real bytes; resize propagates | `L1-pty-allocation.md` |
| L2 | tmux server lifecycle: detach-survive, multi-pane, send-keys + capture round-trip | `L2-tmux-server-lifecycle.md` |
| L3 | daemon-in-container: boots vs container-local sqlite, healthz on the published port, `rig up` settles a zero-token stub topology | `L3-daemon-in-container.md` |
| L4 | the 51-02 hermetic contract: the env-helper still REFUSES a foreign `OPENRIG_URL` **inside** the container (fail-closed not weakened by "we're in a container anyway") | `L4-hermetic-fail-closed.md` |
| L5 | multi-host: N containers as N distinct named self-hosts on one docker network, composed via the shipped host registry over HTTP (plan §3) — **and** the 51-09 live-leg rider | `L5-multi-host-and-51-09.md` |

Sequencing: **L0 → build → L1 → L2 → L3 → L4 → L5**. L3 is where the stub payload is exercised (and
where `docker/testbed/stub-assets.list` is finalized). L4 depends on the 51-02 hermetic env-helper
being present in the packaged image (it ships in the openrig package the Dockerfile installs).

**51-09 live-leg rider (orch, merge desk).** The testbed image's first multi-host run doubles as the
51-09 live-leg executor: L5 boots the containers as the two named hosts `H_A`/`H_B` and then runs the
shipped 51-09 collision/alignment runbook **in the same host-side session** —
`packages/daemon/test/fixtures/self-host-live-legs/RUNBOOK.md` (LEG A cross-host stamped-triple
round-trip, LEG B founder-collision). Execute both families together; return both evidence sets.

## Shared conventions

**Image identity.** All legs run against the image the build verb tagged, by manifest identity:
```bash
GIT_SHA="$(git rev-parse HEAD)"
IMAGE="openrig-testbed:${GIT_SHA}"          # == manifest.image
```
Cross-check the running image against the emitted manifest before trusting a leg's result:
```bash
test "$(docker image inspect "${IMAGE}" --format '{{.Id}}')" # exists
cat dist/testbed-image/manifest.json        # the census identity this run is comparable under
```

**Evidence dir (hashed, per the census-receipt discipline).** Each leg writes its captures + a
`VERDICT` line into a per-run evidence dir, then the operator hashes the dir so the evidence is
tamper-evident and comparable across image versions:
```bash
EVID="dist/testbed-image/evidence/${GIT_SHA}"
mkdir -p "${EVID}"
# ... leg writes L1-capture.txt, L1-resize.txt, etc. ...
( cd "${EVID}" && find . -type f -print0 | sort -z | xargs -0 sha256sum ) > "${EVID}.sha256"
```
Record in each leg's evidence: the exact command, the captured bytes, and a single
`VERDICT: PASS|FAIL — <one line>` on the observed bytes (never from memory).

**Fences (binding on every leg).** No real-HOME / real-workspace volume mounts (fresh container =
fresh HOME is the hermeticity floor); scenarios byte-unchanged; the only shared surface between
multi-host containers is the docker network. A leg that cannot run its check reports a **loud
blocker** with the exact command + the missing capability — it never green-passes from memory.
