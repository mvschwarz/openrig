import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrAppProvider } from "../src/domain/terminal/herdr-app-provider.js";
import { HerdrAppClientFiles } from "../src/domain/terminal/herdr-app-state.js";
import { referencedTerminals, type LayoutNode } from "../src/domain/terminal/herdr-app-layout.js";
import type { AppReply, HcResult, HcRunner } from "../src/domain/terminal/herdr-app-transport.js";
import type { ComposedPane, ComposedView } from "../src/domain/terminal/terminal-provider.js";

const BASE: LayoutNode = { id: "root", type: "row", children: [
  { id: "sidebar", type: "block", size: { px: 260 }, content: { mod: "workspace-chrome" } },
  { id: "tabs", type: "block", size: { weight: 1 }, content: { tab: "active" } },
] };

const pane = (seat: string, readOnly = false): ComposedPane => ({
  seat, label: `${seat.split("@")[0]} · S1`, runtime: "claude-code", readOnly,
  paneCommand: `tmux attach -t '${seat}'`,
  attachArgv: ["/bin/sh", "-c", "script", "openrig-tile", seat, "/usr/bin/tmux", "-L", "openrig"],
});
const composed = (panes: ComposedPane[]): ComposedView => ({
  id: "rig:demo", opened: panes, absent: [], degraded: [], pages: [panes], viewDescriptor: { kind: "fixed", name: "demo" },
});

/** A simulated herdr-app window, herdr-core and tmux, with one event log for ordering. */
class World {
  log: string[] = [];
  layout = "main";
  /** The strip renders new writes (the app's watcher applied them). */
  applies = true;
  statusKind: AppReply["kind"] = "ok";
  terminals = new Map<string, { state: string; argv: string[]; labels: Record<string, string> }>();
  next = 10;
  failRun = new Set<number>();
  runs = 0;
  ack: { revision: string; terminals: string[] } | null = null;
  tmuxCalls: string[][] = [];
  /** The process tree: the tmux client 4242 runs beneath the viewer's process 4000. */
  parents: Record<number, number> = { 4242: 4100, 4100: 4000 };
  clientSession: string | null = null;
  /** Terminals the strip keeps listing even after a write removed them (an acknowledgement that must be rejected). */
  stillShown: string[] = [];
  /** Core can't be asked: `hc get` times out (exit -1), as in a core hiccup during an event burst. */
  coreDown = false;
  /** Runs after each viewer start (to change the world mid-open). */
  onRun: (() => void) | null = null;
  constructor(readonly home: string) {}

  /** What the rig-strip would record if it rendered the current file now. */
  render(files: HerdrAppClientFiles) {
    if (this.layout !== "rig" || !this.applies || !existsSync(files.rigPath)) return;
    const tree = JSON.parse(readFileSync(files.rigPath, "utf8")) as LayoutNode;
    const find = (n: LayoutNode): LayoutNode | null => n.id === "rig-work" ? n : (n.children ?? []).map(find).find(Boolean) ?? null;
    const revision = (find(tree)?.header as { content: { props: { revision: string } } }).content.props.revision;
    this.ack = { revision, terminals: [...referencedTerminals(tree), ...this.stillShown] };
  }

  app(files: HerdrAppClientFiles) {
    const reply = (value: unknown): AppReply => this.statusKind === "ok" ? { kind: "ok", value }
      : this.statusKind === "unknown" ? { kind: "unknown", reason: "no reply" } : { kind: "unavailable", reason: "no window" };
    return {
      status: async () => { this.log.push("status"); return reply({ layout: this.layout }); },
      commands: async () => reply([{ name: "layout.select" }, { name: "layout.switch" }, { name: "pane.focus" }]),
      ls: async () => reply({ spaces: [] }),
      do: async (command: string, args: Record<string, unknown> | null) => {
        this.log.push(`do:${command}:${JSON.stringify(args)}`);
        if (command === "layout.switch") { this.layout = String(args?.name); this.render(files); }
        return reply({ ok: true });
      },
    };
  }

  hc = async (args: string[]): Promise<HcResult> => {
    const [verb] = args;
    if (verb === "run") {
      this.runs++;
      if (this.failRun.has(this.runs)) { this.log.push("run:failed"); return { exit: 1, json: null, stdout: "", error: { message: "spawn failed" } }; }
      const address = `t${this.next++}`;
      const sep = args.indexOf("--");
      const labels = Object.fromEntries(args.flatMap((a, i) => a === "--label" ? [args[i + 1]!.split("=") as [string, string]] : []));
      this.terminals.set(address, { state: "live", argv: args.slice(sep + 1), labels });
      this.log.push(`run:${address}`);
      this.onRun?.();
      return { exit: 0, json: { address, state: "live" }, stdout: "" };
    }
    if (verb === "get") {
      if (this.coreDown) return { exit: -1, json: null, stdout: "", error: { message: "timed out" } };
      const t = this.terminals.get(args[2]!);
      if (!t) return { exit: 3, json: null, stdout: "", error: { kind: "not_found" } };
      return { exit: 0, json: { address: args[2], ...t, pid: 4000, foreground: { pid: 4000 } }, stdout: "" };
    }
    if (verb === "kill") { this.terminals.get(args[1]!)!.state = "finished"; this.log.push(`kill:${args[1]}`); return { exit: 0, json: null, stdout: "" }; }
    if (verb === "ls") return { exit: 0, json: { terminals: [] }, stdout: "" };
    return { exit: 2, json: null, stdout: "" };
  };
}

let home: string;
let world: World;
let files: HerdrAppClientFiles;
let provider: HerdrAppProvider;

function makeProvider(opts: { ackTimeoutMs?: number; core?: { session: string; socket?: string } } = {}) {
  files = new HerdrAppClientFiles(join(home, "app"), join(home, "journal"));
  const realWrite = files.writeRig.bind(files);
  files.writeRig = async (tree) => {
    const find = (n: LayoutNode): LayoutNode | null => n.id === "rig-work" ? n : (n.children ?? []).map(find).find(Boolean) ?? null;
    world.log.push(`write:${referencedTerminals(tree).join(",")}`);
    const sha = await realWrite(tree);
    void find;
    world.render(files);
    return sha;
  };
  const realSave = files.save.bind(files);
  files.save = async (state) => { world.log.push("journal"); return realSave(state); };
  files.readAck = async () => world.ack;
  let n = 0;
  const hc: HcRunner = Object.assign((args: string[]) => world.hc(args), opts.core ? { core: opts.core } : {});
  provider = new HerdrAppProvider({
    files, app: world.app(files) as never, hc, daemonInstance: "inst1", viewerCwd: join(home, "viewers"),
    ensureMods: async () => ({ ok: true }), ackTimeoutMs: opts.ackTimeoutMs ?? 300, nonce: () => `n${++n}`,
    runTmux: async (argv) => {
      world.tmuxCalls.push(argv);
      world.log.push(`tmux:${argv.slice(3).join(" ")}`);
      // The client is on the session it was listed for, unless the test moved it.
      const listed = argv.indexOf("list-clients");
      return listed >= 0 ? `4242 /dev/pts/9 1 ${world.clientSession ?? argv[listed + 2]!.slice(1)}\n` : "";
    },
    parentPid: async (pid) => world.parents[pid] ?? null,
  });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "herdr-app-provider-"));
  mkdirSync(join(home, "app", "layouts"), { recursive: true });
  writeFileSync(join(home, "app", "layouts", "main.json"), JSON.stringify(BASE));
  world = new World(home);
  makeProvider();
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("HerdrAppProvider.openView", () => {
  it("journals first, starts read-only waiting viewers with labels and no --keep, writes once, then reveals and hands over the keyboard", async () => {
    const result = await provider.openView(composed([pane("dev.build@demo"), pane("dev.qa@demo", true)]));
    expect(result).toMatchObject({ ok: true, provider: "herdr-app", opened: ["dev.build@demo", "dev.qa@demo"], pages: 1, space: { label: "demo" } });
    const firstRun = world.log.findIndex((e) => e.startsWith("run:"));
    expect(world.log.slice(0, firstRun)).toContain("journal");
    expect(world.log.filter((e) => e.startsWith("write:"))).toEqual(["write:t10,t11"]);
    const t = world.terminals.get("t10")!;
    expect(t.labels).toMatchObject({ "openrig.daemon": "inst1", "openrig.role": "viewer", "openrig.op": "n2", "openrig.seat": "dev.build@demo" });
    expect(t.argv.slice(0, 5)).toEqual(["/bin/sh", "-c", expect.stringContaining("exec tail -f /dev/null"), "openrig-viewer", "n2"]);
    expect(t.argv.join(" ")).toContain("attach -r"); // read-only during construction
    // Reveal order: switch to the Rig layout, select the view once the app shows the write, then the keyboard.
    const sw = world.log.findIndex((e) => e.startsWith("do:layout.switch"));
    const sel = world.log.findIndex((e) => e.startsWith(`do:layout.select:{"stack":"rig-work","child":"${result.space!.id}"}`));
    const rw = world.log.findIndex((e) => e.startsWith("tmux:switch-client"));
    expect(sw).toBeGreaterThan(world.log.indexOf("write:t10,t11"));
    expect(sel).toBeGreaterThan(sw);
    expect(rw).toBeGreaterThan(sel);
    // Only the interactive viewer becomes writable.
    // `-t` names the viewer's own session: without it tmux also moves the client to its current session (seen live).
    const session = world.tmuxCalls.find((c) => c.includes("list-clients"))![5]!.slice(1);
    expect(world.tmuxCalls.filter((c) => c.includes("switch-client"))).toEqual([["/usr/bin/tmux", "-L", "openrig", "switch-client", "-c", "/dev/pts/9", "-t", `=${session}`, "-r"]]);
  });

  it("hands the keyboard to interactive seats on every page of a multi-page view, not only the first", async () => {
    const view: ComposedView = { ...composed([]), opened: [pane("dev.build@demo"), pane("dev.qa@demo")], pages: [[pane("dev.build@demo")], [pane("dev.qa@demo")]] };
    const result = await provider.openView(view);
    expect(result).toMatchObject({ ok: true, pages: 2 });
    const writable = world.tmuxCalls.filter((c) => c.includes("switch-client")).map((c) => c[c.indexOf("-t") + 1]);
    expect(writable.sort()).toEqual(["=dev.build@demo", "=dev.qa@demo"]);
  });

  it("never hands the keyboard over while the viewer's tmux client shows another seat's session", async () => {
    world.clientSession = "someone-else@demo";
    const result = await provider.openView(composed([pane("dev.build@demo")]));
    expect(result.ok).toBe(true);
    expect(world.tmuxCalls.some((c) => c.includes("switch-client"))).toBe(false);
    expect(result.notes?.join(" ")).toContain("stays read-only (its tmux client shows someone-else@demo");
  });

  it("never hands the keyboard to a tmux client that isn't the viewer's own (another process attached to the seat)", async () => {
    world.parents = { 4242: 1 };
    const result = await provider.openView(composed([pane("dev.build@demo")]));
    expect(result.ok).toBe(true);
    expect(world.tmuxCalls.some((c) => c.includes("switch-client"))).toBe(false);
    expect(result.notes?.join(" ")).toContain("dev.build · S1: stays read-only");
  });

  it("when the app never shows the write, nothing is selected and every viewer stays read-only", async () => {
    world.applies = false;
    const result = await provider.openView(composed([pane("dev.build@demo")]));
    expect(result.ok).toBe(true);
    expect(world.log.some((e) => e.startsWith("do:layout.select"))).toBe(false);
    expect(world.tmuxCalls).toEqual([]);
    expect(result.notes?.join(" ")).toContain("stay read-only");
  });

  it("opens nothing when herdr-app isn't answering, and gives no attach-by-hand recipe", async () => {
    world.statusKind = "unavailable";
    const result = await provider.openView(composed([pane("dev.build@demo")]));
    expect(result).toMatchObject({ ok: false, code: "herdr_app_unavailable" });
    expect(world.runs).toBe(0);
    expect(JSON.stringify(result)).not.toMatch(/ssh|tmux attach/);
  });

  it("refuses to overwrite a rig.json someone else wrote, before starting anything", async () => {
    writeFileSync(files.rigPath, "{\"id\":\"mine\"}\n");
    const result = await provider.openView(composed([pane("dev.build@demo")]));
    expect(result).toMatchObject({ ok: false, code: "rig_layout_not_owned" });
    expect(world.runs).toBe(0);
    expect(readFileSync(files.rigPath, "utf8")).toBe("{\"id\":\"mine\"}\n");
  });

  it("rolls back a failed open: the started viewer leaves the file first, then only it is ended", async () => {
    world.failRun.add(2);
    const result = await provider.openView(composed([pane("dev.build@demo"), pane("dev.qa@demo")]));
    expect(result).toMatchObject({ ok: false, code: "viewer_start_failed" });
    expect(world.terminals.get("t10")!.state).toBe("finished");
    // Not shown (main), so the app reads the rewritten file when it shows Rig: the end follows the write.
    expect(world.log.indexOf("kill:t10")).toBeGreaterThan(world.log.lastIndexOf("write:"));
    expect(world.log.filter((e) => e.startsWith("write:"))).toEqual(["write:"]);
  });
});

describe("HerdrAppProvider removal: rewrite first, end only after the app applied it", () => {
  async function opened() {
    const r = await provider.openView(composed([pane("dev.build@demo"), pane("dev.qa@demo")]));
    world.log = [];
    return r.space!.id;
  }

  it("with the Rig layout shown: writes without the cells, waits for the exact acknowledgement, then ends only those viewers", async () => {
    const id = await opened();
    const result = await provider.closeView(id);
    expect(result.ok).toBe(true);
    const write = world.log.indexOf("write:");
    expect(world.log.indexOf("kill:t10")).toBeGreaterThan(write);
    expect(world.log.indexOf("kill:t11")).toBeGreaterThan(write);
    expect(await provider.listViews()).toEqual([]);
  });

  it("keeps the viewers running while the app hasn't applied the removal (stale acknowledgement), and ends them once it has", async () => {
    const id = await opened();
    world.applies = false; // the ack still names the revision that shows t10 and t11
    const result = await provider.closeView(id);
    expect(result.notes?.join(" ")).toContain("left running");
    expect(world.terminals.get("t10")!.state).toBe("live");
    world.applies = true;
    world.render(files);
    await provider.reconcile();
    expect(world.terminals.get("t10")!.state).toBe("finished");
    expect(world.terminals.get("t11")!.state).toBe("finished");
  });

  it("rejects an acknowledgement of the right revision that still lists a removed terminal", async () => {
    const id = await opened();
    // The record names the new revision, but the removed viewer is still listed as shown.
    world.stillShown = ["t10"];
    await provider.closeView(id);
    const state = JSON.parse(readFileSync(files.journalPath, "utf8")) as { revision: string };
    expect(world.ack).toEqual({ revision: state.revision, terminals: ["t10"] });
    expect(world.terminals.get("t10")!.state).toBe("live");
    expect(world.terminals.get("t11")!.state).toBe("live"); // the whole removal waits
  });

  it("keeps the viewers running when herdr-app's state is uncertain", async () => {
    const id = await opened();
    world.statusKind = "unknown";
    const result = await provider.closeView(id);
    expect(world.terminals.get("t10")!.state).toBe("live");
    expect(result.notes?.join(" ")).toContain("uncertain");
  });

  it("with another layout shown: ends them right after the rewrite (the app reads the new file when Rig shows)", async () => {
    const id = await opened();
    world.layout = "main";
    world.applies = false;
    await provider.closeView(id);
    expect(world.log.indexOf("kill:t10")).toBeGreaterThan(world.log.indexOf("write:"));
  });

  it("leaves a viewer in place when it can't be verified as this OpenRig's", async () => {
    const id = await opened();
    world.terminals.get("t11")!.labels["openrig.op"] = "someone-else";
    const result = await provider.closeView(id);
    expect(world.terminals.get("t11")!.state).toBe("live");
    expect(result.notes?.join(" ")).toContain("can't be verified");
  });

  it("writes a viewer that ended outside OpenRig as an ended cell, so the layout never references it", async () => {
    await opened();
    world.terminals.get("t10")!.state = "finished";
    const notes = await provider.reconcile();
    expect(notes.join(" ")).toContain("ended outside OpenRig");
    const tree = JSON.parse(readFileSync(files.rigPath, "utf8")) as LayoutNode;
    expect(referencedTerminals(tree)).toEqual(["t11"]);
    expect(JSON.stringify(tree)).toContain("rig-ended");
  });
});

describe("HerdrAppProvider.status and core diagnostics", () => {
  it("names the runner's herdr-core (not a mutated process.env) and the shared-core assumption in status and open diagnostics", async () => {
    makeProvider({ core: { session: "herdr-app-sb", socket: "/srv/core.sock" } });
    const saved = { session: process.env.HC_SESSION, socket: process.env.HC_SOCKET };
    try {
      process.env.HC_SESSION = "wrong-env-session";
      process.env.HC_SOCKET = "/wrong/env.sock";
      const st = await provider.status();
      expect(st.core).toEqual({ session: "herdr-app-sb", socket: "/srv/core.sock" });
      expect(st.assumption).toBe("viewers are started with hc in this core; herdr-app must be a client of it");
    } finally {
      for (const [key, value] of [["HC_SESSION", saved.session], ["HC_SOCKET", saved.socket]] as const) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }

    // 1. herdr_app_unavailable names the runner's core
    world.statusKind = "unavailable";
    const unavail = await provider.openView(composed([pane("dev.build@demo")]));
    expect(unavail.error).toContain('herdr-core session "herdr-app-sb" (socket /srv/core.sock)');

    // 2. viewer_start_failed names the runner's core and hc's error
    world.statusKind = "ok";
    world.failRun.add(1);
    const startFailed = await provider.openView(composed([pane("dev.build@demo")]));
    expect(startFailed.code).toBe("viewer_start_failed");
    expect(startFailed.error).toContain('herdr-core session "herdr-app-sb" (socket /srv/core.sock)');
    expect(startFailed.error).toContain("spawn failed");
    expect(startFailed.error).toContain("herdr-app has to be one of its clients");

    // 3. reveal() no-ack note names the runner's core
    world.failRun.clear();
    world.applies = false;
    const noAck = await provider.openView(composed([pane("dev.build@demo")]));
    expect(noAck.ok).toBe(true);
    expect(noAck.notes?.join(" ")).toContain('herdr-core session "herdr-app-sb" (socket /srv/core.sock)');
  });
});

describe("HerdrAppProvider: every viewer it starts is ended or still tracked", () => {
  const live = () => [...world.terminals].filter(([, t]) => t.state === "live").map(([a]) => a);
  const pending = async () => (await files.load()).pendingEnds.map((p) => [p.terminal, p.revision]);

  it("a missing base layout is found before any viewer starts", async () => {
    await provider.openView(composed([pane("dev.build@demo")]));
    rmSync(join(home, "app", "layouts", "main.json"));
    const runs = world.runs;
    const result = await provider.openView(composed([pane("dev.qa@demo")]));
    expect(result).toMatchObject({ ok: false, code: "base_layout_missing" });
    expect(world.runs).toBe(runs);
    expect(live()).toEqual(["t10"]);
  });

  it("an open whose first write fails ends the viewers it started (no layout ever referenced them)", async () => {
    world.onRun = () => writeFileSync(files.rigPath, "{\"person\":true}\n"); // someone else's rig.json appears mid-open
    const result = await provider.openView(composed([pane("dev.build@demo"), pane("dev.qa@demo")]));
    expect(result).toMatchObject({ ok: false, code: "rig_layout_not_owned" });
    expect(live()).toEqual([]);
    expect(await pending()).toEqual([]);
  });

  it("viewers kept by a failed rewrite are released by the next successful write and then ended", async () => {
    const id = (await provider.openView(composed([pane("dev.build@demo")]))).space!.id;
    const ours = readFileSync(files.rigPath, "utf8");
    writeFileSync(files.rigPath, "{\"person\":true}\n");
    const closed = await provider.closeView(id);
    expect(closed.notes?.join(" ")).toContain("left running until the Rig layout can be rewritten");
    expect(await pending()).toEqual([["t10", "unwritten"]]);
    expect(live()).toEqual(["t10"]);
    writeFileSync(files.rigPath, ours); // the person puts OpenRig's file back
    await provider.openView(composed([pane("dev.qa@demo")]));
    expect(world.terminals.get("t10")!.state).toBe("finished");
    expect(await pending()).toEqual([]);
  });

  it("a core that can't be asked never turns a live viewer into an untracked one", async () => {
    await provider.openView(composed([pane("dev.build@demo")]));
    world.coreDown = true;
    const notes = await provider.reconcile();
    expect(notes.join(" ")).toContain("could not be checked");
    const viewer = (await provider.listViews())[0]!.viewers[0]!;
    expect([viewer.state, viewer.terminal]).toEqual(["live", "t10"]);
  });

  it("a removal whose viewer core can't be asked about stays pending, and ends once core answers", async () => {
    const id = (await provider.openView(composed([pane("dev.build@demo")]))).space!.id;
    world.coreDown = true;
    const closed = await provider.closeView(id);
    expect(closed.notes?.join(" ")).toContain("core could not be asked");
    expect((await pending()).map(([t]) => t)).toEqual(["t10"]);
    world.coreDown = false;
    await provider.reconcile();
    expect(world.terminals.get("t10")!.state).toBe("finished");
    expect(await pending()).toEqual([]);
  });
});
