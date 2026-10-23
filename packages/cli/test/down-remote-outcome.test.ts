import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { Command } from "commander";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DaemonClient } from "../src/client.js";
import { downCommand } from "../src/commands/down.js";
import type { StatusDeps } from "../src/commands/status.js";
import type { RemoteHostDeps } from "../src/remote-host-ops.js";
import { downRoutes } from "../../daemon/src/routes/down.js";

describe("remote down operation outcomes", () => {
  let server: ReturnType<typeof serve>;
  let url: string;
  let outcome = {};
  let noticeAtTeardown = "";
  let callerRig: string | null = null;
  let teardownCalls = 0;

  beforeEach(() => { callerRig = null; teardownCalls = 0; });
  afterEach(() => { vi.unstubAllEnvs(); });

  beforeAll(async () => {
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("teardownOrchestrator" as never, { teardown: async () => { teardownCalls++; noticeAtTeardown = String(vi.mocked(console.error).mock.calls.at(-1)?.[0] ?? ""); return outcome; } } as never);
      c.set("rigRepo" as never, {
        getRig: () => ({ rig: { name: "owned-rig" } }),
        findRigsByName: () => [{ id: "owned-rig-id" }],
      } as never);
      await next();
    });
    app.get("/api/ps", c => c.json([{ rigId: "owned-rig-id", name: "owned-rig" }]));
    app.get("/api/whoami", c => callerRig
      ? c.json({ identity: { rigId: callerRig, attachmentType: "tmux" } })
      : c.json({ error: "unknown seat" }, 404));
    app.get("/api/rigs/owned-rig-id/nodes", c => c.json([
      { logicalId: "lead", canonicalSessionName: "lead@owned-rig", nodeKind: "agent", sessionStatus: "running", activityState: { display: "working" } },
    ]));
    app.route("/api/down", downRoutes);
    server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
    if (!server.listening) await new Promise<void>(resolve => server.once("listening", resolve));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });

  it("asks before stopping a resolved caller's rig over --host and preserves the host in the proceed command", async () => {
    vi.stubEnv("OPENRIG_NODE_ID", "caller-node-id");
    vi.stubEnv("OPENRIG_SESSION_NAME", "lead@owned-rig");
    callerRig = "owned-rig-id";
    const deps: StatusDeps & Pick<RemoteHostDeps, "hostRegistryLoader"> = {
      lifecycleDeps: { readFile: () => null } as StatusDeps["lifecycleDeps"],
      clientFactory: baseUrl => new DaemonClient(baseUrl),
      hostRegistryLoader: () => ({ ok: true, registry: { hosts: [{ id: "owned-host", transport: "http", url }] } }),
    };
    const originalExit = process.exitCode;
    const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    process.exitCode = undefined;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await downCommand(deps).parseAsync(["owned-rig", "--host", "owned-host", "--json"], { from: "user" });
      expect(teardownCalls).toBe(0);
      expect(process.exitCode).toBe(1);
      const result = JSON.parse(String(log.mock.calls[0]?.[0]));
      expect(result.error.code).toBe("own_rig_confirmation_required");
      expect(result.error.action).toContain("--host 'owned-host'");
      expect(result.error.action).toContain("--yes");
    } finally {
      process.exitCode = originalExit;
      if (stdinTTY) Object.defineProperty(process.stdin, "isTTY", stdinTTY);
      else delete (process.stdin as { isTTY?: boolean }).isTTY;
      log.mockRestore();
    }
  });

  it("stops a remote namesake rig without asking when the local caller has only a session name", async () => {
    vi.stubEnv("OPENRIG_NODE_ID", "");
    vi.stubEnv("RIGGED_NODE_ID", "");
    vi.stubEnv("OPENRIG_SESSION_NAME", "lead@owned-rig");
    // The remote host has a different seat with the same rig/session names as the local caller.
    callerRig = "owned-rig-id";
    outcome = { rigId: "owned-rig-id", sessionsKilled: 1, errors: [] };
    const ask = vi.fn(async () => false);
    const deps: StatusDeps & Pick<RemoteHostDeps, "hostRegistryLoader"> & { promptYesNo: typeof ask } = {
      lifecycleDeps: { readFile: () => null } as StatusDeps["lifecycleDeps"],
      clientFactory: baseUrl => new DaemonClient(baseUrl),
      hostRegistryLoader: () => ({ ok: true, registry: { hosts: [{ id: "other-host", transport: "http", url }] } }),
      promptYesNo: ask,
    };
    const originalExit = process.exitCode;
    process.exitCode = undefined;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await downCommand(deps).parseAsync(["owned-rig", "--host", "other-host", "--json"], { from: "user" });
      expect(ask).not.toHaveBeenCalled();
      expect(teardownCalls).toBe(1);
      expect(process.exitCode).toBeUndefined();
      expect(JSON.parse(String(log.mock.calls[0]?.[0]))).not.toHaveProperty("warning");
    } finally {
      process.exitCode = originalExit;
      log.mockRestore();
      error.mockRestore();
    }
  });

  for (const json of [false, true]) {
    for (const testCase of [
      { label: "clean stop", errors: [], alreadyStopped: false, deleted: false, expected: undefined },
      { label: "snapshot failure", errors: ["Snapshot failed: disk full"], alreadyStopped: false, deleted: false, expected: 2 },
      { label: "failed session kill", errors: ["Kill failed for session 'owned-rig-agent': timeout"], alreadyStopped: false, deleted: false, expected: 2 },
      { label: "already stopped", errors: [], alreadyStopped: true, deleted: false, expected: undefined },
      { label: "already stopped and deleted", errors: [], alreadyStopped: true, deleted: true, expected: undefined },
    ]) {
      it(`${testCase.label} reports the operation exit code (${json ? "JSON" : "human"})`, async () => {
        outcome = {
          rigId: "owned-rig-id", sessionsKilled: 0, snapshotId: null,
          deleteBlocked: false, errors: testCase.errors,
          alreadyStopped: testCase.alreadyStopped, deleted: testCase.deleted,
        };
        const deps: StatusDeps & Pick<RemoteHostDeps, "hostRegistryLoader"> = {
          lifecycleDeps: { readFile: () => null } as StatusDeps["lifecycleDeps"],
          clientFactory: baseUrl => new DaemonClient(baseUrl),
          hostRegistryLoader: () => ({
            ok: true,
            registry: { hosts: [{ id: "owned-host", transport: "http", url }] },
          }),
        };
        const command = new Command();
        command.exitOverride();
        command.addCommand(downCommand(deps));
        const originalExit = process.exitCode;
        process.exitCode = undefined;
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        try {
          await command.parseAsync(["down", "owned-rig", "--host", "owned-host", ...(json ? ["--json"] : [])], { from: "user" });
          expect(process.exitCode).toBe(testCase.expected);
          const printed = JSON.parse(String(log.mock.calls[0]?.[0]));
          // Preserve the remote wrapper contract; transport success still means
          // the HTTP request succeeded, even when teardown reports partial work.
          expect(json ? printed.data.errors : printed.errors).toEqual(testCase.errors);
          if (json) expect(printed.ok).toBe(true);
          expect(noticeAtTeardown).toBe(json ? "" : "Before stopping owned-rig-id: recorded agent sessions: lead@owned-rig (activity: working).");
        } finally {
          process.exitCode = originalExit;
          log.mockRestore();
          error.mockRestore();
        }
      });
    }
  }
});
