import { afterEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { environmentCommand } from "../src/commands/environment.js";
import { DaemonClient } from "../src/client.js";
import { STATE_FILE, type LifecycleDeps } from "../src/daemon-lifecycle.js";
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(), spawn: vi.fn() }));
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); process.exitCode = undefined; });
it.each(["generation-one", "changed-generation"])("the viewer bounds its one live lookup and never repeats full projection validation: %s", async generation => {
  vi.useFakeTimers();
  const paths: string[] = [];
  const client = new DaemonClient("http://127.0.0.1:1", { sessionName: "worker@test", ownerProbe: async () => ({ state: "unknown" }) as never,
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      paths.push(String(url));
      await new Promise<void>((resolve, reject) => { const timer = setTimeout(resolve, 6000);
        init?.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(init.signal?.reason); }, { once: true }); });
      return new Response(JSON.stringify({ generation, placement: { gateway: "gateway", workspace: "workspace", name: "worker" } }), { status: 200 });
    }) as typeof fetch });
  const lifecycleDeps: LifecycleDeps = { spawn: vi.fn(), fetch: vi.fn(async () => ({ ok: true })), kill: vi.fn(() => true),
    readFile: vi.fn((path: string) => path === STATE_FILE ? JSON.stringify({ pid: 123, port: 7433, db: "test.sqlite", startedAt: "2026-04-20T00:00:00Z" }) : null),
    writeFile: vi.fn(), removeFile: vi.fn(), exists: vi.fn((path: string) => path === STATE_FILE), mkdirp: vi.fn(), openForAppend: vi.fn(() => 3), isProcessAlive: vi.fn(() => true) };
  vi.mocked(spawn).mockImplementation(() => { const child = new EventEmitter(); queueMicrotask(() => child.emit("exit", 0)); return child as ReturnType<typeof spawn>; });
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const run = environmentCommand({ lifecycleDeps, clientFactory: () => client }).parseAsync(["node", "rig", "connect", "binding-one", "--generation", "generation-one"]);
  await vi.advanceTimersByTimeAsync(6500); await run;
  expect(paths).toEqual(["http://127.0.0.1:1/api/environments/binding-one?live=true"]);
  if (generation === "generation-one") { expect(errors).not.toHaveBeenCalled(); expect(spawn).toHaveBeenCalledTimes(1); }
  else { expect(spawn).not.toHaveBeenCalled(); expect(errors).toHaveBeenCalledWith(expect.stringContaining("generation")); }
});
