import { describe, it, expect } from "vitest";
import {
  RexAdapter,
  REX_PANES_PER_PAGE,
  REX_TILE_CLOSED_REASON,
  REX_TILE_SETTLE_MS,
  REX_TILES_UNCONFIRMED_NOTE,
} from "../src/domain/terminal/rex-adapter.js";
import { buildRexGrid, rexLabel, type RexLayoutNode } from "../src/domain/terminal/rex-layout.js";
import { buildGridRoot, type HerdrLayoutNode } from "../src/domain/terminal/herdr-adapter.js";
import { RexError, type RexProbeResult, type RexTransport } from "../src/domain/terminal/rex-transport.js";
import type { ComposedPane, ComposedView } from "../src/domain/terminal/terminal-provider.js";
import { chunkPanes } from "../src/domain/terminal/view-composer.js";

type Reply = (method: string, params: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>;

const FLAVOR = "com.superlogical.terminal.shell";
const HOLD = { quick_exit_threshold_ms: 10_000 };
const noWait = async () => {};

/** Every block id a request's layout creates, in layout order, as Rex returns them. */
function blockIds(window: string, layout: RexLayoutNode): string[] {
  const out: string[] = [];
  const walk = (node: RexLayoutNode) => {
    if ("block" in node) out.push(`${window}/b${out.length}`);
    else { walk(node.split.before); walk(node.split.after); }
  };
  walk(layout);
  return out;
}

function fakeRex(opts: { probe?: Partial<RexProbeResult>; respond?: Reply; sessions?: string[]; exits?: Record<string, unknown>; closed?: string[] } = {}) {
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  const blocks: string[] = [];
  let windows = 0;
  const defaults: Reply = (method, params) => {
    if (method === "session.list") return { sessions: (opts.sessions ?? []).map((label, i) => ({ session_id: `session:${i}`, label })) };
    if (method === "session.create") return { session_id: "session:new" };
    if (method === "session.new_window") {
      const ids = blockIds(`w${++windows}`, params["layout"] as RexLayoutNode);
      blocks.push(...ids);
      return { window_id: `window:${windows}`, block_ids: ids, revision: windows };
    }
    if (method === "session.list_blocks") {
      return { blocks: blocks.filter((id) => !opts.closed?.includes(id)).map((block_id) => ({ block_id, label: "x", placement: "placed" })) };
    }
    if (method === "com.superlogical.terminal.process") return { last_exit: opts.exits?.[params["block_id"] as string] ?? null };
    if (method === "session.destroy") return {};
    throw new Error(`unexpected ${method}`);
  };
  const transport: RexTransport = {
    async probe() {
      return { alive: true, version: "0.0.1792787366-g623b2d", instanceId: "inst-1", ...opts.probe };
    },
    async request(method, params) {
      requests.push({ method, params: params as Record<string, unknown> });
      return opts.respond ? opts.respond(method, params as Record<string, unknown>) : defaults(method, params as Record<string, unknown>);
    },
  };
  return { transport, requests, defaults };
}

const pane = (seat: string, label = `pod.${seat} · s02`): ComposedPane => ({ seat, label, paneCommand: `tmux attach -t '${seat}'`, readOnly: false });
const viewOf = (panes: ComposedPane[], extra: Partial<ComposedView> = {}): ComposedView => ({
  id: "rig:acme", opened: panes, absent: [], degraded: [], pages: chunkPanes(panes, REX_PANES_PER_PAGE), ...extra,
});
const methods = (requests: Array<{ method: string }>) => requests.map((r) => r.method);

describe("rex adapter: status and liveness", () => {
  it("reports availability, version and the server's instance id", async () => {
    const adapter = new RexAdapter({ transport: fakeRex().transport });
    expect(await adapter.status()).toEqual({
      provider: "rex", available: true, version: "0.0.1792787366-g623b2d",
      capabilities: { cli: true, "session.create": true, "session.new_window": true },
      server: { instanceId: "inst-1" },
    });
    expect(await adapter.liveness()).toEqual({ alive: true });
    expect(adapter.panesPerPage).toBe(16);
  });

  it("is honestly unavailable, with the reason, and never throws", async () => {
    const down = new RexAdapter({ transport: fakeRex({ probe: { alive: false, version: null, instanceId: null, detail: "the Rex server is not reachable" } }).transport });
    expect(await down.status()).toEqual({ provider: "rex", available: false, capabilities: { cli: false, "session.create": false, "session.new_window": false } });
    expect(await down.liveness()).toEqual({ alive: false, detail: "the Rex server is not reachable" });
    const broken = new RexAdapter({ transport: { probe: async () => { throw new Error("boom"); }, request: async () => ({}) } });
    expect(await broken.status()).toEqual({ provider: "rex", available: false, capabilities: {} });
    expect(await broken.liveness()).toEqual({ alive: false, detail: "boom" });
  });

  it("answers status and liveness from one probe", async () => {
    let probes = 0;
    let clock = 0;
    const transport: RexTransport = { probe: async () => { probes++; return { alive: true, version: "1", instanceId: "i" }; }, request: async () => ({}) };
    const adapter = new RexAdapter({ transport, now: () => clock });
    await adapter.status();
    await adapter.liveness();
    expect(probes).toBe(1);
    clock += 1_000;
    await adapter.liveness();
    expect(probes).toBe(2);
  });
});

describe("rex adapter: openView", () => {
  it("refuses rex_unavailable when the server is down, and sends nothing", async () => {
    const { transport, requests } = fakeRex({ probe: { alive: false, detail: "the Rex server is not reachable (rex server is not running)" } });
    const res = await new RexAdapter({ transport, sleep: noWait }).openView(viewOf([pane("a@r")]));
    expect(res).toMatchObject({ provider: "rex", ok: false, code: "rex_unavailable", opened: [], pages: 0 });
    expect(res.error).toContain("rex server is not running");
    expect(requests).toEqual([]);
  });

  it("an empty view has no side effects", async () => {
    const { transport, requests } = fakeRex();
    const absent = [{ seat: "gone@r", host: null, reason: "no live session" }];
    const res = await new RexAdapter({ transport, sleep: noWait }).openView({ id: "rig:acme", opened: [], absent, degraded: [], pages: [] });
    expect(res).toEqual({ provider: "rex", ok: true, opened: [], absent, degraded: [], pages: 0 });
    expect(requests).toEqual([]);
  });

  it("creates an empty session, adds the page as its first window, waits, then checks the tiles", async () => {
    const { transport, requests } = fakeRex();
    const waits: number[] = [];
    const view = viewOf([pane("a@r")], { planId: "0123456789abcdef9999" });
    const res = await new RexAdapter({ transport, newLaunchToken: () => "tok", sleep: async (ms) => { waits.push(ms); } }).openView(view);
    expect(res).toEqual({ provider: "rex", ok: true, opened: ["a@r"], absent: [], degraded: [], pages: 1, space: { id: "session:new", label: "acme" } });
    expect(methods(requests)).toEqual(["session.list", "session.create", "session.new_window", "session.list_blocks", "com.superlogical.terminal.process"]);
    expect(requests[1]!.params).toEqual({ label: "acme" });
    expect(requests[2]!.params).toEqual({
      session_id: "session:new",
      window_label: "openrig:rig:acme#0123456789abcdef#tok",
      layout: { block: { flavor: FLAVOR, label: "pod.a@r · s02", options: { command: ["sh", "-c", "tmux attach -t 'a@r'"], exit: HOLD } } },
    });
    expect(requests[3]!.params).toEqual({ session_id: "session:new" });
    expect(requests[4]!.params).toEqual({ session_id: "session:new", block_id: "w1/b0", args: {} });
    expect(waits).toEqual([REX_TILE_SETTLE_MS]);
  });

  it("numbers the session when a view by that name is already open, and says so", async () => {
    const { transport, requests } = fakeRex({ sessions: ["acme", "acme (2)", "other"] });
    const res = await new RexAdapter({ transport, sleep: noWait }).openView(viewOf([pane("a@r")]));
    expect(requests[1]!.params).toEqual({ label: "acme (3)" });
    expect(res.space).toEqual({ id: "session:new", label: "acme (3)" });
    expect(res.notes).toEqual(['A view named "acme" is already open, so this one is "acme (3)".']);
  });

  it("keeps the plain label when the session list can't be read", async () => {
    const f = fakeRex();
    const { transport, requests } = fakeRex({ respond: (method, params) => {
      if (method === "session.list") throw new RexError("rex session.list: boom", "failed");
      return f.defaults(method, params);
    } });
    const res = await new RexAdapter({ transport, sleep: noWait }).openView(viewOf([pane("a@r")]));
    expect(requests[1]!.params).toEqual({ label: "acme" });
    expect(res.ok).toBe(true);
  });

  it("a failed session.create degrades every seat (rex_session_failed)", async () => {
    const seats = Array.from({ length: 17 }, (_, i) => pane(`s${i}@r`));
    const { transport, requests } = fakeRex({ respond: (method) => {
      if (method === "session.create") throw new RexError("this Rex server has no session.create; update Rex", "method_not_found", "method_not_found");
      return { sessions: [] };
    } });
    const res = await new RexAdapter({ transport, sleep: noWait }).openView(viewOf(seats));
    expect(res).toMatchObject({ ok: false, code: "rex_session_failed", opened: [], pages: 0 });
    expect(res.error).toBe("rex session.create failed: this Rex server has no session.create; update Rex");
    expect(res.degraded).toHaveLength(17);
    expect(res.degraded.every((d) => d.host === "rex" && d.reason === res.error)).toBe(true);
    expect(methods(requests)).toEqual(["session.list", "session.create"]);
  });

  it("a reply without a session id leaves the create unconfirmed, not failed", async () => {
    const { transport } = fakeRex({ respond: (method) => (method === "session.create" ? { initial_windows: [] } : { sessions: [] }) });
    const res = await new RexAdapter({ transport, sleep: noWait }).openView(viewOf([pane("a@r")]));
    expect(res).toMatchObject({
      ok: false, code: "rex_outcome_unknown",
      error: `Rex didn't confirm creating session "acme" (the reply named no session); it may exist. Check Rex before retrying.`,
    });
  });

  it("a lost session.create reply degrades every seat as unconfirmed and closes nothing", async () => {
    const { transport, requests } = fakeRex({ respond: (method) => {
      if (method === "session.create") throw new RexError("rex session.create: did not answer within 30000 ms", "unknown");
      return { sessions: [] };
    } });
    const res = await new RexAdapter({ transport, sleep: noWait }).openView(viewOf([pane("a@r"), pane("b@r")]));
    expect(res).toMatchObject({ ok: false, code: "rex_outcome_unknown", opened: [], pages: 0 });
    expect(res.error).toContain(`Rex didn't confirm creating session "acme"`);
    expect(res.degraded.map((d) => d.reason)).toEqual([res.error, res.error]);
    expect(methods(requests)).toEqual(["session.list", "session.create"]);
  });

  it("opens 17 seats as a 4×4 first window and a second window that keeps focus where it was", async () => {
    const seats = Array.from({ length: 17 }, (_, i) => pane(`s${i}@r`));
    const { transport, requests } = fakeRex();
    const res = await new RexAdapter({ transport, newLaunchToken: () => "t", sleep: noWait }).openView(viewOf(seats));
    expect(res).toMatchObject({ ok: true, pages: 2, degraded: [], space: { id: "session:new", label: "acme" } });
    expect(res.opened).toEqual(seats.map((s) => s.seat));
    expect(methods(requests)).toEqual([
      "session.list", "session.create", "session.new_window", "session.new_window", "session.list_blocks",
      ...Array(17).fill("com.superlogical.terminal.process"),
    ]);
    const [first, second] = requests.filter((r) => r.method === "session.new_window").map((r) => r.params);
    expect(first).not.toHaveProperty("focus");
    expect(first!["window_label"]).toBe("openrig:rig:acme#t/1");
    expect(blockIds("w", first!["layout"] as RexLayoutNode)).toHaveLength(16);
    expect(second).toEqual({
      session_id: "session:new", window_label: "openrig:rig:acme#t/2", focus: false,
      layout: { block: { flavor: FLAVOR, label: "pod.s16@r · s02", options: { command: ["sh", "-c", "tmux attach -t 's16@r'"], exit: HOLD } } },
    });
    const checked = requests.filter((r) => r.method === "com.superlogical.terminal.process").map((r) => r.params["block_id"]);
    expect(checked).toEqual([...Array.from({ length: 16 }, (_, i) => `w1/b${i}`), "w2/b0"]);
  });

  it("a failed later window degrades only its own seats", async () => {
    const seats = Array.from({ length: 17 }, (_, i) => pane(`s${i}@r`));
    const f = fakeRex();
    let windows = 0;
    const { transport } = fakeRex({ respond: (method, params) => {
      if (method === "session.new_window" && ++windows === 2) throw new RexError("rex session.new_window: too many blocks (status=409 code=conflict)", "failed", "conflict");
      return f.defaults(method, params);
    } });
    const res = await new RexAdapter({ transport, sleep: noWait }).openView(viewOf(seats));
    expect(res).toMatchObject({ ok: true, pages: 1 });
    expect(res.opened).toEqual(seats.slice(0, 16).map((s) => s.seat));
    expect(res.degraded).toEqual([{ seat: "s16@r", host: "rex", reason: "rex session.new_window failed: rex session.new_window: too many blocks (status=409 code=conflict)" }]);
  });

  it("closes the empty session when no window could open", async () => {
    const f = fakeRex();
    const { transport, requests } = fakeRex({ respond: (method, params) => {
      if (method === "session.new_window") throw new RexError("rex session.new_window: bad layout (status=400 code=bad_request)", "failed", "bad_request");
      return f.defaults(method, params);
    } });
    const res = await new RexAdapter({ transport, sleep: noWait }).openView(viewOf([pane("a@r")]));
    expect(res).toMatchObject({ ok: false, code: "rex_session_failed", pages: 0, error: "rex session.new_window failed: rex session.new_window: bad layout (status=400 code=bad_request)" });
    expect(res).not.toHaveProperty("space");
    expect(methods(requests)).toEqual(["session.list", "session.create", "session.new_window", "session.destroy"]);
    expect(requests[3]!.params).toEqual({ session_id: "session:new" });
  });

  it("says so when the empty session can't be closed", async () => {
    const { transport } = fakeRex({ respond: (method) => {
      if (method === "session.list") return { sessions: [] };
      if (method === "session.create") return { session_id: "session:new" };
      throw new RexError(`rex ${method}: boom`, "failed");
    } });
    const res = await new RexAdapter({ transport, sleep: noWait }).openView(viewOf([pane("a@r")]));
    expect(res.notes).toEqual([`Rex may have kept the empty session "acme" (rex session.destroy: boom); close it in Rex if it's still open.`]);
  });

  it("a lost window reply keeps the session, which may hold tiles, and names it", async () => {
    const f = fakeRex();
    const { transport, requests } = fakeRex({ respond: (method, params) => {
      if (method === "session.new_window") throw new RexError("rex session.new_window: ended by SIGKILL", "unknown");
      return f.defaults(method, params);
    } });
    const res = await new RexAdapter({ transport, sleep: noWait }).openView(viewOf([pane("a@r")]));
    expect(res).toMatchObject({ ok: false, code: "rex_outcome_unknown", pages: 0, opened: [], space: { id: "session:new", label: "acme" } });
    expect(res.error).toBe(`Rex didn't confirm page 1 of session "acme", so those seats are listed as degraded but may be open. Check the session in Rex before retrying.`);
    expect(res.degraded).toEqual([{ seat: "a@r", host: "rex", reason: `Rex didn't confirm page 1 of session "acme" (rex session.new_window: ended by SIGKILL); its tiles may be open` }]);
    expect(methods(requests)).not.toContain("session.destroy");
  });

  it("a lost later-page reply keeps the opened page and names the unconfirmed one", async () => {
    const seats = Array.from({ length: 17 }, (_, i) => pane(`s${i}@r`));
    const f = fakeRex();
    let windows = 0;
    const { transport, requests } = fakeRex({ respond: (method, params) => {
      if (method === "session.new_window" && ++windows === 2) throw new RexError("rex session.new_window: did not answer within 30000 ms", "unknown");
      return f.defaults(method, params);
    } });
    const res = await new RexAdapter({ transport, sleep: noWait }).openView(viewOf(seats));
    expect(res).toMatchObject({ ok: true, pages: 1, space: { id: "session:new", label: "acme" } });
    expect(res.opened).toEqual(seats.slice(0, 16).map((s) => s.seat));
    expect(res.degraded.map((d) => d.seat)).toEqual(["s16@r"]);
    expect(res.notes).toContain(`Rex didn't confirm page 2 of session "acme", so those seats are listed as degraded but may be open. Check the session in Rex before retrying.`);
    expect(methods(requests)).not.toContain("session.destroy");
  });

  it("degrades a tile that closed or whose command already exited; the others stay opened", async () => {
    const f = fakeRex({ closed: ["w1/b1"], exits: { "w1/b2": { exit_code: 1, error: "exit status 1" } } });
    const { transport } = fakeRex({ respond: (method, params) => {
      if (method === "com.superlogical.terminal.process" && params["block_id"] === "w1/b3") {
        throw new RexError("rex com.superlogical.terminal.process: block not found (status=404 code=not_found)", "failed", "not_found");
      }
      return f.defaults(method, params);
    } });
    const res = await new RexAdapter({ transport, sleep: noWait }).openView(viewOf([pane("a@r"), pane("b@r"), pane("c@r"), pane("d@r")]));
    expect(res.opened).toEqual(["a@r"]);
    expect(res.degraded).toEqual([
      { seat: "b@r", host: "rex", reason: REX_TILE_CLOSED_REASON },
      { seat: "c@r", host: "rex", reason: "the tile's command exited with code 1 soon after Rex opened it (exit status 1)" },
      { seat: "d@r", host: "rex", reason: REX_TILE_CLOSED_REASON },
    ]);
    expect(res.ok).toBe(true);
    expect(res.notes).toBeUndefined();
  });

  it("every tile exiting is not ok, and the session is still reported", async () => {
    const { transport } = fakeRex({ exits: { "w1/b0": { exit_code: 1 } } });
    const res = await new RexAdapter({ transport, sleep: noWait }).openView(viewOf([pane("a@r")]));
    expect(res).toMatchObject({ ok: false, opened: [], space: { id: "session:new" } });
  });

  it.each([
    ["an unreadable block list", "session.list_blocks"],
    ["an unreadable process", "com.superlogical.terminal.process"],
  ])("fails safe on %s: the seats stay opened, with a note", async (_name, failing) => {
    const f = fakeRex();
    const { transport } = fakeRex({ respond: (method, params) => {
      if (method === failing) throw new RexError("rex: boom", "failed");
      return f.defaults(method, params);
    } });
    const res = await new RexAdapter({ transport, sleep: noWait }).openView(viewOf([pane("a@r"), pane("b@r")]));
    expect(res.opened).toEqual(["a@r", "b@r"]);
    expect(res.notes).toEqual([REX_TILES_UNCONFIRMED_NOTE]);
  });

  it("fails safe when the reply has no block ids to check", async () => {
    const f = fakeRex();
    const { transport, requests } = fakeRex({ respond: (method, params) => (method === "session.new_window" ? { window_id: "window:1" } : f.defaults(method, params)) });
    const res = await new RexAdapter({ transport, sleep: noWait }).openView(viewOf([pane("a@r")]));
    expect(res).toMatchObject({ ok: true, opened: ["a@r"], notes: [REX_TILES_UNCONFIRMED_NOTE] });
    expect(methods(requests)).toEqual(["session.list", "session.create", "session.new_window", "session.list_blocks"]);
  });

  it("pads the grid with blank shells that are never opened or checked", async () => {
    const { transport, requests } = fakeRex();
    const res = await new RexAdapter({ transport, sleep: noWait }).openView(viewOf([pane("a@r"), pane("b@r"), pane("c@r")]));
    expect(res.opened).toEqual(["a@r", "b@r", "c@r"]);
    const layout = requests.find((r) => r.method === "session.new_window")!.params["layout"] as RexLayoutNode;
    const leaves: Array<{ label: string; options: unknown }> = [];
    const walk = (node: RexLayoutNode) => ("block" in node ? leaves.push({ label: node.block.label, options: node.block.options }) : (walk(node.split.before), walk(node.split.after)));
    walk(layout);
    expect(leaves).toHaveLength(4);
    expect(leaves[3]).toEqual({ label: "", options: { command: ["sh"] } });
    const checked = requests.filter((r) => r.method === "com.superlogical.terminal.process").map((r) => r.params["block_id"]);
    expect(checked).toEqual(["w1/b0", "w1/b1", "w1/b2"]);
  });

  it("names a kernel view's session and window for people", async () => {
    const { transport, requests } = fakeRex();
    const panes = [pane("op@kernel", "operator"), pane("dash@kernel", "dashboard")];
    await new RexAdapter({ transport, sleep: noWait }).openView(viewOf(panes, { id: "kernel", spaceLabel: "openrig kernel", columns: 2 }));
    expect(requests[1]!.params).toEqual({ label: "openrig kernel" });
    expect(requests[2]!.params).toMatchObject({ window_label: "operator · dashboard" });
  });
});

describe("rex layout", () => {
  const toShape = (node: HerdrLayoutNode | RexLayoutNode): unknown => {
    if ("type" in node) return node.type === "pane" ? node.label : [node.direction === "right" ? "across" : "down", node.ratio, toShape(node.first), toShape(node.second)];
    if ("block" in node) return node.block.label;
    return [node.split.direction === "horizontal" ? "across" : "down", node.split.ratio, toShape(node.split.before), toShape(node.split.after)];
  };

  it.each([1, 2, 3, 5, 7, 10, 16])("uses the same grid as herdr for %i seats", (n) => {
    const panes = Array.from({ length: n }, (_, i) => pane(`s${i}`));
    for (const columns of [undefined, 2]) {
      const rex = buildRexGrid(panes, columns);
      const herdr = buildGridRoot(panes, columns);
      expect({ ...rex, root: toShape(rex.root) }).toEqual({ ...herdr, root: toShape(herdr.root) });
    }
  });

  it("puts before on the left for a row and on top for a column", () => {
    const grid = buildRexGrid([pane("a"), pane("b"), pane("c"), pane("d")]);
    expect(grid.root).toMatchObject({ split: { direction: "vertical", ratio: 0.5, before: { split: { direction: "horizontal", ratio: 0.5 } } } });
  });

  it("keeps labels within Rex's limits", () => {
    expect(rexLabel("a\tb\u0007c")).toBe("a b c");
    const long = "é".repeat(200);
    expect([...rexLabel(long)]).toHaveLength(128);
    expect(rexLabel(long).endsWith("…")).toBe(true);
    expect(rexLabel("short")).toBe("short");
  });
});
