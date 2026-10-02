import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapCommand } from "../src/commands/bootstrap.js";
import { discoverCommand } from "../src/commands/discover.js";
import { workflowCommand } from "../src/commands/workflow.js";
import { workspaceCommand } from "../src/commands/workspace.js";
import { getDaemonStatus, type DaemonStatus, type LifecycleDeps } from "../src/daemon-lifecycle.js";

vi.mock("../src/daemon-lifecycle.js", async () => ({
  ...await vi.importActual<Record<string, unknown>>("../src/daemon-lifecycle.js"),
  getDaemonStatus: vi.fn(),
}));

beforeEach(() => { process.exitCode = undefined; });
afterEach(() => { vi.restoreAllMocks(); process.exitCode = undefined; });

const entries = [
  ["bootstrap", bootstrapCommand, ["./fixture.yaml", "--plan"]],
  ["discover", discoverCommand, []],
  ["workflow", workflowCommand, ["list"]],
  ["workspace", workspaceCommand, ["doctor"]],
] as const;

describe("command daemon status evidence", () => {
  for (const [name, makeCommand, args] of entries) {
    it.each<DaemonStatus>([{ state: "unverified" }, { state: "running", healthy: false }])(`${name} preserves inconclusive status instead of asserting down`, async (status) => {
      vi.mocked(getDaemonStatus).mockResolvedValue(status);
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const clientFactory = vi.fn();
      await makeCommand({ lifecycleDeps: {} as LifecycleDeps, clientFactory }).parseAsync(["node", "rig", ...args]);
      expect(error.mock.calls.flat().join("\n")).toContain("state not confirmed");
      expect(error.mock.calls.flat().join("\n")).not.toContain("Daemon not running.");
      expect(process.exitCode).toBe(1);
      expect(clientFactory).not.toHaveBeenCalled();
    });

    it(`${name} preserves positively stopped status`, async () => {
      vi.mocked(getDaemonStatus).mockResolvedValue({ state: "stopped" });
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const clientFactory = vi.fn();
      await makeCommand({ lifecycleDeps: {} as LifecycleDeps, clientFactory }).parseAsync(["node", "rig", ...args]);
      expect(error.mock.calls.flat().join("\n")).toContain("Daemon not running.");
      expect(process.exitCode).toBe(1);
      expect(clientFactory).not.toHaveBeenCalled();
    });

    it(`${name} retains the selected home and live-sibling diagnostic`, async () => {
      vi.mocked(getDaemonStatus).mockResolvedValue({ state: "unverified", siblingHint: { resolvedHome: "selected-home", siblingHome: "live-sibling" } });
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const clientFactory = vi.fn();
      await makeCommand({ lifecycleDeps: {} as LifecycleDeps, clientFactory }).parseAsync(["node", "rig", ...args]);
      expect(error.mock.calls.flat().join("\n")).toContain("resolved selected-home, live sibling live-sibling");
      expect(process.exitCode).toBe(1);
      expect(clientFactory).not.toHaveBeenCalled();
    });
  }
});
