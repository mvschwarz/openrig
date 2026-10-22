import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { uiCommand } from "../src/commands/ui.js";
import { openMissionControl } from "../src/front-door.js";
import { Command } from "commander";
import { DaemonClient, ForeignLocalDaemonError } from "../src/client.js";
import { readLiveLogicalIds } from "../src/commands/doctor.js";
import { chatroomCommand } from "../src/commands/chatroom.js";
import { waitForKernelReady, type LifecycleDeps } from "../src/daemon-lifecycle.js";

vi.mock("node:child_process", async () => ({
  ...await vi.importActual<typeof import("node:child_process")>("node:child_process"),
  spawn: vi.fn(() => { throw new Error("unexpected TUI spawn"); }),
}));

const foreign = { state: "foreign" as const, pid: 42, uid: 502, callerUid: 501 };
const base = "http://127.0.0.1:43219";
beforeEach(() => {
  vi.stubEnv("OPENRIG_URL", ""); vi.stubEnv("RIGGED_URL", "");
  vi.stubEnv("OPENRIG_SESSION_NAME", ""); vi.stubEnv("RIGGED_SESSION_NAME", "");
  vi.stubEnv("OPENRIG_TRANSPORT_LOCAL_USER_GUARD", "true");
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); process.exitCode = undefined; });
describe("raw CLI daemon readers use the shared owner check", () => {
  it("doctor cannot fetch topology on positive foreign ownership", async () => {
    const requests = vi.spyOn(globalThis, "fetch");
    const instance = new DaemonClient(base, { ownerProbe: async () => foreign });
    await expect(readLiveLogicalIds(base, "fixture", instance)).rejects.toThrow(/different OS user/);
    expect(requests).not.toHaveBeenCalled();
  });
  it("doctor unknown evidence keeps the real two-read topology result", async () => {
    const requests = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: "rig-id", name: "fixture" }])))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ logicalId: "dev.worker" }])));
    const probe = vi.fn(async () => ({ state: "unknown" as const, reason: "old_health" }));
    expect(await readLiveLogicalIds(base, "fixture", new DaemonClient(base, { ownerProbe: probe }))).toEqual(["dev.worker"]);
    expect(requests).toHaveBeenCalledTimes(2); expect(probe).toHaveBeenCalledTimes(2);
  });
  it("SSE rechecks after resolving the rig, so a changed listener receives no stream GET", async () => {
    const requests = vi.spyOn(globalThis, "fetch");
    const probe = vi.fn().mockResolvedValueOnce({ state: "same-user", pid: 42, uid: 501, callerUid: 501 }).mockResolvedValue(foreign);
    const instance = new DaemonClient(base, {
      ownerProbe: probe,
      fetchImpl: async () => new Response(JSON.stringify([{ id: "rig-id", name: "fixture" }])),
    });
    const deps = {
      lifecycleDeps: { exists: () => false, readFile: () => null, fetch: async () => ({ ok: true }) } as unknown as LifecycleDeps,
      clientFactory: () => instance,
    };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await new Command().addCommand(chatroomCommand(deps)).parseAsync(["node", "rig", "chatroom", "watch", "fixture"]);
    expect(process.exitCode).toBe(1); expect(err.mock.calls.flat().join(" ")).toMatch(/different OS user/);
    expect(probe).toHaveBeenCalledTimes(2); expect(requests).not.toHaveBeenCalled();
  });
  it("default UI opening refuses before its page probe or browser effect", async () => {
    vi.spyOn(DaemonClient.prototype, "assertLocalOwner").mockRejectedValue(new ForeignLocalDaemonError(base, foreign));
    const probeUi = vi.fn(); const exec = vi.fn();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await new Command().addCommand(uiCommand({
      lifecycleDeps: { exists: () => false, readFile: () => null, fetch: async () => ({ ok: true }) } as unknown as LifecycleDeps,
      probeUi, exec,
    })).parseAsync(["node", "rig", "ui", "open"]);
    expect(probeUi).not.toHaveBeenCalled(); expect(exec).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1); expect(err.mock.calls.flat().join(" ")).toMatch(/different OS user/);
  });
  it("default TUI opening refuses before spawning its child", async () => {
    vi.spyOn(DaemonClient.prototype, "assertLocalOwner").mockRejectedValue(new ForeignLocalDaemonError(base, foreign));
    const err = vi.fn(); const exit = vi.fn();
    await openMissionControl({ probeDaemon: async () => true, err, exit });
    expect(spawn).not.toHaveBeenCalled(); expect(exit).toHaveBeenCalledWith(1);
    expect(err.mock.calls.flat().join(" ")).toMatch(/different OS user/);
  });
  it("kernel polling reports the foreign owner without a business fetch or retry", async () => {
    const check = vi.spyOn(DaemonClient.prototype, "assertLocalOwner").mockRejectedValue(new ForeignLocalDaemonError(base, foreign));
    const requests = vi.spyOn(globalThis, "fetch");
    expect(await waitForKernelReady(base, 1000, 1)).toMatchObject({ ok: false, detail: expect.stringMatching(/different OS user/) });
    expect(check).toHaveBeenCalledTimes(1); expect(requests).not.toHaveBeenCalled();
  });
});
