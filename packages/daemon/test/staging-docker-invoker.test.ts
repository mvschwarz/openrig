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

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it, expect } from "vitest";
import { makeRealStagingDocker } from "./helpers/staging-docker-invoker.js";

/** True once no process with this pid exists (an unreaped zombie still counts as alive, so poll
 *  briefly: the orphan is reparented and reaped by init or a subreaper). */
async function gone(pid: number, withinMs = 2000): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ESRCH") return true;
      throw err;
    }
    if (Date.now() > deadline) return false;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
}

/** A step whose shell leaves a DESCENDANT holding its stdio: `sleep` runs in the background (so it
 *  is a grandchild of the invoker on every shell) and records its pid for the survival check. */
function descendantScript(pidFile: string): string {
  return `sleep 30 & echo $! > '${pidFile}'; wait`;
}

/** Wait until every pid file exists and holds a pid (the step's descendants are running). */
async function waitForPidFiles(pidFiles: string[], withinMs = 10_000): Promise<void> {
  const deadline = Date.now() + withinMs;
  const ready = (file: string) => fs.existsSync(file) && /^\d+\s*$/.test(fs.readFileSync(file, "utf8"));
  while (!pidFiles.every(ready)) {
    if (Date.now() > deadline) throw new Error(`descendants never started: ${pidFiles.filter((f) => !ready(f)).join(", ")}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
}

/** Pids recorded in the pid files that still exist. Every survivor is SIGKILLed BEFORE the caller
 *  asserts, so a failing check never leaks a process past the test. */
async function reapSurvivors(pidFiles: string[]): Promise<number[]> {
  const survivors: number[] = [];
  for (const file of pidFiles) {
    if (!fs.existsSync(file)) continue;
    const pid = Number(fs.readFileSync(file, "utf8").trim());
    if (pid > 0 && !(await gone(pid))) survivors.push(pid);
  }
  for (const pid of survivors) {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
  return survivors;
}

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

  it("step timeout kills the step's whole process tree: no descendant of either side survives", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "staging-invoker-"));
    const pidFiles = [path.join(dir, "consumer-descendant.pid"), path.join(dir, "producer-descendant.pid")];
    try {
      const docker = shInvoker(300);
      const res = await docker(["-c", descendantScript(pidFiles[0]!)], ["-c", descendantScript(pidFiles[1]!)]);
      expect(res.code).not.toBe(0);
      expect(res.stderr).toContain("timeout");
      await waitForPidFiles(pidFiles, 1000);
      expect(await reapSurvivors(pidFiles), "descendants that outlived the step").toEqual([]);
    } finally {
      await reapSurvivors(pidFiles); // a timeout or an earlier failure must not leak them either
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // An operator aborting a stalled step (Ctrl-C) signals the PARENT's process group. The steps run
  // in their own session, out of reach of that signal, so the invoker must take them down itself,
  // then leave the rest to the host: its own handler if it has one, otherwise the signal itself.
  //
  // host "none": the parent has no handler, so it must still die BY the signal.
  // host "once": the parent registered its own graceful `process.once(signal, …)` BEFORE the first
  // step (as packages/cli restore does). That shutdown must run to completion — its "done" marker
  // and exit code 3 — rather than be cut off by a re-raised signal.
  it.each([
    { trigger: "SIGINT", host: "none", expectCode: null, expectSignal: "SIGINT" },
    { trigger: "SIGTERM", host: "none", expectCode: null, expectSignal: "SIGTERM" },
    { trigger: "SIGHUP", host: "none", expectCode: null, expectSignal: "SIGHUP" },
    { trigger: "SIGQUIT", host: "none", expectCode: null, expectSignal: "SIGQUIT" },
    { trigger: "exit", host: "none", expectCode: 7, expectSignal: null },
    { trigger: "SIGINT", host: "once", expectCode: 3, expectSignal: null },
  ] as const)("parent $trigger mid-step (host handler: $host): no descendant of either side survives, parent ends as it would have", async ({ trigger, host, expectCode, expectSignal }) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "staging-invoker-parent-"));
    const pidFiles = [path.join(dir, "consumer-descendant.pid"), path.join(dir, "producer-descendant.pid")];
    const helperUrl = pathToFileURL(path.resolve(import.meta.dirname, "helpers/staging-docker-invoker.ts")).href;
    const parentSource = `
      const { makeRealStagingDocker } = await import(process.env.HELPER_URL);
      const [consumerScript, producerScript] = JSON.parse(process.env.STEP_SCRIPTS);
      const docker = makeRealStagingDocker({ command: "sh", tarCommand: "sh", stepTimeoutMs: 60000 });
      if (process.env.HOST_HANDLER === "once") {
        process.once(process.env.TRIGGER, () => {
          process.stdout.write("host graceful start\\n");
          setTimeout(() => { process.stdout.write("host graceful done\\n"); process.exit(3); }, 200);
        });
      }
      if (process.env.TRIGGER === "exit") {
        process.stdin.on("data", () => process.exit(7));
      }
      process.stdout.write("started\\n");
      await docker(["-c", consumerScript], ["-c", producerScript]);
      process.stdout.write("step returned\\n");
    `;
    // The parent leads its own process group, so the signal can be sent to the GROUP, as a
    // terminal's Ctrl-C is. `ulimit -c 0` then exec: a parent that dies by SIGQUIT (whose default
    // action dumps core) must never leave a core file behind.
    const parent = spawn("/bin/sh", ["-c", 'ulimit -c 0; exec "$@"', "sh",
      process.execPath, "--import", "tsx", "--input-type=module", "--eval", parentSource], {
      env: {
        ...process.env,
        HELPER_URL: helperUrl,
        TRIGGER: trigger,
        HOST_HANDLER: host,
        STEP_SCRIPTS: JSON.stringify(pidFiles.map(descendantScript)),
      },
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    let output = "";
    parent.stdout!.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    parent.stderr!.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveEnd) => {
      parent.on("close", (code, signal) => resolveEnd({ code, signal }));
    });
    try {
      await waitForPidFiles(pidFiles).catch((err: Error) => { throw new Error(`${err.message}; parent said: ${output}`); });
      if (trigger === "exit") parent.stdin!.write("go\n");
      else process.kill(-parent.pid!, trigger);
      const end = await Promise.race([
        ended,
        new Promise<never>((_, rejectEnd) => setTimeout(() => rejectEnd(new Error(`parent did not end: ${output}`)), 10_000)),
      ]);
      const survivors = await reapSurvivors(pidFiles);
      expect(survivors, `descendants that outlived the parent (${output.trim()})`).toEqual([]);
      expect(end, output).toEqual({ code: expectCode, signal: expectSignal });
      if (host === "once") expect(output).toContain("host graceful done");
    } finally {
      try { process.kill(-parent.pid!, "SIGKILL"); } catch { /* already gone */ }
      await reapSurvivors(pidFiles);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

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
