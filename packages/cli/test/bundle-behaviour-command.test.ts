import { afterEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { bundleCommand } from "../src/commands/bundle.js";
import { upCommand } from "../src/commands/up.js";
import { runRemoteHttpOp } from "../src/remote-host-ops.js";
import { DaemonClient } from "../src/client.js";
import { STATE_FILE, type LifecycleDeps } from "../src/daemon-lifecycle.js";

vi.mock("../src/host-selection.js", () => ({ resolveEffectiveHost: (host?: string) => host }));
vi.mock("../src/remote-host-ops.js", () => ({ runRemoteHttpOp: vi.fn() }));

afterEach(() => { vi.restoreAllMocks(); });

function runningDeps(client: DaemonClient) {
  const forbidden = vi.fn(() => { throw new Error("unexpected lifecycle mutation"); });
  const lifecycleDeps = {
    spawn: forbidden, fetch: vi.fn(async () => ({ ok: true })), kill: forbidden,
    readFile: vi.fn((p: string) => p === STATE_FILE ? JSON.stringify({ pid: 123, port: 8123, db: "test.sqlite", startedAt: "2026-01-01T00:00:00Z" }) : null),
    writeFile: forbidden, removeFile: forbidden, exists: vi.fn((p: string) => p === STATE_FILE),
    mkdirp: forbidden, openForAppend: forbidden, isProcessAlive: vi.fn(() => true),
  } as unknown as LifecycleDeps;
  return { lifecycleDeps, clientFactory: () => client, forbidden };
}

describe("bundle view at the real CLI command boundary", () => {
  it.each([
    { status: 201, expectedExit: undefined, plan: false },
    { status: 200, expectedExit: undefined, plan: true },
    { status: 409, expectedExit: 1, plan: false },
    { status: 500, expectedExit: 2, plan: false },
  ])("prints the diagnostic before one existing install request: $status / plan=$plan", async ({ status, expectedExit, plan }) => {
    const events: string[] = [];
    const stdout: string[] = [];
    const stderr: string[] = [];
    vi.spyOn(console, "log").mockImplementation(value => { stdout.push(String(value)); events.push("stdout"); });
    vi.spyOn(console, "error").mockImplementation(value => { stderr.push(String(value)); events.push("header"); });
    const client = new DaemonClient("http://127.0.0.1:8123");
    const post = vi.spyOn(client, "post").mockImplementation(async (url, body) => {
      events.push(url);
      if (url === "/api/bundles/inspect") throw new Error("description unavailable");
      expect(url).toBe("/api/bundles/install");
      expect(body).toMatchObject({ plan, bundlePath: "/tmp/example.rigbundle" });
      return { status, data: { status: status < 400 ? (plan ? "planned" : "completed") : "failed", retained: true } } as never;
    });
    const deps = runningDeps(client);
    const program = new Command().exitOverride();
    program.addCommand(bundleCommand(deps));
    const oldExit = process.exitCode;
    process.exitCode = undefined;
    try {
      await program.parseAsync(["node", "rig", "bundle", "install", "/tmp/example.rigbundle", "--target", "/tmp/destination", "--json", ...(plan ? ["--plan"] : [])]);
      expect(process.exitCode).toBe(expectedExit);
      expect(post.mock.calls.filter(([url]) => url === "/api/bundles/install")).toHaveLength(1);
      expect(events.indexOf("header")).toBeGreaterThanOrEqual(0);
      expect(events.indexOf("header")).toBeLessThan(events.indexOf("/api/bundles/install"));
      expect(stderr.join(" ")).toContain("Bundle view not generated");
      expect(stdout).toHaveLength(1);
      expect(JSON.parse(stdout[0]!)).toMatchObject({ retained: true });
      expect(deps.forbidden).not.toHaveBeenCalled();
    } finally { process.exitCode = oldExit; }
  });

  it.each([false, true])("keeps local bundle up on /api/up after a failed view (plan=%s)", async (plan) => {
    const events: string[] = [];
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => { events.push("header"); });
    const client = new DaemonClient("http://127.0.0.1:8123");
    const post = vi.spyOn(client, "post").mockImplementation(async url => {
      events.push(url);
      if (url === "/api/bundles/inspect") return { status: 500, data: { error: "view failed" } } as never;
      return { status: 409, data: { error: "original conflict", retained: true } } as never;
    });
    const deps = runningDeps(client);
    const program = new Command().exitOverride().addCommand(upCommand(deps));
    const oldExit = process.exitCode;
    process.exitCode = undefined;
    try {
      await program.parseAsync(["node", "rig", "up", "/tmp/example.rigbundle", "--json", ...(plan ? ["--plan"] : [])]);
      expect(events).toEqual(["/api/bundles/inspect", "header", "/api/up"]);
      expect(post.mock.calls[1]).toEqual([
        "/api/up", expect.objectContaining({ sourceRef: "/tmp/example.rigbundle", plan }),
        plan ? undefined : { timeoutMs: 120_000 },
      ]);
      expect(process.exitCode).toBe(1);
      expect(output).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toMatchObject({ retained: true });
      expect(deps.forbidden).not.toHaveBeenCalled();
    } finally { process.exitCode = oldExit; }
  });

  it("describes the selected-host archive on that host before preserving remote up", async () => {
    const events: string[] = [];
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => { events.push("header"); });
    vi.mocked(runRemoteHttpOp).mockImplementation(async (_host, _method, url) => {
      events.push(url);
      return url === "/api/bundles/inspect" ? { ok: false, failedStep: "remote-daemon-unreachable", error: "inspection unavailable" } : { ok: true, failedStep: "none", data: { retained: true } };
    });
    const deps = runningDeps(new DaemonClient("http://127.0.0.1:8123"));
    const program = new Command().exitOverride().addCommand(upCommand(deps));
    await program.parseAsync(["node", "rig", "up", "./remote.rigbundle", "--host", "selected", "--json"]);
    expect(events).toEqual(["/api/bundles/inspect", "header", "/api/up"]);
    expect(vi.mocked(runRemoteHttpOp).mock.calls[0]).toEqual([
      "selected", "POST", "/api/bundles/inspect", { bundlePath: "./remote.rigbundle" }, deps, expect.anything(),
    ]);
    expect(vi.mocked(runRemoteHttpOp).mock.calls[1]?.[3]).toMatchObject({ sourceRef: "./remote.rigbundle" });
    expect(output).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toMatchObject({ ok: true, data: { retained: true } });
    expect(deps.forbidden).not.toHaveBeenCalled();
  });

  it.each(["/tmp/rig.yaml", "existing-rig"])("does not inspect or print a bundle header for %s", async source => {
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = new DaemonClient("http://127.0.0.1:8123");
    vi.spyOn(client, "get").mockResolvedValue({ status: 200, data: [{ id: "existing", name: "existing-rig" }] } as never);
    const post = vi.spyOn(client, "post").mockResolvedValue({ status: 201, data: { status: "completed" } } as never);
    const program = new Command().exitOverride().addCommand(upCommand(runningDeps(client)));
    await program.parseAsync(["node", "rig", "up", source, "--existing", "--json"]);
    expect(post.mock.calls.map(([url]) => url)).toEqual(["/api/up"]);
    expect(error).not.toHaveBeenCalled();
    expect(output).toHaveBeenCalledTimes(1);
  });
});
