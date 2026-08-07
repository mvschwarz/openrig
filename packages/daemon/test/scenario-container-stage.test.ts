import { describe, it, expect, vi } from "vitest";
import {
  makeContainerStageTopology,
  ContainerStageError,
  type StagingDocker,
} from "./helpers/scenario-container-stage.js";
import { CONTAINER_STAGE_ROOT } from "./helpers/testbed-published-daemon.js";

// L6 STEP-0 — the container-mode topology-staging driver. It drives the shared module's plan
// (mkdir → extract-with-tar-stdin → fence) through the injected docker seam and returns the
// IN-CONTAINER topology path, never the host absolute. The fence targets the FILE (expectFile), so a
// shipped-nothing delivery — a masked tar failure that leaves an empty but readable+writable stage —
// is unrepresentable. Runs hermetically with a fake StagingDocker; the real-docker leg is host-side.

const CONTAINER = "c0ffeeb0ba";
const HOST_TOPO = "/host/fixtures/scenarios/topo-stub-baton.yaml";
const STAGE = `${CONTAINER_STAGE_ROOT}/topologies`;

/** A recording fake for the extended (stdin-carrying) docker seam. `fail(label)` returns a non-zero
 *  exit for a given step — including the tar-fails/docker-succeeds case, which the real invoker
 *  surfaces as a non-zero extract because it checks BOTH exits (a shell would mask it). */
function fakeStagingDocker(fail?: (label: string) => number) {
  const calls: Array<{ args: string[]; stdinFrom?: string[] }> = [];
  const label = (args: string[], stdinFrom?: string[]) =>
    args.includes("mkdir") ? "mkdir" : stdinFrom ? "extract" : "fence";
  const docker: StagingDocker = vi.fn(async (args, stdinFrom) => {
    calls.push({ args, stdinFrom });
    const l = label(args, stdinFrom);
    const code = fail?.(l) ?? 0;
    return { stdout: "", stderr: code ? `boom-${l}` : "", code };
  });
  return { docker, calls };
}

describe("makeContainerStageTopology — stage the topology dir into the container", () => {
  it("drives mkdir → extract(tar stdin) → fence IN ORDER and returns the in-container path", async () => {
    const { docker, calls } = fakeStagingDocker();
    const containerPath = await makeContainerStageTopology(CONTAINER, docker)(HOST_TOPO);

    expect(containerPath).toBe(`${STAGE}/topo-stub-baton.yaml`); // in-container, never the host absolute
    expect(calls.map((c) => (c.args.includes("mkdir") ? "mkdir" : c.stdinFrom ? "extract" : "fence")))
      .toEqual(["mkdir", "extract", "fence"]); // ordering is the contract
    expect(calls[0]!.args).toEqual(["exec", CONTAINER, "mkdir", "-p", STAGE]);
    // extract carries the tar-side argv as stdin — tar the HOST DIR (siblings ride along: culture.md, agents/)
    expect(calls[1]!.args).toEqual(["exec", "-i", CONTAINER, "tar", "-C", STAGE, "-xf", "-"]);
    expect(calls[1]!.stdinFrom).toEqual(["-C", "/host/fixtures/scenarios", "-cf", "-", "."]);
    // the fence asserts the FILE arrived (expectFile), not just the mkdir'd dir
    expect(calls[2]!.args.join(" ")).toContain(`test -r '${STAGE}/topo-stub-baton.yaml'`);
  });

  it("a masked tar failure (extract non-zero) fails LOUD + NAMED — not a silent empty stage", async () => {
    const { docker } = fakeStagingDocker((l) => (l === "extract" ? 2 : 0));
    await expect(makeContainerStageTopology(CONTAINER, docker)(HOST_TOPO))
      .rejects.toThrow(/stage step 'extract' failed \(exit 2\).*boom-extract/s);
  });

  it("a fence failure (content did NOT arrive) fails LOUD + NAMED at the fence, not 3 steps later", async () => {
    const { docker } = fakeStagingDocker((l) => (l === "fence" ? 1 : 0));
    const p = makeContainerStageTopology(CONTAINER, docker)(HOST_TOPO);
    await expect(p).rejects.toThrow(ContainerStageError);
    await expect(p).rejects.toThrow(/stage step 'fence' failed \(exit 1\)/);
  });
});
