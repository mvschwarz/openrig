import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { HerdrFollowView } from "../src/domain/terminal/herdr-follow-view.js";
import { composeView } from "../src/domain/terminal/view-composer.js";
import type { ComposedView } from "../src/domain/terminal/terminal-provider.js";
import type { ViewerPane } from "../src/domain/terminal/herdr-viewer.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const socket = "/tmp/follow-provider.sock";
export function task(seats: string[], complete = true): ComposedView {
  const composed = composeView("qitem:task", seats.map(seat => ({ seat, label: seat, host: null, alive: true,
    tmuxSession: seat, readOnly: false })), { resolveHost: () => null, localTmux: "/usr/bin/tmux", localTmuxServer: ["-S", "/tmp/follow-seats.sock"] });
  return { ...composed, task: { qitemId: "task", name: "Example task", complete, issues: complete ? [] : ["read failed"],
    members: seats.map(seat => ({ key: { hostId: "self", nodeId: seat }, seat, obligations: [{ qitemId: seat, state: "in-progress" }],
      availability: "available", viewerStatus: "not-provisioned" })) } };
}
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "following-test-")); roots.push(root);
  const panes = new Map<string, ViewerPane & { argv: string[] }>();
  const calls: string[][] = [], rpc: Array<{ method: string; params: unknown }> = [];
  const inputs = new Map<string, "empty" | "text" | "unknown">();
  let transform = (view: ComposedView) => view;
  let lateFocus: { seat: string; reads: number } | undefined;
  let clock = 100, lostCreate = false, lostClose = false, readsFailed = false;
  const run = async (args: string[]) => {
    calls.push(args);
    const command = args.slice(0, 2).join(" ");
    if (command === "status server") return JSON.stringify({ version: "0.9.5", protocol: 22, running: true, socket });
    if (readsFailed) throw new Error("provider read failed");
    if (command === "workspace create" || command === "pane split") {
      const id = `p${calls.length}`;
      const made = { pane_id: id, workspace_id: "w1", terminal_id: `term-${id}`, cwd: args[args.indexOf("--cwd") + 1]!,
        focused: panes.size === 0, argv: ["/bin/bash"] };
      panes.set(id, made);
      if (lostCreate) { lostCreate = false; throw new Error("lost create response"); }
      return JSON.stringify({ result: { [command === "workspace create" ? "root_pane" : "pane"]: made } });
    }
    if (command === "workspace list") return JSON.stringify({ result: { workspaces: [{ workspace_id: "w1" }] } });
    if (command === "pane list") return JSON.stringify({ result: { panes: [...panes.values()] } });
    if (command === "pane get") {
      const selected = panes.get(args[2]!); if (!selected) throw new Error("missing pane");
      return JSON.stringify({ result: { pane: selected } });
    }
    if (command === "pane process-info") return JSON.stringify({ result: { process_info: { foreground_processes: [{ argv: panes.get(args[3]!)!.argv }] } } });
    if (command === "pane run") {
      const selected = panes.get(args[2]!)!;
      if (args[3]!.startsWith("/usr/bin/tail")) {
        selected.argv = ["/usr/bin/tail", "-n", "30", "-F", path.join(selected.cwd, "..", "events.log")];
      } else {
        // The shared composer produces one wrapper per actual seat.
        const seat = ["a", "b", "c", "d"].find(s => args[3]!.includes(`'${s}'`))!;
        selected.argv = ["/usr/bin/tmux", "-S", "/tmp/follow-seats.sock", "attach", "-f", "ignore-size", "-t", `$${seat}`];
      }
      return "";
    }
    if (command === "pane close") {
      panes.delete(args[2]!);
      if (lostClose) { lostClose = false; throw new Error("lost close response"); }
      return "";
    }
    if (command === "pane report-metadata") return "";
    throw new Error(`Unexpected operation ${args}`);
  };
  const create = () => new HerdrFollowView({ root, socketPath: socket, platform: "linux", run,
    now: () => clock, input: async target => {
      if (lateFocus?.seat === target.seat && ++lateFocus.reads === 2) {
        for (const selected of panes.values()) selected.focused = selected.argv.at(-1) === `$${target.seat}`;
      }
      return inputs.get(target.seat) ?? "empty";
    },
    inspect: async argv => ({ sessionId: `$${argv[4]}`, nodeId: argv[4]! }),
    transport: { probe: async () => ({ alive: true, version: "0.9.5", protocol: 22 }), request: async (method, params) => {
      rpc.push({ method, params });
      const id = (params as { pane_id: string }).pane_id;
      for (const selected of panes.values()) selected.focused = selected.pane_id === id;
      return { type: "pane_focused" };
    } } });
  const provider = create();
  const follow = (seats = ["a", "b", "c"], controls = {}, complete = true) => provider.follow("qitem:task", transform(task(seats, complete)), { enabled: true, ...controls }, async () => true);
  return { follow, create, panes, calls, rpc, inputs, advance: (ms: number) => { clock += ms; },
    loseCreate: () => { lostCreate = true; }, loseClose: () => { lostClose = true; }, failReads: () => { readsFailed = true; },
    changeTarget: () => { transform = view => ({ ...view, opened: view.opened.map(target => target.seat === "a"
      ? { ...target, paneCommand: `${target.paneCommand} --changed`, attachArgv: [...target.attachArgv!.slice(0, 4), "replacement-a", ...target.attachArgv!.slice(5)] } : target) }); },
    focusAfterPlanning: (seat: string) => { lateFocus = { seat, reads: 0 }; },
    focusSeat: (seat: string) => { for (const selected of panes.values()) selected.focused = selected.argv.at(-1) === `$${seat}`; } };
}

describe("stable task-following workspace", () => {
  it("3→4→3 keeps one workspace, unchanged survivor identities, and uses no layout refresh", async () => {
    const f = fixture(); const first = await f.follow();
    expect(first).toMatchObject({ ok: true, opened: ["a", "b", "c"], workspaceId: "w1" });
    const before = [...f.panes.values()].map(p => [p.pane_id, p.terminal_id, p.argv]);
    expect(await f.follow(["a", "b", "c", "d"])).toMatchObject({ ok: true, workspaceId: "w1", opened: ["a", "b", "c", "d"] });
    expect([...f.panes.values()].slice(0, 4).map(p => [p.pane_id, p.terminal_id, p.argv])).toEqual(before);
    await f.follow(); f.advance(4000);
    expect(await f.follow()).toMatchObject({ ok: true, opened: ["a", "b", "c"] });
    expect(f.calls.filter(c => c[0] === "workspace" && c[1] === "create")).toHaveLength(1);
    expect(f.calls.filter(c => c[1] === "close")).toHaveLength(1);
    expect(f.calls.filter(c => c[1] === "split").every(c => c.includes("--no-focus"))).toBe(true);
  });
  it("incomplete membership and failed provider reads keep the entire previous view", async () => {
    const f = fixture(); await f.follow(); const count = f.calls.length;
    const failed = await f.follow([], {}, false);
    expect(failed).toMatchObject({ ok: false, opened: ["a", "b", "c"], following: { state: "retained" } });
    expect(failed.following!.events.at(-1)).toContain("membership is incomplete");
    expect(f.calls.length).toBe(count);
    f.failReads(); expect(await f.follow([])).toMatchObject({ ok: false, opened: ["a", "b", "c"] });
    expect(f.calls.some(c => c[1] === "close")).toBe(false);
  });
  it("complete empty membership drains viewer tiles but keeps its workspace", async () => {
    const f = fixture(); await f.follow(); await f.follow([]); f.advance(16000);
    expect(await f.follow([])).toMatchObject({ ok: true, opened: [], workspaceId: "w1", following: { state: "empty" } });
    expect(f.panes.size).toBe(1); expect(f.calls.filter(c => c[1] === "close")).toHaveLength(3);
  });
  it("moves focus to a surviving member before closing a focused leaver", async () => {
    const f = fixture(); await f.follow(); f.focusSeat("c"); await f.follow(["a", "b"]); f.advance(4000);
    expect((await f.follow(["a", "b"])).opened).toContain("c"); f.advance(12000);
    expect((await f.follow(["a", "b"])).opened).toEqual(["a", "b"]);
    expect(f.rpc).toEqual([{ method: "pane.focus", params: { pane_id: expect.any(String) } }]);
    expect([...f.panes.values()].find(p => p.focused)?.argv.at(-1)).toBe("$a");
  });
  it("does not confirm an old viewer when the same node has a new Core attachment", async () => {
    const f = fixture(); await f.follow(); const before = f.calls.length; f.changeTarget();
    const result = await f.follow();
    expect(result).toMatchObject({ ok: false, following: { state: "retained" }, error: expect.stringContaining("current attachment differs") });
    expect(f.calls.slice(before).some(c => ["create", "split", "run", "close"].includes(c[1]!))).toBe(false);
  });
  it("a leaver gaining focus after planning gets its reading retention before any transfer or close", async () => {
    const f = fixture(); await f.follow(); await f.follow(["a", "b"]); f.advance(4000); f.focusAfterPlanning("c");
    const held = await f.follow(["a", "b"]);
    expect(held.opened).toContain("c"); expect(held.following!.nextAt).toBe(16100);
    expect(f.rpc).toHaveLength(0); expect(f.calls.filter(c => c[1] === "close")).toHaveLength(0);
    f.advance(12000); expect((await f.follow(["a", "b"])).opened).toEqual(["a", "b"]);
    expect(f.rpc).toHaveLength(1);
  });
  it.each(["text", "unknown"] as const)("keeps a departed %s input, labels it nonparticipant, and never closes it", async input => {
    const f = fixture(); await f.follow(); f.inputs.set("c", input); await f.follow(["a", "b"]); f.advance(20000);
    const result = await f.follow(["a", "b"]);
    expect(result.opened).toContain("c"); expect(result.following!.tiles.find(t => t.seat === "c")!.reason).toBeTruthy();
    expect(f.calls.filter(c => c[1] === "close")).toHaveLength(0);
    expect(f.calls.some(c => c[1] === "report-metadata" && c.includes("c (no longer in this task)"))).toBe(true);
  });
  it("pins departed tiles, suppresses temporarily, and admits overflow after a deliberate cap increase", async () => {
    const f = fixture(); expect((await f.follow(undefined, { maxTiles: 2 })).opened).toEqual(["a", "b"]);
    expect((await f.follow(undefined, { maxTiles: 4 })).opened).toEqual(["a", "b", "c"]);
    await f.follow(["a", "b"], { pin: ["c"] }); f.advance(20000);
    expect((await f.follow(["a", "b"])).opened).toContain("c");
    expect((await f.follow(["a", "b"], { suppress: ["b"], suppressionMs: 1000 })).opened).not.toContain("b");
    f.advance(1000); expect((await f.follow(["a", "b"])).opened).toContain("b");
  });
  it("a new provider terminal generation retains previous tiles and creates/closes nothing", async () => {
    const f = fixture(); await f.follow(); const count = f.calls.length;
    [...f.panes.values()][1]!.terminal_id = "restarted";
    expect(await f.follow(["a"])).toMatchObject({ ok: false, following: { state: "retained" } });
    expect(f.calls.slice(count).some(c => ["close", "split", "create", "run"].includes(c[1]!))).toBe(false);
  });
  it("reconciles a lost create response without creating another workspace", async () => {
    const f = fixture(); f.loseCreate(); expect((await f.follow()).ok).toBe(false);
    expect((await f.follow()).ok).toBe(true);
    expect(f.calls.filter(c => c[1] === "create")).toHaveLength(1);
  });
  it("reconciles a lost close response by complete absence without repeating close", async () => {
    const f = fixture(); await f.follow(); await f.follow(["a", "b"]); f.advance(16000); f.loseClose();
    expect((await f.follow(["a", "b"])).ok).toBe(false);
    expect(await f.follow(["a", "b"])).toMatchObject({ ok: true, opened: ["a", "b"] });
    expect(f.calls.filter(c => c[1] === "close")).toHaveLength(1);
  });
  it("daemon reconstruction reuses provenance and disabling never closes viewers", async () => {
    const f = fixture(); await f.follow(); const before = f.calls.length;
    const next = f.create();
    expect(await next.follow("qitem:task", task(["a", "b", "c"]), { enabled: true }, async () => true)).toMatchObject({ ok: true, workspaceId: "w1" });
    expect(f.calls.slice(before).some(c => ["create", "run", "split"].includes(c[1]!))).toBe(false);
    const count = f.calls.length;
    expect(await next.follow("qitem:task", null, { enabled: false }, async () => false)).toMatchObject({ ok: true, following: { state: "disabled" } });
    expect(f.calls.length).toBe(count);
  });
});
