# L3 — daemon-in-container (boots vs container-local sqlite; healthz on the PUBLISHED port; `rig up` settles a zero-token stub topology)

**Runs host-side, after L2.** This is the leg that exercises the stub payload — and where
`docker/testbed/stub-assets.list` is finalized (L0.2): the exact stub `rig.yaml` + agent fixture +
`culture.md` this `rig up` settles ARE the census scope. Zero tokens by construction (runtime: stub).

## THE PUBLISHED-DAEMON PROCEDURE (identical on both A/B arms)

The prior form of this runbook started a LOOPBACK-BOUND daemon and probed it through a published
port — unreachable by construction, so the probe failed on BOTH runtimes (operator A/B receipt
`Q2-AB-d121568ad-20260807-host/AB-RESULT.md`, sha256 3433e95f427828ce: Docker curl 52 / Apple curl
56). A control arm that cannot pass cannot judge the variable arm. The four coupled mechanics
below are the fix; all four are grounded at source and all four apply to BOTH arms verbatim.

**(a) BIND ADDRESS — explicit, never the default.** `packages/daemon/src/index.ts:148` reads
`OPENRIG_HOST` (alias `RIGGED_HOST`); when set, `:163` binds exactly that host; when UNSET, `:167`
defaults to `127.0.0.1` (+ tailscale when detected). A container reached through published ports
MUST set `OPENRIG_HOST=0.0.0.0`.

**(b) BEARER — required for the daemon to START on this bind, and separately PROVEN.**
`assertBindAuthInvariant` (`packages/daemon/src/middleware/auth-bearer-token.ts:240-264`)
short-circuits for loopback and tailscale binds; for any other bind it REFUSES TO START unless
`OPENRIG_AUTH_BEARER_TOKEN` is non-empty. That refusal is the product being honest — the procedure
satisfies it, never routes around it.
**VERIFIED-AT-SOURCE CORRECTION (do not "fix" the probe to match a wrong expectation):**
`/healthz` is registered directly on the app (`packages/daemon/src/server.ts:574`) and is
**UNAUTHENTICATED** — there is no global auth middleware (`app.use("*")` at `:441` only injects
deps), and `authBearerTokenMiddleware` is mounted inside exactly six route modules
(compaction, hosts, mission-control, rig-policy, sessions, transport). So the health probe does
NOT need an Authorization header and MUST NOT be scored on one. The bearer is therefore proven
separately, on a genuinely guarded surface: `/api/transport/*` guards its whole router
(`packages/daemon/src/routes/transport.ts:9`). Two probes, two distinct facts: the bind, and the
auth path.

**(c) PORT ALLOCATION — an EXPLICIT host port, never `0`.** Apple `container` 1.2.0 rejects the
ephemeral publish form (`Error: invalid publish host port range: 0`) where Docker accepts it —
a captured runtime-parity difference (operator receipt above). The procedure pins one explicit
port so both arms publish identically; ephemeral allocation is not a difference the A/B is
measuring.

**(d) PROBE — byte-identical on both arms.** Probe 1 (`/healthz`, no auth) proves the published
path reaches the daemon. Probe 2 (a guarded route WITH the bearer) proves the auth path. Both are
recorded; a runbook that records only probe 1 has not tested the bearer at all.

## Setup (both arms — only the runtime binary differs)

```bash
GIT_SHA="$(git rev-parse HEAD)"; IMAGE="openrig-testbed:${GIT_SHA}"; EVID="dist/testbed-image/evidence/${GIT_SHA}"; mkdir -p "${EVID}"
NAME="orig-l3-${GIT_SHA:0:8}"
HOSTPORT=19433                      # (c) EXPLICIT — never 0 (Apple 1.2.0 rejects ephemeral)
TESTBEARER="l3-testbed-$(date +%s)" # (b) throwaway, container-scoped, never a real credential
RUNTIME=docker                      # the Apple arm substitutes its CLI here; ALL ELSE IDENTICAL
"${RUNTIME}" run -d -t --name "${NAME}" \
  -p "${HOSTPORT}:7433" \
  -e OPENRIG_HOST=0.0.0.0 \
  -e OPENRIG_AUTH_BEARER_TOKEN="${TESTBEARER}" \
  -e OPENRIG_SELF_HOST_ID=testbed-l3 \
  "${IMAGE}"
```

*Apple-arm note (captured, not a workaround): the loopback-qualified publish form
(`127.0.0.1:PORT:7433`) resets on Apple 1.2.0 while the unqualified `PORT:7433` works. The
unqualified form is therefore the procedure's single published form on BOTH arms — identical
input, not an Apple-only concession.*

## L3.1 — daemon boots vs a container-local sqlite + BOTH probes answer

```bash
"${RUNTIME}" exec "${NAME}" bash -lc 'rig daemon start && sleep 2 && rig status || true' | tee "${EVID}/L3-start.txt"
# PROBE 1 — the BIND, unauthenticated by design:
curl -fsS "http://127.0.0.1:${HOSTPORT}/healthz" | tee "${EVID}/L3-healthz.txt"; echo
# PROBE 2 — the AUTH path, on a genuinely guarded router:
curl -sS -o "${EVID}/L3-auth-probe.txt" -w '%{http_code}\n' \
  -X POST "http://127.0.0.1:${HOSTPORT}/api/transport/send" \
  -H "Authorization: Bearer ${TESTBEARER}" -H 'Content-Type: application/json' \
  -d '{"session":"nonexistent@testbed","text":"auth-path probe"}' | tee "${EVID}/L3-auth-code.txt"
# NEGATIVE CONTROL — the same call with NO bearer must be refused:
curl -sS -o /dev/null -w '%{http_code}\n' \
  -X POST "http://127.0.0.1:${HOSTPORT}/api/transport/send" \
  -H 'Content-Type: application/json' -d '{"session":"nonexistent@testbed","text":"x"}' \
  | tee "${EVID}/L3-auth-negative.txt"
"${RUNTIME}" exec "${NAME}" bash -lc 'ls -l "${OPENRIG_HOME:-$HOME/.openrig}"/*.sqlite* 2>/dev/null || find "$HOME" -name "*.sqlite*" 2>/dev/null' | tee "${EVID}/L3-db.txt"
```

**PASS:** probe 1 returns healthy JSON on the PUBLISHED port; probe 2 is NOT 401 (the bearer is
accepted — any application-level status such as an unknown-session 4xx still proves the auth path);
the negative control IS 401; a container-local sqlite exists.
**FAIL:** no healthz on the published port (bind wrong) / probe 2 401 (bearer path wrong) /
negative control NOT 401 (the guard is not guarding) / DB outside the container / a mounted real
HOME (fence breach).

## L3.2 — `rig up` settles a zero-token stub topology

Ship a minimal `runtime: stub` `rig.yaml` (+ agent fixture + culture.md) as the staged stub assets;
copy it into a container-local workspace and `rig up`.

```bash
"${RUNTIME}" exec "${NAME}" bash -lc '
  set -e
  mkdir -p ~/work && cp -r /opt/openrig-testbed/stub-assets/* ~/work/ 2>/dev/null || true
  cd ~/work && rig up && sleep 3 && rig ps --json' | tee "${EVID}/L3-topology.txt"
```

**PASS:** the stub seat(s) reach a settled/ready state (zero LLM tokens consumed — `runtime: stub`).
**FAIL:** topology never settles / a non-stub runtime is invoked.

## Teardown + evidence

```bash
"${RUNTIME}" exec "${NAME}" bash -lc 'rig down || true' ; "${RUNTIME}" rm -f "${NAME}" >/dev/null
{ grep -qi 'health' "${EVID}/L3-healthz.txt" \
    && [ "$(cat "${EVID}/L3-auth-code.txt")" != "401" ] \
    && [ "$(cat "${EVID}/L3-auth-negative.txt")" = "401" ] \
    && echo "VERDICT: PASS — published bind reachable, bearer path proven, negative control refused, stub topology settles" \
  || echo "VERDICT: FAIL — see L3-*.txt"; } | tee "${EVID}/L3-verdict.txt"
```

## ACCEPTANCE GATE (non-negotiable, before any A/B rerun is requested)

Run this procedure on the **DOCKER** arm alone and prove it GREEN. A control that cannot pass is
not a control; the A/B stays blocked until the Docker baseline is green under this exact text.
Only then does the Apple arm run the identical procedure with its CLI substituted.

**Note:** the exact `rig ps` shape / ready predicate is grounded against the shipped stub adapter at
execution time — do not assert a remembered field name; read the real `--json` output.
