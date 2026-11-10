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

function fixture(opts: { advisorNeedsAttention?: boolean; psStatus?: number; remote?: Array<{ seat: string; host: string }>; olderDaemon?: boolean } = {}) {
  const advisorHeld = opts.advisorNeedsAttention ?? true;
  const get = vi.fn(async (url: string) => url === "/api/ps"
    ? (opts.psStatus ? { status: opts.psStatus, data: { error: "busy" } } : { status: 200, data: [{ rigId: "k1", rigName: "kernel" }, { rigId: "o1", rigName: "other" }] })
    : url === "/api/rigs/k1/nodes" ? { status: 200, data: [
      { canonicalSessionName: "advisor-lead@kernel", needsAttention: advisorHeld, startupStatus: advisorHeld ? "attention_required" : "ready",
        latestError: advisorHeld ? ADVISOR_HELD : null },
      { canonicalSessionName: "operator-agent@kernel", needsAttention: false, startupStatus: "ready", latestError: null },
    ] }
    : { status: 404, data: null });
  const post = vi.fn(async () => ({ status: 200, data: { provider: "herdr", ok: true,
    // A current daemon always says which opened seats are remote (an empty list: all local); an older one doesn't.
    opened: ["operator-agent@kernel", "advisor-lead@kernel"], ...(opts.olderDaemon ? {} : { remote: opts.remote ?? [] }), absent: [], degraded: [], pages: 2 } }));
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

it("names an opened seat that needs attention, with the daemon's reason, and keeps the open a success", async () => {
  const f = fixture();
  await f.run(["open", "kernel", "--provider", "herdr", "--json"]);
  const result = JSON.parse(logs[0]!);
  expect(result).toMatchObject({ ok: true, opened: ["operator-agent@kernel", "advisor-lead@kernel"] });
  expect(result.notes).toEqual([`advisor-lead@kernel needs attention: ${ADVISOR_HELD}. Look at it in its tile with: rig capture advisor-lead@kernel`]);
  // Only the rigs the opened seats belong to are read.
  expect(f.get.mock.calls.map(([url]) => url)).toEqual(["/api/ps", "/api/rigs/k1/nodes"]);
  expect(process.exitCode).toBeUndefined();
});

it("shows the same line in the human output", async () => {
  await fixture().run(["open", "kernel", "--provider", "herdr"]);
  expect(logs.join("\n")).toContain(`  note: advisor-lead@kernel needs attention: ${ADVISOR_HELD}. Look at it in its tile with: rig capture advisor-lead@kernel`);
});

it("adds nothing when no opened seat needs attention", async () => {
  await fixture({ advisorNeedsAttention: false }).run(["open", "kernel", "--provider", "herdr", "--json"]);
  expect(JSON.parse(logs[0]!).notes).toBeUndefined();
});

it("says the check couldn't be made, rather than nothing, and the open still succeeds", async () => {
  await fixture({ psStatus: 503 }).run(["open", "kernel", "--provider", "herdr", "--json"]);
  const result = JSON.parse(logs[0]!);
  expect(result.notes).toEqual(["Couldn't check whether operator-agent@kernel, advisor-lead@kernel need attention: the rig list couldn't be read (HTTP 503: busy)."]);
  expect(result.ok).toBe(true); expect(process.exitCode).toBeUndefined();
});

it("never gives a remote tile a same-named local seat's reason", async () => {
  // The local advisor-lead@kernel is held; the opened advisor-lead@kernel tile is the one on host vm1.
  const f = fixture({ remote: [{ seat: "advisor-lead@kernel", host: "vm1" }] });
  await f.run(["open", "saved:fleet", "--provider", "herdr", "--json"]);
  expect(JSON.parse(logs[0]!).notes).toEqual(["Couldn't check whether advisor-lead@kernel needs attention: it's on host vm1, which this daemon doesn't check."]);
});

it("an older daemon's result without host provenance checks no seat by name, even with a same-named local seat held", async () => {
  // The older daemon names its remote advisor-lead@kernel tile by seat alone; the local one is held.
  const f = fixture({ olderDaemon: true });
  await f.run(["open", "saved:fleet", "--provider", "herdr", "--json"]);
  const result = JSON.parse(logs[0]!);
  expect(result.notes).toEqual(["Couldn't check whether operator-agent@kernel, advisor-lead@kernel need attention: the daemon didn't say which host each tile is on."]);
  expect(f.get).not.toHaveBeenCalled();
  expect(result.ok).toBe(true); expect(process.exitCode).toBeUndefined();
});
