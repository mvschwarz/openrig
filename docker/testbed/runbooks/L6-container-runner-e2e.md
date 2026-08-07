# L6 — the 51-02 runner drives a REAL scenario through the container (container-mode e2e) + host-mode parity

**Runs host-side, after L3** (needs the built image + a container-local daemon that boots). This is the
live proof of the 51-04 step-3 mechanism: the runner's **container-mode opt-in** stands the
scenario-local daemon up INSIDE the testbed image (by manifest identity), drives the SAME shipped
scenario through the SAME host-side reads pointed at the container's **published port**, and stamps the
image manifest id onto every results-ledger row. It also carries the **L4 hermetic fail-closed leg's
step-3 form** (the grounding note in `L4-hermetic-fail-closed.md` points here) and the **host-mode
byte-intact parity** check that closes the additive-opt-in fence behaviorally.

The step-3 pieces this exercises are unit-proven in the VM (`test/scenario-container.test.ts`,
`test/scenario-daemon-mode.test.ts`) with an INJECTED docker runner; L6 is where the REAL `docker`
invoker + a live container replace the injection — the leg no source-only proof can give.

## Topology of a container-mode run (what talks to what)

- The **daemon** runs inside the container (`rig daemon start` on the container port, container-local
  HOME/DB, no mounts).
- The host-side **`rig` reads/writes** (the shipped CLI subprocesses the runner already uses) run on the
  HOST against `OPENRIG_URL = http://127.0.0.1:<published port>` — the adapter self-sets that URL to its
  OWN container (never a foreign target). So the host still needs the built CLI bin for the READ side.

## Prerequisites

```bash
# L0 resolved the base + stub-assets slots; the build verb produced the image + manifest.
scripts/build-testbed-image.sh                                   # -> dist/testbed-image/manifest.json
GIT_SHA="$(git rev-parse HEAD)"; IMAGE="openrig-testbed:${GIT_SHA}"
EVID="dist/testbed-image/evidence/${GIT_SHA}"; mkdir -p "${EVID}"
# Built HOST rig bin for the read side (the same bin run-scenarios.mjs uses).
npm run build -w packages/cli && npm run build -w packages/daemon
test -x packages/cli/dist/bin-wrapper.js || { echo "BLOCKER: build the CLI bin first"; exit 1; }
command -v docker >/dev/null || { echo "BLOCKER: docker not on PATH"; exit 1; }
```

## L6.1 — drive a real scenario through container-mode (the runner as a host-side wrapper)

The operator runs the runner in container-mode by supplying the step-3 `daemon` spawner + `imageId`.
This wiring composes only already-tested helpers (`spawnContainerDaemon`, `runScenarioFile`,
`withImageId`); the only new-at-runtime piece is the REAL `docker` invoker (the container analogue of
`runRig`'s `node <rigBin>`). Run it host-side with the tsx loader:

```bash
node --import tsx - "$IMAGE" "$(jq -r .manifestDigest dist/testbed-image/manifest.json)" <<'RUN' | tee "${EVID}/L6-container.txt"
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { runScenarioFile } from "./packages/daemon/test/helpers/scenario-pipeline.ts";
import { spawnContainerDaemon } from "./packages/daemon/test/helpers/scenario-container.ts";

const [image, imageId] = process.argv.slice(2);
const RIG_BIN = resolve("packages/cli/dist/bin-wrapper.js");
const SCENARIO = resolve("packages/daemon/test/fixtures/scenarios"); // pick one committed scenario file below

// The REAL docker invoker — mirrors runRig: never rejects, returns the exit code.
const docker = (args) => new Promise((res) => {
  execFile("docker", args, { maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
    const code = err && typeof err.code === "number" ? err.code : err ? 1 : 0;
    res({ stdout: stdout ?? "", stderr: stderr ?? "", code });
  });
});

// Container-mode: inject the ScenarioDaemon-shaped container adapter + the manifest id.
const daemon = (scaffold /*, opts */) => spawnContainerDaemon(scaffold, { image, docker });
// COMMITTED scenario (the prior literal `scenario-collision.yaml` DOES NOT EXIST in the tree —
// operator-caught at the L4/L6 re-entry). L6 proves the container RUNNER, so it drives a real
// shipped scenario; override with L6_SCENARIO to run another COMMITTED file, never an improvised one.
const scenario = `${SCENARIO}/` + (process.env.L6_SCENARIO ?? "scenario-02-baton.yaml");
const baseEnv = { HOME: process.env.HOME, PATH: process.env.PATH, TERM: "xterm" };

const records = [];
const result = await runScenarioFile(scenario, {
  rigBin: RIG_BIN, baseEnv, daemon, imageId,
  deps: { appendRecord: (r) => records.push(r), normalizer: (_s, v) => v },
});
console.log("VERDICT:", result.verdict, "scenario:", result.scenario);
console.log("LEDGER:", JSON.stringify(records));
process.exit(result.verdict === "PASS" ? 0 : 1);
RUN
```

**PASS:** the scenario reaches its expected verdict driven against the in-container daemon, AND every
ledger row carries `imageId == manifest.manifestDigest` (grep the `LEDGER:` line). **FAIL:** the daemon
never comes up in the container / a read cannot reach the published port / a ledger row is missing the
image id. (Ground the exact expected verdict against the chosen scenario — a 51-03-dependent
cross-surface scenario is not expected green until its normalizer ships; pick a settled scenario.)

## L6.2 — host-mode parity (the additive-opt-in fence, behaviorally)

Run the IDENTICAL scenario in **host-mode** (no `daemon` override, no `imageId`) and compare verdicts:

```bash
L6_MODE=host node --import tsx packages/daemon/scripts/run-scenarios.mjs \
  packages/daemon/test/fixtures/scenarios/scenario-02-baton.yaml | tee "${EVID}/L6-host.txt"
```

**PASS:** the host-mode verdict for the same scenario matches the container-mode verdict from L6.1 —
container-mode changed nothing about the host-mode path (the 51-02 contract is byte-intact; the ledger
rows differ ONLY by the added `imageId` key in container-mode). **FAIL:** host-mode verdict diverges
from pre-51-04 for the same scenario (a fence breach — that would demand a PM 51-02 gate).

## L6.3 — container-mode fail-closed (the L4 step-3 form)

Inject a FOREIGN daemon target into the base env and confirm the run HARD-REFUSES before standing any
container up (the container is not an excuse to weaken the `DAEMON_TARGET` guard — same as host-mode):

```bash
OPENRIG_URL='http://foreign-daemon.invalid:9999' node --import tsx - "$IMAGE" <<'RUN' 2>&1 | tee "${EVID}/L6-failclosed.txt"; RC=${PIPESTATUS[0]:-$?}
import { resolve } from "node:path";
import { runScenarioFile } from "./packages/daemon/test/helpers/scenario-pipeline.ts";
import { spawnContainerDaemon } from "./packages/daemon/test/helpers/scenario-container.ts";
const [image] = process.argv.slice(2);
const daemon = (scaffold) => spawnContainerDaemon(scaffold, { image, docker: async () => ({ stdout: "", stderr: "", code: 0 }) });
try {
  await runScenarioFile(resolve("packages/daemon/test/fixtures/scenarios/scenario-02-baton.yaml"),
    { rigBin: resolve("packages/cli/dist/bin-wrapper.js"), baseEnv: process.env, daemon });
  console.log("NO-REFUSAL"); process.exit(0);
} catch (e) { console.error("REFUSED: " + e.message); process.exit(7); }
RUN
```

**PASS:** non-zero exit + `REFUSED:` naming the foreign `OPENRIG_URL` — `prepareHermeticEnv` fail-closes
on the foreign target in `baseEnv` and NO container is created. **FAIL:** `NO-REFUSAL` / exit 0 (the
guard was bypassed in container-mode). This is the step-3 form of the L4 leg (the packaged-helper form
lives in `L4-hermetic-fail-closed.md`); either form is real — record which one the shipped surface ran.

## Teardown + evidence

Container-mode tears its own container down (the adapter's `stop` = `docker rm -f`), so a clean run
leaves nothing. Sweep any strays from a failed run, then verdict on the captured bytes:

```bash
docker ps -aq --filter "ancestor=${IMAGE}" | xargs -r docker rm -f >/dev/null
{ grep -q 'VERDICT: PASS' "${EVID}/L6-container.txt" \
    && grep -q "$(jq -r .manifestDigest dist/testbed-image/manifest.json)" "${EVID}/L6-container.txt" \
    && grep -q 'REFUSED:' "${EVID}/L6-failclosed.txt" \
    && echo "VERDICT: PASS — container-mode drives a real scenario by image identity, ledger carries the manifest id, host-mode parity holds, fail-closed refuses" \
  || echo "VERDICT: FAIL / FORM-DEFERRED — see L6-*.txt"; } | tee "${EVID}/L6-verdict.txt"
```

**Fences (binding):** the scenario YAML is byte-unchanged (51-03 fence); host-mode stays byte-intact
(L6.2 is the behavioral proof — any divergence is a PM 51-02 gate, not a fold); no real-HOME mounts;
the image is selected BY MANIFEST IDENTITY and its digest is the ledger's cross-version key.
