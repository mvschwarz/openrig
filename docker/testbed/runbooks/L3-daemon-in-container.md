# L3 — daemon-in-container (boots vs container-local sqlite; healthz on the published port; `rig up` settles a zero-token stub topology)

**Runs host-side, after L2.** This is the leg that exercises the stub payload — and where
`docker/testbed/stub-assets.list` is finalized (L0.2): the exact stub `rig.yaml` + agent fixture +
`culture.md` this `rig up` settles ARE the census scope. Zero tokens by construction (runtime: stub).

## Setup

```bash
GIT_SHA="$(git rev-parse HEAD)"; IMAGE="openrig-testbed:${GIT_SHA}"; EVID="dist/testbed-image/evidence/${GIT_SHA}"; mkdir -p "${EVID}"
NAME="orig-l3-${GIT_SHA:0:8}"
# Publish the daemon port to an ephemeral host port; container-local HOME/DB only (no mounts).
docker run -d -t --name "${NAME}" -p 127.0.0.1:0:7433 -e OPENRIG_SELF_HOST_ID=testbed-l3 "${IMAGE}"
HOSTPORT="$(docker port "${NAME}" 7433/tcp | head -n1 | sed 's/.*://')"
```

## L3.1 — daemon boots vs a container-local sqlite + healthz answers

```bash
docker exec "${NAME}" bash -lc 'rig daemon start && sleep 2 && rig status || true'
curl -fsS "http://127.0.0.1:${HOSTPORT}/healthz" | tee "${EVID}/L3-healthz.txt"; echo
docker exec "${NAME}" bash -lc 'ls -l "${OPENRIG_HOME:-$HOME/.openrig}"/*.sqlite* 2>/dev/null || find "$HOME" -name "*.sqlite*" 2>/dev/null' | tee "${EVID}/L3-db.txt"
```

**PASS:** `/healthz` returns healthy JSON on the published port; a container-local sqlite exists.
**FAIL:** no healthz / DB outside the container / a mounted real HOME (fence breach).

## L3.2 — `rig up` settles a zero-token stub topology

Ship a minimal `runtime: stub` `rig.yaml` (+ agent fixture + culture.md) as the staged stub assets;
copy it into a container-local workspace and `rig up`.

```bash
docker exec "${NAME}" bash -lc '
  set -e
  mkdir -p ~/work && cp -r /opt/openrig-testbed/stub-assets/* ~/work/ 2>/dev/null || true
  cd ~/work && rig up && sleep 3 && rig ps --json' | tee "${EVID}/L3-topology.txt"
```

**PASS:** the stub seat(s) reach a settled/ready state (zero LLM tokens consumed — `runtime: stub`).
**FAIL:** topology never settles / a non-stub runtime is invoked.

## Teardown + evidence

```bash
docker exec "${NAME}" bash -lc 'rig down || true' ; docker rm -f "${NAME}" >/dev/null
{ grep -qi 'health' "${EVID}/L3-healthz.txt" && echo "VERDICT: PASS — daemon boots vs container-local sqlite, healthz answers, stub topology settles" \
  || echo "VERDICT: FAIL — see L3-*.txt"; } | tee "${EVID}/L3-verdict.txt"
```

**Note:** the exact `rig ps` shape / ready predicate is grounded against the shipped stub adapter at
execution time — do not assert a remembered field name; read the real `--json` output.
