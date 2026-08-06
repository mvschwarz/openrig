# L4 — the 51-02 hermetic contract holds INSIDE the container (fail-closed not weakened)

**Runs host-side, after L3.** The hermeticity floor is "fresh container = fresh HOME" **by
construction** — no real-HOME/workspace mounts (verified in L1–L3 by the no-`-v` fence). This leg
proves the *active* half: the 51-02 env-helper still **REFUSES an injected foreign `OPENRIG_URL`**
inside the container. The container is not an excuse to weaken the fail-closed guard — a leaked daemon
target must hard-refuse exactly as it does host-side (the `DAEMON_TARGET_ENV_VARS` guard class).

## Claim

With a foreign `OPENRIG_URL` (a daemon target the helper did not set itself) present in the
environment, the 51-02 hermetic env prep **hard-refuses** (non-zero + a refusal naming the foreign
target) rather than silently adopting it — inside the container, same as host-side.

## Grounding note (confirm at execution — do NOT assert from memory)

Where the helper runs depends on whether the 51-02 hermetic-env module is **packaged** in the openrig
tarball the image installs (it currently lives at `packages/daemon/test/helpers/hermetic-env.ts` — a
test helper, which may not be in the pack set):
- **If packaged / resolvable in-container:** invoke the assertion directly in the container (L4.1).
- **If not packaged:** this leg is exercised via the **runner's container-execution mode (step-3)** —
  see **L6.3** (`L6-container-runner-e2e.md`), which drives a run with a foreign target injected into the
  base env and the host-side hermetic prep refusing before any container is created — record that as the
  L4 form. Either way, the leg is real; pick the form the shipped surface supports and say which.

## L4.1 — in-container assertion (when the helper is resolvable)

```bash
GIT_SHA="$(git rev-parse HEAD)"; IMAGE="openrig-testbed:${GIT_SHA}"; EVID="dist/testbed-image/evidence/${GIT_SHA}"; mkdir -p "${EVID}"
NAME="orig-l4-${GIT_SHA:0:8}"; docker run -d -t --name "${NAME}" "${IMAGE}"

# Inject a foreign daemon target and drive the hermetic prep; expect a LOUD non-zero refusal.
docker exec -e OPENRIG_URL='http://foreign-daemon.invalid:9999' "${NAME}" bash -lc '
  node --input-type=module -e "
    import { prepareHermeticEnv } from \"@openrig/daemon/test/helpers/hermetic-env.js\";
    try { prepareHermeticEnv({ baseEnv: process.env }); console.log(\"NO-REFUSAL\"); process.exit(0); }
    catch (e) { console.error(\"REFUSED: \" + e.message); process.exit(7); }
  "' 2>&1 | tee "${EVID}/L4-refusal.txt"; RC=${PIPESTATUS[0]:-$?}
docker rm -f "${NAME}" >/dev/null
```

**PASS:** non-zero exit + `REFUSED:` naming the foreign `OPENRIG_URL`. **FAIL:** `NO-REFUSAL` /
exit 0 (the guard was weakened in-container). Adjust the import specifier to the helper's real shipped
path; if it does not resolve, switch to the step-3 form (grounding note) — do not green-pass by memory.

## Evidence

```bash
{ grep -q 'REFUSED:' "${EVID}/L4-refusal.txt" && echo "VERDICT: PASS — foreign OPENRIG_URL hard-refused inside the container" \
  || echo "VERDICT: FAIL / FORM-DEFERRED — see L4-refusal.txt + the grounding note"; } | tee "${EVID}/L4-verdict.txt"
```
