// #995 — `rig scope <tier> approve` writes inside the DAEMON, against the
// daemon's own root, so a --workspace the daemon does not share used to send
// the stamp into the daemon's copy of the same relative path. These tests pin
// the refusal: nothing is written, in either tree.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";

import { scopeCommand } from "../src/commands/scope.js";

function mktemp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rig-approve-ws-"));
}

const SPEC = "---\nid: OPR.0.5.0\n---\n# release-0.5.0\n";

/** A workspace holding one mission at the same relative path as every other. */
function seedWorkspace(): { workRoot: string; missionsRoot: string; spec: string } {
  const workRoot = path.join(mktemp(), "work");
  const missionsRoot = path.join(workRoot, "missions");
  const missionDir = path.join(missionsRoot, "release-0.5.0");
  fs.mkdirSync(missionDir, { recursive: true });
  const spec = path.join(missionDir, "SPEC.md");
  fs.writeFileSync(spec, SPEC, "utf8");
  return { workRoot, missionsRoot, spec };
}

/** Drive the real commander tree, capturing output and the exit code. */
async function run(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdoutBuf: string[] = [];
  const stderrBuf: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  const origErrWrite = process.stderr.write.bind(process.stderr);
  const origExit = process.exit;
  let exitCode = 0;
  process.stdout.write = ((chunk: unknown) => { stdoutBuf.push(String(chunk)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => { stderrBuf.push(String(chunk)); return true; }) as typeof process.stderr.write;
  process.exit = ((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`__EXIT__${exitCode}`);
  }) as typeof process.exit;
  const program = new Command();
  program.addCommand(scopeCommand());
  program.exitOverride();
  try {
    await program.parseAsync(["node", "rig", "scope", ...args]);
  } catch (err) {
    const msg = (err as Error).message ?? "";
    if (!msg.startsWith("__EXIT__")) stderrBuf.push(msg + "\n");
  } finally {
    process.stdout.write = origWrite;
    process.stderr.write = origErrWrite;
    process.exit = origExit;
  }
  return { exitCode, stdout: stdoutBuf.join(""), stderr: stderrBuf.join("") };
}

describe("scope approve honours the daemon's workspace (#995)", () => {
  let daemon: ReturnType<typeof seedWorkspace>;
  let other: ReturnType<typeof seedWorkspace>;

  beforeEach(() => {
    daemon = seedWorkspace();
    other = seedWorkspace();
    // The config the daemon reads: its workspace, not the one passed below.
    const home = mktemp();
    fs.writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({ workspace: { slicesRoot: daemon.missionsRoot } }),
      "utf8",
    );
    vi.stubEnv("OPENRIG_HOME", home);
    vi.stubEnv("OPENRIG_WORK_ROOT", "");
    // The approver is derived from the seat env; without it approve refuses earlier.
    vi.stubEnv("OPENRIG_SESSION_NAME", "test-seat");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("refuses a --workspace that is not the daemon's, and writes nothing", async () => {
    const r = await run(["--workspace", other.workRoot, "mission", "approve", "release-0.5.0", "--scope", "delivery"]);

    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain(other.missionsRoot);
    expect(r.stderr).toContain(daemon.missionsRoot);
    expect(r.stderr).toContain("Nothing was written.");
    // The defect this pins: the stamp used to land in the daemon's copy of the
    // same relative path, while the command reported success.
    expect(fs.readFileSync(daemon.spec, "utf8")).toBe(SPEC);
    expect(fs.readFileSync(other.spec, "utf8")).toBe(SPEC);
  });

  it("refuses an OPENRIG_WORK_ROOT override the daemon does not share", async () => {
    vi.stubEnv("OPENRIG_WORK_ROOT", other.workRoot);

    const r = await run(["mission", "approve", "release-0.5.0", "--scope", "delivery"]);

    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("is not the daemon's workspace");
    expect(fs.readFileSync(daemon.spec, "utf8")).toBe(SPEC);
    expect(fs.readFileSync(other.spec, "utf8")).toBe(SPEC);
  });

  it("passes the guard when --workspace names the daemon's own workspace", async () => {
    const r = await run(["--workspace", daemon.workRoot, "mission", "approve", "release-0.5.0", "--scope", "delivery"]);

    // The guard is cleared, so the command proceeds to the daemon-status check
    // and stops there (no daemon in a unit test) — never at the workspace.
    expect(r.stderr).not.toContain("is not the daemon's workspace");
    expect(r.stderr).toMatch(/daemon/i);
  });
});
