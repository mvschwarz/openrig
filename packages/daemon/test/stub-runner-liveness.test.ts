import { describe, it, expect, afterEach } from "vitest";
import { execFile, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Slice 51-01 items 6-8 — F1 keep-alive PIN (RED-first, ratified).
//
// The pane-hosted stub-runner must IDLE as the seat's live foreground process
// after printing READY (the daemon's liveness cross-check requires the pane NOT
// to fall back to a shell). `await new Promise(()=>{})` alone does NOT keep the
// Node event loop alive — no ref'd libuv handle — so the runner exits immediately
// and every stub `up` fails readiness. This pin spawns the REAL runner and asserts
// it is still alive well past t=5s, then exits cleanly on SIGTERM.

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = resolve(HERE, "../src/adapters/stub-runner.ts");

describe("stub-runner liveness (F1 keep-alive pin)", () => {
  let child: ChildProcess | undefined;
  let dir: string | undefined;
  afterEach(() => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    child = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("idles as a live foreground process past t=5s, then exits cleanly on SIGTERM", async () => {
    dir = mkdtempSync(join(tmpdir(), "stub-live-"));
    child = execFile("node", ["--import", "tsx", RUNNER,
      "--session-name", "dev-worker@t", "--cwd", dir, "--launch-id", "pin-1", "--posture", "floor"]);

    let exited = false;
    let exitInfo: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    child.on("exit", (code, signal) => { exited = true; exitInfo = { code, signal }; });

    // Still alive well past the point where the unfixed runner (drained event loop) exits (~t=1s).
    await new Promise((r) => setTimeout(r, 5500));
    expect(exited, "stub-runner must idle as the pane's foreground process, not exit after READY").toBe(false);

    // And it terminates cleanly when signalled (the exit path still works).
    child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 1500));
    expect(exited, "stub-runner must exit on SIGTERM").toBe(true);
    expect(exitInfo?.code === 0 || exitInfo?.signal === "SIGTERM").toBe(true);
  }, 20_000);
});
