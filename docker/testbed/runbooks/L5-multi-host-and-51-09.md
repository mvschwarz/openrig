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

```bash
GIT_SHA="$(git rev-parse HEAD)"; IMAGE="openrig-testbed:${GIT_SHA}"; EVID="dist/testbed-image/evidence/${GIT_SHA}"; mkdir -p "${EVID}"
NET="orig-net-${GIT_SHA:0:8}"; docker network create "${NET}" >/dev/null

# Each container adopts a distinct self-host id via the entrypoint (plan §3 / 51-09 adopt path).
docker run -d -t --name H_A --hostname H_A --network "${NET}" -e OPENRIG_SELF_HOST_ID=A "${IMAGE}"
docker run -d -t --name H_B --hostname H_B --network "${NET}" -e OPENRIG_SELF_HOST_ID=B "${IMAGE}"
for h in H_A H_B; do docker exec "$h" bash -lc 'rig daemon start && sleep 2 && rig whoami --json'; done | tee "${EVID}/L5-selfids.txt"
```

**PASS:** each `rig whoami` reports its distinct self-id (`A`, `B`) — both non-`local`, registry-valid,
and stable across a daemon restart (51-09 incr 1). **FAIL:** duplicate/`local` self-ids.

## L5.2 — compose via the host registry over HTTP

Register `H_B` in `H_A`'s host registry pointing at the container-DNS name `H_B` (reachable on `${NET}`):

```bash
docker exec H_A bash -lc 'rig host add B --url http://H_B:7433 && rig host ls --json' | tee "${EVID}/L5-registry.txt"
```

**PASS:** `H_A`'s registry lists host `B` at the container-DNS URL; a probe reaches `H_B`'s daemon over
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
