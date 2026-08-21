// The COMMITTED real StagingDocker invoker (founder-ruled 2026-08-21, engine-independent leg).
//
// The defect it closes: the L6 runbook's inline invoker (authored 08-06) predates the stdinFrom
// tar-pipe contract (9d2f1f2cc, 08-07) and ignores it — execFile left the child a pipe stdin that
// was held open and never fed, so the in-container `tar -xf -` blocked on read(stdin) forever
// (row 42576855: child stuck 7+ minutes, parent alive, zero scenario output). These tests are
// HERMETIC — `sh` stands in for both the docker and tar binaries, exercising the pipe/exit/timeout
// mechanics the contract demands (scenario-container-stage.ts:20-28) with NO engine. They prove
// the invoker; live containment is explicitly NOT claimed — that proof waits on the 5.3 engine
// substrate ruling.
//
// The hang-class discriminator: against the old inline invoker shape (execFile, stdin pipe open
// and unfed), the "stdin-reading child" cases below never terminate. Here they must.

import { describe, it, expect } from "vitest";
import { makeRealStagingDocker } from "./helpers/staging-docker-invoker.js";

/** sh stands in for docker AND tar: argv are `-c <script>` scripts. */
function shInvoker(stepTimeoutMs?: number) {
  return makeRealStagingDocker({ command: "sh", tarCommand: "sh", ...(stepTimeoutMs ? { stepTimeoutMs } : {}) });
}

describe("makeRealStagingDocker — the two-process tar-pipe contract, hermetically (sh stand-ins)", () => {
  it("fed pipe leg: stdinFrom bytes reach the docker side AND EOF propagates (the consumer terminates)", async () => {
    const docker = shInvoker();
    // "tar" produces bytes and exits; "docker" (cat) must see the bytes AND the EOF — cat only
    // terminates if the pipe is CLOSED after the producer exits, which is exactly what the old
    // invoker never did.
    const res = await docker(["-c", "cat"], ["-c", "printf 'payload-bytes'"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toBe("payload-bytes");
  });

  it("HANG CLASS DIES: a step WITHOUT stdinFrom gives the child a CLOSED stdin — a stdin-reading child terminates instead of blocking forever (RED on the old execFile inline invoker)", async () => {
    const docker = shInvoker();
    // `cat` with no input: old shape blocks on the open never-fed pipe (the 08-12 specimen);
    // correct shape closes stdin so cat sees EOF immediately and the step completes.
    const res = await docker(["-c", "cat; echo done"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toBe("done\n");
  });

  it("step timeout: a stalled docker side is KILLED and returns a NAMED timeout failure, never an unbounded wait", async () => {
    const docker = shInvoker(300);
    const res = await docker(["-c", "sleep 30"]);
    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain("timeout");
    expect(res.stderr).toContain("300");
  });

  it("step timeout covers the tar side too: a stalled PRODUCER cannot hang the step", async () => {
    const docker = shInvoker(300);
    const res = await docker(["-c", "cat"], ["-c", "sleep 30"]);
    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain("timeout");
  });

  it("DUAL-EXIT: tar fails while docker succeeds → the step FAILS and names the tar side (the shell-pipeline false-green class)", async () => {
    const docker = shInvoker();
    // tar exits 3 producing nothing; cat sees immediate EOF and exits 0. A shell pipeline reports
    // only cat's 0 — the masked-empty-stage defect the contract exists to kill.
    const res = await docker(["-c", "cat"], ["-c", "exit 3"]);
    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain("tar");
    expect(res.stderr).toContain("3");
  });

  it("docker-side failure propagates its own exit code", async () => {
    const docker = shInvoker();
    const res = await docker(["-c", "exit 5"]);
    expect(res.code).toBe(5);
  });

  it("early docker exit while tar is still writing resolves LOUDLY (EPIPE handled, no crash, non-zero)", async () => {
    const docker = shInvoker();
    // docker side exits without reading; tar side pushes ~2MB and dies of SIGPIPE. The invoker
    // must survive the EPIPE on the pipe wiring and report the producer's death as a failure —
    // content did not arrive, whatever the consumer's exit said.
    const res = await docker(["-c", "exit 0"], ["-c", "dd if=/dev/zero bs=1024 count=2048 2>/dev/null"]);
    expect(typeof res.code).toBe("number");
    expect(res.code).not.toBe(0);
  });

  it("never rejects: a nonexistent binary resolves with a failure result", async () => {
    const docker = makeRealStagingDocker({ command: "/nonexistent-binary-xyz" });
    const res = await docker(["anything"]);
    expect(res.code).not.toBe(0);
    expect(res.stderr.length).toBeGreaterThan(0);
  });
});
