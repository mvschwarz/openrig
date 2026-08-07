# L5 — multi-host topology (N named self-hosts on one network) + the 51-09 live-leg rider

**Runs host-side, after L4.** Proves plan §3: N containers each = one simulated **named host**,
composed via the shipped **host registry over HTTP** (registry rows point at container-DNS names), one
daemon per container, container-local DB/HOME, no real-HOME mounts. The **only** shared surface is the
docker network.

**51-09 live-leg rider (orch, merge desk):** this same two-host setup is the executor for the shipped
51-09 collision/alignment runbook. After the topology settles, run BOTH 51-09 legs **in this same
host-side session** and return both evidence sets. Fixture + steps:
`packages/daemon/test/fixtures/self-host-live-legs/RUNBOOK.md` — **LEG A** (cross-host stamped-triple
round-trip: a cross-host send stores the ORIGIN host in the sender identity and the `↩ Reply:` hint
round-trips verbatim to the origin) and **LEG B** (founder-collision: a same-named rig on both hosts;
the received signature names the origin and the reply lands on the origin, not the local lookalike).

## L5.1 — boot two named self-hosts on one network

**IDENTITY IS READ, NEVER PREDICTED (PM ruling — capture-not-compose applied to identity).** The
self-host id is minted daemon-side and stored as a never-rewritten singleton; the runbook CAPTURES
each container's id from its own surface (`/healthz`, whose `selfHostId` field is emitted at
`packages/daemon/src/server.ts:589`) and then uses that CAPTURED value verbatim. It never predicts,
hardcodes, or derives an id. (`OPENRIG_SELF_HOST_ID` was NOT the knob: `docker/testbed/entrypoint.sh:8`
only ECHOES it for `docker logs`; nothing in the daemon reads it. Do not reintroduce it.)

**BIND + BEARER, carried from L3 verbatim.** L5 needs cross-container HTTP, so each daemon must be
reachable off-loopback — the same three coupled parts L3 proved, for the same reasons, with the same
never-weaken-the-guard rail: explicit `OPENRIG_HOST=0.0.0.0`, `OPENRIG_AUTH_BEARER_TOKEN` set (the
guard at `packages/daemon/src/middleware/auth-bearer-token.ts:240-264` REFUSES a non-loopback bind
without it), and an explicit published port when a host-side probe is used. Registry rows carry a
bearer POINTER (`--bearer-env` NAME), never a token value.

```bash
GIT_SHA="$(git rev-parse HEAD)"; IMAGE="openrig-testbed:${GIT_SHA}"; EVID="dist/testbed-image/evidence/${GIT_SHA}"; mkdir -p "${EVID}"
NET="orig-net-${GIT_SHA:0:8}"; docker network create "${NET}" >/dev/null
TESTBEARER="l5-testbed-$(date +%s)"   # throwaway, container-scoped, never a real credential

for h in H_A H_B; do
  docker run -d -t --name "$h" --hostname "$h" --network "${NET}" \
    -e OPENRIG_HOST=0.0.0.0 \
    -e OPENRIG_AUTH_BEARER_TOKEN="${TESTBEARER}" \
    -e OPENRIG_TESTBED_BEARER_ENV=OPENRIG_AUTH_BEARER_TOKEN \
    "${IMAGE}"
done
for h in H_A H_B; do docker exec "$h" bash -lc 'rig daemon start && sleep 2 && rig status || true'; done | tee "${EVID}/L5-start.txt"

# CAPTURE each minted id from its own daemon (adopt-by-read; ids are random per boot).
ID_A="$(docker exec H_A bash -lc 'curl -fsS http://127.0.0.1:7433/healthz' | python3 -c "import json,sys; print(json.load(sys.stdin).get('selfHostId',''))")"
ID_B="$(docker exec H_B bash -lc 'curl -fsS http://127.0.0.1:7433/healthz' | python3 -c "import json,sys; print(json.load(sys.stdin).get('selfHostId',''))")"
printf 'H_A selfHostId=%s\nH_B selfHostId=%s\n' "${ID_A}" "${ID_B}" | tee "${EVID}/L5-selfids.txt"
[ -n "${ID_A}" ] && [ -n "${ID_B}" ] && [ "${ID_A}" != "${ID_B}" ] || { echo "L5.1 FAIL: missing or identical self-host ids"; exit 1; }
```

**PASS:** both containers report a NON-EMPTY, DISTINCT `selfHostId` on their own `/healthz`, and each
id is stable across a daemon restart in that container (51-09 incr 1 — the singleton is never
re-keyed). **FAIL:** an empty id / identical ids / an id that changes on restart.

*Readback note (captured product observation, NOT worked around here): `rig whoami` reports a SEAT
identity and a bare host container has no seat, so it cannot answer "which host am I". The
daemon-surface read above is the shipped substitute. The declared-identity + host-readback gap is
pooled at PM's desk (identity family); this runbook consumes what ships.*

## L5.2 — compose via the host registry over HTTP

Register `H_B` in `H_A`'s host registry pointing at the container-DNS name `H_B` (reachable on `${NET}`):

```bash
# CURRENT grammar (packages/cli/src/commands/host.ts:427-433): --id and --transport are REQUIRED;
# http transport takes --url; the bearer rides as a POINTER (env var NAME), never a value.
# The id is the CAPTURED ${ID_B} — adopt-by-read, never an authored name.
docker exec H_A bash -lc "rig host add --id '${ID_B}' --transport http --url http://H_B:7433 --bearer-env OPENRIG_AUTH_BEARER_TOKEN && rig host ls --json" | tee "${EVID}/L5-registry.txt"
```

**PASS:** `H_A`'s registry lists the CAPTURED id `${ID_B}` at the container-DNS URL; a probe reaches `H_B`'s daemon over
the network only. **FAIL:** unreachable / resolves off-network. (Ground the exact `rig host` flag shape
against the shipped CLI at execution — read `--json`, don't assert a remembered field.)

## L5.3 — execute the 51-09 live legs (the rider) in this session

Using `H_A`/`H_B` as the two hosts, follow the shipped runbook end-to-end and bank its evidence here:

```bash
# Source of truth for the exact seats/fixtures/steps + PASS predicates:
sed -n '1,200p' packages/daemon/test/fixtures/self-host-live-legs/RUNBOOK.md
# LEG A: cross-host send orch@rig-a -> dev@rig-b --host B; expect From: orch@rig-a@A + verbatim reply lands on H_A.
# LEG B: same-named rig 'shared' on both; expect From: lead@shared@A + reply lands on H_A's lead@shared.
# Capture each received pane + the stored source_session; write to L5-leg-a.txt / L5-leg-b.txt.
```

**PASS:** LEG A signature names `A` + stored `source_session == orch@rig-a@A` + verbatim reply lands on
`H_A`; LEG B signature names the origin `A` + reply lands on `H_A`'s lookalike, not `H_B`'s. Include the
51-09 fail-open control (stop `H_A`'s daemon → `From:` degrades to 2-part, no crash).

## Teardown + evidence

```bash
docker rm -f H_A H_B >/dev/null; docker network rm "${NET}" >/dev/null
{ echo "topology: 2 named hosts A/B on ${NET}, registry-composed"; echo "51-09 rider: LEG A + LEG B executed against the testbed containers"; \
  echo "VERDICT: PASS|FAIL — per L5-selfids/registry/leg-a/leg-b captures (verdict on bytes, not memory)"; } | tee "${EVID}/L5-verdict.txt"
```

**Fences:** no real-HOME mounts; the docker network is the only shared surface; scenarios byte-unchanged.
**Docker-gap watch (plan §3):** if per-container network identity proves insufficient for a topology the
design needs, THAT is the named concrete gap the ruling requires before any Apple-stack revisit — route
to PM with the evidence, never install.
