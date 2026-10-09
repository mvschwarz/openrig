// #995 — `rig scope <tier> approve` writes inside the DAEMON, which used to
// resolve the relative scopePath against its OWN root: with a --workspace the
// daemon did not share, the stamp landed in the daemon's copy of the same
// relative path while the command reported success. The CLI now sends the root
// it resolved, and refuses an explicit override that names no missions tree.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";

vi.mock("../src/daemon-lifecycle.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../src/daemon-lifecycle.js");
  return {
    ...actual,
    getDaemonStatus: vi.fn(async () => ({ state: "running", healthy: true, pid: 1234, port: 7433 })),
    getDaemonUrl: vi.fn(() => "http://localhost:7433"),
  };
});

const posted: Array<{ path: string; body: Record<string, unknown> }> = [];

vi.mock("../src/client.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../src/client.js");
  return {
    ...actual,
    DaemonClient: class {
      async post<T>(p: string, body: Record<string, unknown>): Promise<{ status: number; data: T }> {
        posted.push({ path: p, body });
        return {
          status: 201,
          data: {
            scopeTier: "mission",
            scopeId: "OPR.0.5.0",
            scopePath: String(body.scopePath),
            approvalScope: "delivery",
            approvedBy: "test-seat",
            approvedAt: "2026-10-08T00:00:00.000Z",
            onBehalfOf: null,
            actionId: "act-1",
          } as T,
        };
      }
    },
  };
});

const { scopeCommand } = await import("../src/commands/scope.js");

function mktemp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rig-approve-ws-"));
}

/** A workspace holding one mission at the same relative path as every other. */
function seedWorkspace(): { workRoot: string; missionsRoot: string } {
  const workRoot = path.join(mktemp(), "work");
  const missionDir = path.join(workRoot, "missions", "release-0.5.0");
  fs.mkdirSync(missionDir, { recursive: true });
  fs.writeFileSync(path.join(missionDir, "SPEC.md"), "---\nid: OPR.0.5.0\n---\n# release-0.5.0\n", "utf8");
  return { workRoot, missionsRoot: path.join(workRoot, "missions") };
}

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

describe("scope approve sends the resolved missions root (#995)", () => {
  let daemonWs: ReturnType<typeof seedWorkspace>;
  let otherWs: ReturnType<typeof seedWorkspace>;

  beforeEach(() => {
    posted.length = 0;
    daemonWs = seedWorkspace();
    otherWs = seedWorkspace();
    const home = mktemp();
    fs.writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({ workspace: { slicesRoot: daemonWs.missionsRoot } }),
      "utf8",
    );
    vi.stubEnv("OPENRIG_HOME", home);
    vi.stubEnv("OPENRIG_WORK_ROOT", "");
    vi.stubEnv("OPENRIG_SESSION_NAME", "test-seat");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("sends the --workspace tree's root, not the daemon's", async () => {
    const r = await run(["--workspace", otherWs.workRoot, "mission", "approve", "release-0.5.0", "--scope", "delivery"]);

    expect(r.exitCode).toBe(0);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.path).toBe("/api/scope/approve");
    expect(posted[0]!.body.missionsRoot).toBe(otherWs.missionsRoot);
    expect(posted[0]!.body.scopePath).toBe("release-0.5.0");
  });

  it("sends the configured root when no workspace is named", async () => {
    const r = await run(["mission", "approve", "release-0.5.0", "--scope", "delivery"]);

    expect(r.exitCode).toBe(0);
    expect(posted[0]!.body.missionsRoot).toBe(daemonWs.missionsRoot);
  });

  it("sends an OPENRIG_WORK_ROOT override's root", async () => {
    vi.stubEnv("OPENRIG_WORK_ROOT", otherWs.workRoot);

    await run(["mission", "approve", "release-0.5.0", "--scope", "delivery"]);

    expect(posted[0]!.body.missionsRoot).toBe(otherWs.missionsRoot);
  });

  it("refuses a named workspace with no missions tree instead of stamping the configured one", async () => {
    const empty = mktemp();

    const r = await run(["--workspace", empty, "mission", "approve", "release-0.5.0", "--scope", "delivery"]);

    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("has no missions tree");
    expect(posted).toHaveLength(0);
  });
});
