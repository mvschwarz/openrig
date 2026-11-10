import { Command } from "commander";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { terminalCommand, type TerminalDeps } from "../src/commands/terminal.js";

vi.mock("../src/daemon-lifecycle.js", async () => ({
  ...await vi.importActual<Record<string, unknown>>("../src/daemon-lifecycle.js"),
  getDaemonStatus: vi.fn(async () => ({ state: "running", healthy: true, pid: 1234, port: 7433 })),
  getDaemonUrl: vi.fn(() => "http://localhost:7433"),
}));

// D#52: a kernel advisor held at an expired sign-in opened as a tile, and nothing said why it wasn't answering.
const ADVISOR_HELD = "Startup requires attention: Login expired · Please run /login";

function fixture(advisorNeedsAttention: boolean) {
  const get = vi.fn(async (url: string) => ({ status: 200, data:
    url === "/api/ps" ? [{ rigId: "k1", rigName: "kernel" }, { rigId: "o1", rigName: "other" }]
      : url === "/api/rigs/k1/nodes" ? [
        { canonicalSessionName: "advisor-lead@kernel", needsAttention: advisorNeedsAttention, startupStatus: advisorNeedsAttention ? "attention_required" : "ready",
          latestError: advisorNeedsAttention ? ADVISOR_HELD : null },
        { canonicalSessionName: "operator-agent@kernel", needsAttention: false, startupStatus: "ready", latestError: null },
      ]
      : null }));
  const post = vi.fn(async () => ({ status: 200, data: { provider: "herdr", ok: true,
    opened: ["operator-agent@kernel", "advisor-lead@kernel"], absent: [], degraded: [], pages: 2 } }));
  const deps: TerminalDeps = { lifecycleDeps: {} as TerminalDeps["lifecycleDeps"],
    clientFactory: () => ({ baseUrl: "http://localhost:7433", get, post }) as unknown as ReturnType<TerminalDeps["clientFactory"]> };
  return { get, post, run: (args: string[]) => new Command().addCommand(terminalCommand(deps)).parseAsync(["terminal", ...args], { from: "user" }) };
}

let logs: string[];
beforeEach(() => {
  logs = []; process.exitCode = undefined;
  vi.spyOn(console, "log").mockImplementation((...args) => logs.push(args.join(" ")));
});
afterEach(() => { process.exitCode = undefined; vi.restoreAllMocks(); });

it("names an opened seat waiting on a person, with the daemon's own reason, and keeps the open a success", async () => {
  const f = fixture(true);
  await f.run(["open", "kernel", "--provider", "herdr", "--json"]);
  const result = JSON.parse(logs[0]!);
  expect(result).toMatchObject({ ok: true, opened: ["operator-agent@kernel", "advisor-lead@kernel"] });
  expect(result.notes).toEqual([`advisor-lead@kernel is waiting on a person: ${ADVISOR_HELD}. Answer it in its tile, or read it with: rig capture advisor-lead@kernel`]);
  // Only the rigs the opened seats belong to are read.
  expect(f.get.mock.calls.map(([url]) => url)).toEqual(["/api/ps", "/api/rigs/k1/nodes"]);
  expect(process.exitCode).toBeUndefined();
});

it("shows the same line in the human output", async () => {
  await fixture(true).run(["open", "kernel", "--provider", "herdr"]);
  expect(logs.join("\n")).toContain(`  note: advisor-lead@kernel is waiting on a person: ${ADVISOR_HELD}. Answer it in its tile, or read it with: rig capture advisor-lead@kernel`);
});

it("adds nothing when no opened seat needs attention", async () => {
  await fixture(false).run(["open", "kernel", "--provider", "herdr", "--json"]);
  expect(JSON.parse(logs[0]!).notes).toBeUndefined();
});
