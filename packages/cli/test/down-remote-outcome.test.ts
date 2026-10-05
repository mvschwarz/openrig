import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { Command } from "commander";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DaemonClient } from "../src/client.js";
import { downCommand } from "../src/commands/down.js";
import type { StatusDeps } from "../src/commands/status.js";
import type { RemoteHostDeps } from "../src/remote-host-ops.js";
import { downRoutes } from "../../daemon/src/routes/down.js";

describe("remote down operation outcomes", () => {
  let server: ReturnType<typeof serve>;
  let url: string;
  let outcome = {};

  beforeAll(async () => {
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("teardownOrchestrator" as never, { teardown: async () => outcome } as never);
      c.set("rigRepo" as never, {
        getRig: () => ({ rig: { name: "owned-rig" } }),
        findRigsByName: () => [{ id: "owned-rig-id" }],
      } as never);
      await next();
    });
    app.get("/api/ps", c => c.json([{ rigId: "owned-rig-id", name: "owned-rig" }]));
    app.route("/api/down", downRoutes);
    server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
    if (!server.listening) await new Promise<void>(resolve => server.once("listening", resolve));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });

  for (const json of [false, true]) {
    for (const testCase of [
      { label: "clean stop", errors: [], alreadyStopped: false, deleted: false, expected: undefined },
      { label: "snapshot failure", errors: ["Snapshot failed: disk full"], alreadyStopped: false, deleted: false, expected: 2 },
      { label: "failed session kill", errors: ["Kill failed for session 'owned-rig-agent': timeout"], alreadyStopped: false, deleted: false, expected: 2 },
      { label: "already stopped", errors: [], alreadyStopped: true, deleted: false, expected: 1 },
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
        } finally {
          process.exitCode = originalExit;
          log.mockRestore();
          error.mockRestore();
        }
      });
    }
  }
});
