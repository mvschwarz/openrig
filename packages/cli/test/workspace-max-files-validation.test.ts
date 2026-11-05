// release-0.3.2 slice 01 BC repair — HG-6 discriminators.
// Verifies that `rig workspace validate --max-files <garbage>` rejects
// CLI-side with a 3-part error AND does NOT call the daemon. Matches
// the guard BC-1 fix recipe.

import { describe, expect, it, vi } from "vitest";
import { workspaceCommand, parseMaxFilesStrict, type WorkspaceDeps } from "../src/commands/workspace.js";
import type { LifecycleDeps } from "../src/daemon-lifecycle.js";

vi.mock("../src/daemon-lifecycle.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    "../src/daemon-lifecycle.js",
  );
  return {
    ...actual,
    getDaemonStatus: vi.fn(async () => ({
      state: "running",
      healthy: true,
      pid: 1234,
      port: 7433,
    })),
    getDaemonUrl: vi.fn(() => "http://localhost:7433"),
  };
});

function captureStdout(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  return { logs, restore: () => { console.log = original; } };
}

function captureStderr(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: unknown) => { logs.push(String(chunk)); return true; }) as typeof process.stderr.write;
  return { logs, restore: () => { process.stderr.write = original; } };
}

function fakeRunningDeps(post: ReturnType<typeof vi.fn>): WorkspaceDeps {
  return {
    lifecycleDeps: {} as LifecycleDeps,
    clientFactory: () => ({
      post,
      get: vi.fn(),
      postText: vi.fn(),
    }) as unknown as ReturnType<WorkspaceDeps["clientFactory"]>,
  };
}

describe("parseMaxFilesStrict — pure helper", () => {
  it("accepts positive integers", () => {
    expect(parseMaxFilesStrict("1")).toBe(1);
    expect(parseMaxFilesStrict("12")).toBe(12);
    expect(parseMaxFilesStrict("10000")).toBe(10000);
  });
  it("rejects garbage tails (BC-1 root cause)", () => {
    expect(() => parseMaxFilesStrict("12abc")).toThrow(/positive integer/);
  });
  it("rejects non-numeric input", () => {
    expect(() => parseMaxFilesStrict("abc")).toThrow(/positive integer/);
    expect(() => parseMaxFilesStrict("")).toThrow(/positive integer/);
  });
  it("rejects zero and negatives", () => {
    expect(() => parseMaxFilesStrict("0")).toThrow(/positive integer/);
    expect(() => parseMaxFilesStrict("-1")).toThrow(/positive integer/);
  });
  it("3-part error carries fact + consequence + action fields", () => {
    try {
      parseMaxFilesStrict("12abc");
      throw new Error("should have thrown");
    } catch (err) {
      const e = err as Error & { fact?: string; consequence?: string; action?: string };
      expect(e.fact).toMatch(/positive integer/);
      expect(e.consequence).toMatch(/did not run/);
      expect(e.action).toMatch(/Pass a positive integer/);
    }
  });
});

describe("rig workspace validate --max-files — CLI-side discriminator (BLOCK 1)", () => {
  it("rejects '12abc' with --json: exit=1, body.error has fact/consequence/action, client.post NOT called", async () => {
    const post = vi.fn();
    const deps = fakeRunningDeps(post);
    const out = captureStdout();
    const originalExitCode = process.exitCode;
    process.exitCode = 0;
    const root = workspaceCommand(deps);
    await root.parseAsync(["node", "rig", "validate", "/tmp/ws", "--max-files", "12abc", "--json"]);
    out.restore();
    const exitCode = process.exitCode;
    process.exitCode = originalExitCode;
    expect(exitCode).toBe(1);
    expect(post).not.toHaveBeenCalled();
    const joined = out.logs.join("\n");
    const parsed = JSON.parse(joined);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.fact).toMatch(/positive integer/);
    expect(parsed.error.consequence).toMatch(/did not run/);
    expect(parsed.error.action).toMatch(/--max-files/);
  });

  it("rejects 'abc', '0', '-1' equivalently", async () => {
    for (const bad of ["abc", "0", "-1"]) {
      const post = vi.fn();
      const deps = fakeRunningDeps(post);
      const out = captureStdout();
      const root = workspaceCommand(deps);
      const originalExitCode = process.exitCode;
      process.exitCode = 0;
      await root.parseAsync(["node", "rig", "validate", "/tmp/ws", "--max-files", bad, "--json"]);
      out.restore();
      const exitCode = process.exitCode;
      process.exitCode = originalExitCode;
      expect(exitCode, `--max-files ${bad} should fail`).toBe(1);
      expect(post, `--max-files ${bad} must not call the daemon`).not.toHaveBeenCalled();
    }
  });

  it("emits 3-part error to stderr in human mode (no --json)", async () => {
    const post = vi.fn();
    const deps = fakeRunningDeps(post);
    const err = captureStderr();
    const originalExitCode = process.exitCode;
    process.exitCode = 0;
    const root = workspaceCommand(deps);
    await root.parseAsync(["node", "rig", "validate", "/tmp/ws", "--max-files", "12abc"]);
    err.restore();
    const exitCode = process.exitCode;
    process.exitCode = originalExitCode;
    expect(exitCode).toBe(1);
    expect(post).not.toHaveBeenCalled();
    const joined = err.logs.join("");
    expect(joined).toMatch(/Error:.*positive integer/);
    expect(joined).toMatch(/did not run/);
    expect(joined).toMatch(/Pass a positive integer/);
  });

  // Positive case is covered by parseMaxFilesStrict pure-helper test
  // above ("accepts positive integers"); driving end-to-end here
  // requires stubbing the daemon-status check too, which is covered
  // by the daemon-lifecycle adopt/expand test pattern (out of scope
  // for this BC discriminator).
});

describe("rig workspace validate daemon error reporting", () => {
  it("prints daemon refusal message as a single readable stderr line in human mode", async () => {
    const post = vi.fn(async () => ({
      status: 400,
      data: {
        error: "invalid_workspace_kind",
        message: "workspaceKind must be one of: user, project, knowledge, lab, delivery",
      },
    }));
    const deps = fakeRunningDeps(post);
    const errors: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    const origExit = process.exitCode;
    process.exitCode = 0;
    try {
      const root = workspaceCommand(deps);
      await root.parseAsync(["node", "rig", "validate", "/tmp/ws", "--kind", "invalid"]);
      expect(post).toHaveBeenCalledWith(
        "/api/workspace/validate",
        expect.objectContaining({ workspaceKind: "invalid" }),
      );
      expect(process.exitCode).toBe(1);
      expect(errors).toEqual(["workspaceKind must be one of: user, project, knowledge, lab, delivery"]);
    } finally {
      console.error = origError;
      process.exitCode = origExit;
    }
  });

  it("prints raw JSON on stderr when daemon refuses and --json is set", async () => {
    const refusal = {
      error: "invalid_workspace_kind",
      message: "workspaceKind must be one of: user, project, knowledge, lab, delivery",
    };
    const post = vi.fn(async () => ({
      status: 400,
      data: refusal,
    }));
    const deps = fakeRunningDeps(post);
    const errors: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    const origExit = process.exitCode;
    process.exitCode = 0;
    try {
      const root = workspaceCommand(deps);
      await root.parseAsync(["node", "rig", "validate", "/tmp/ws", "--kind", "invalid", "--json"]);
      expect(post).toHaveBeenCalledWith(
        "/api/workspace/validate",
        expect.objectContaining({ workspaceKind: "invalid" }),
      );
      expect(process.exitCode).toBe(1);
      expect(errors).toEqual([JSON.stringify(refusal, null, 2)]);
    } finally {
      console.error = origError;
      process.exitCode = origExit;
    }
  });
});
