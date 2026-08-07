// L6 STEP-0 — the container-mode TOPOLOGY STAGING adapter (the pipeline's half of the boundary).
//
// The defect it closes: the loader resolves a scenario's `topology` to a HOST absolute path, and
// buildRealDeps forwards it UNCHANGED to a CONTAINER daemon (`rig up <hostPath>`), which reads it
// INSIDE the container and reports a mystery "Source not found" — the same host-vs-container path
// assumption behind the /root staging block and the readable-but-not-writable block.
//
// The METHOD lives in the shared module (testbed-published-daemon.ts: stageTopologyPlan + argv
// helpers, one source of truth with the runbook). THIS file is only the pipeline INTEGRATION — it
// drives the plan's steps through the injected docker seam. It stages the topology's DIRECTORY (the
// fixtures reference culture.md + agents/ relatively, so they must ride along) and returns the
// IN-CONTAINER path to the topology file — never the host absolute (containerStagePath throws on
// absolute/'..' so a host path cannot leak through).

import { basename, dirname } from "node:path";
import { stageTopologyPlan } from "./testbed-published-daemon.js";
import type { DockerResult } from "./scenario-container.js";

/**
 * The injected docker seam, extended to carry a step's stdin. A step with `stdinFrom` (the tar-side
 * argv) runs `tar <stdinFrom>` piped into `docker <argv>` (the tar-pipe stage); a step without it is
 * a plain `docker <argv>`. The invoker MUST check BOTH the tar exit AND the docker exit and report a
 * non-zero code if EITHER fails — a shell pipeline reports only the last command's status, so a
 * failing tar into a succeeding `docker exec` would otherwise mask an empty stage (the false-green
 * class). Real host-side invoker implements the two-process pipe + dual-exit check; the VM fake
 * models both, including the tar-fails/docker-succeeds case.
 */
export type StagingDocker = (args: string[], stdinFrom?: string[]) => Promise<DockerResult>;

/** Loud, typed failure — a silent stage/fence failure is exactly the false-green class we keep
 *  killing (an empty or unwritable stage looks fine until `rig up` EACCESes three steps downstream). */
export class ContainerStageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContainerStageError";
  }
}

/**
 * Container-mode `stageTopology`: stage the host topology file's DIRECTORY into the container's
 * exec-user stage, then return the in-container path to the topology file. Host-mode never wires this
 * (identity — the host daemon reads the host path directly). Drives the plan's steps IN ORDER
 * (mkdir → extract → fence); the fence runs AFTER extraction (an empty stage passes a naive read
 * check) and BEFORE the path is consumed, or the first symptom is EACCES downstream, not a named
 * failure here. Any non-zero step (incl. the fence) throws with the step's diagnostic PROPAGATED.
 */
export function makeContainerStageTopology(
  container: string,
  docker: StagingDocker,
): (hostTopologyPath: string) => Promise<string> {
  return async (hostTopologyPath: string): Promise<string> => {
    const hostDir = dirname(hostTopologyPath);
    // expectFile = the topology's basename: the fence asserts the FILE arrived, not just the dir
    // mkdir created — so a shipped-nothing delivery (masked tar failure) is unrepresentable.
    const plan = stageTopologyPlan({ container, hostDir, name: "topologies", expectFile: basename(hostTopologyPath) });
    for (const step of plan.steps) {
      const res = await docker(step.argv, step.stdinFrom);
      if (res.code !== 0) {
        throw new ContainerStageError(
          `container stage step '${step.label}' failed (exit ${res.code}) in ${container}: ` +
            `${res.stderr || res.stdout || "(no output)"}`,
        );
      }
    }
    // The in-container topology path: the staged dir + the topology's basename. NEVER the host
    // absolute — plan.stagePath came from containerStagePath (throws on absolute/'..').
    return `${plan.stagePath}/${basename(hostTopologyPath)}`;
  };
}
