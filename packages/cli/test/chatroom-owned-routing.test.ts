import { afterEach, expect, it, vi } from "vitest";
import { Command } from "commander";
import { createTerminalCommandSession } from "@openrig/daemon/terminal-cleanup";
import { chatroomCommand } from "../src/commands/chatroom.js";
import { getOpenRigHome } from "../src/openrig-compat.js";
import type { StatusDeps } from "../src/commands/status.js";
import type { DaemonClient } from "../src/client.js";

vi.mock("@openrig/daemon/terminal-cleanup", () => ({ createTerminalCommandSession: vi.fn(async () => "$7") }));
vi.mock("../src/daemon-lifecycle.js", async () => ({ ...await vi.importActual("../src/daemon-lifecycle.js"),
  getDaemonStatus: vi.fn(async () => ({ state: "running", healthy: true, pid: 1, port: 17439 })),
  getDaemonUrl: vi.fn(() => "http://127.0.0.1:17439"),
}));
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); process.exitCode = undefined; });

it.each([true, false])("creates a watcher only on the confirmed selected instance (local=%s)", async local => {
  const rig = "owned|用户", url = "http://127.0.0.1:17439", command = ["C:/owned tools/mux.exe", "--prefix"], serverArgs = ["-L", "owned"];
  const client = { baseUrl: url, isLocalInstance: vi.fn(async () => local), get: vi.fn(async (route: string) => ({ status: 200,
    data: route === "/api/rigs/summary" ? [{ id: "owned-rig", name: rig }] : { tmux: { command, serverArgs } } })) };
  const deps = { lifecycleDeps: {}, clientFactory: () => client as unknown as DaemonClient } as StatusDeps;
  const log = vi.spyOn(console, "log").mockImplementation(() => {}); vi.spyOn(console, "error").mockImplementation(() => {});
  await new Command().addCommand(chatroomCommand(deps)).parseAsync(["node", "rig", "chatroom", "watch", rig, "--tmux"]);
  if (local) {
    expect(createTerminalCommandSession).toHaveBeenCalledExactlyOnceWith("chatroom@" + rig,
      [process.execPath, expect.stringMatching(/chatroom-watch-child\.js$/), getOpenRigHome(), url, rig], serverArgs, command);
    expect(log.mock.calls.flat().join("\n")).toContain("Started watch");
  } else {
    expect(createTerminalCommandSession).not.toHaveBeenCalled(); expect(process.exitCode).toBe(1);
  }
});
