import { afterEach, expect, it, vi } from "vitest";
import { environmentCommand } from "../src/commands/environment.js";
import { STATE_FILE, type LifecycleDeps } from "../src/daemon-lifecycle.js";
import type { EnvironmentCommandDeps } from "../src/commands/environment.js";

afterEach(() => vi.restoreAllMocks());
it.each([undefined, "generation-one"])("sends the explicit cleanup selection with generation %s", async generation => {
  const lifecycleDeps: LifecycleDeps = {
    spawn: vi.fn(), fetch: vi.fn(async () => ({ ok: true })), kill: vi.fn(() => true),
    readFile: vi.fn((path: string) => path === STATE_FILE ? JSON.stringify({ pid: 123, port: 7433, db: "test.sqlite", startedAt: "2026-04-20T00:00:00Z" }) : null),
    writeFile: vi.fn(), removeFile: vi.fn(), exists: vi.fn((path: string) => path === STATE_FILE),
    mkdirp: vi.fn(), openForAppend: vi.fn(() => 3), isProcessAlive: vi.fn(() => true),
  };
  const post = vi.fn(async () => ({ status: 200, data: { state: "confirmed" } }));
  const deps: EnvironmentCommandDeps = { lifecycleDeps, clientFactory: () => ({ post }) as never };
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  await environmentCommand(deps).parseAsync(["node", "rig", "effect", "binding-one", "--effect", "delete-owned", "--operation", "delete-one",
    ...(generation ? ["--generation", generation] : ["--resource-id", "compute-one"]), "--engine-socket", "/owned/engine.sock", "--json"]);
  expect(post).toHaveBeenCalledWith("/api/environments/binding-one/effect", {
    effect: "delete-owned", generation: generation ?? null, ...(generation ? {} : { resourceId: "compute-one" }), operationId: "delete-one", engineSocket: "/owned/engine.sock",
  }, { timeoutMs: 120_000 });
  expect(log).toHaveBeenCalled();
});
