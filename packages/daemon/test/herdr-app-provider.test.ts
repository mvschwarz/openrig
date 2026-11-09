import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrAppProvider, UNKNOWN_START_TTL_MS } from "../src/domain/terminal/herdr-app-provider.js";
import { HerdrAppClientFiles } from "../src/domain/terminal/herdr-app-state.js";
import { describeModInstall, installRigMods } from "../src/domain/terminal/herdr-app-install.js";
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
  failRunKind = "invalid_params";
  timeoutRun = new Set<number>();
  lateQueue: Array<(labelOverrides?: Record<string, string>) => string> = [];
  runs = 0;
  clock = new Date("2026-11-07T00:00:00.000Z");
  ack: { revision: string; terminals: string[] } | null = null;
  tmuxCalls: string[][] = [];
  /** The process tree: the tmux client 4242 runs beneath the viewer's process 4000. */
  parents: Record<number, number> = { 4242: 4100, 4100: 4000 };
  clientSession: string | null = null;
  /** The tmux client list, when a test replaces the client (a new attach after a handover). */
  clientLine: string | null = null;
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
      if (this.failRun.has(this.runs)) {
        this.log.push("run:failed");
        return { exit: 1, json: null, stdout: "", error: { kind: this.failRunKind, message: "spawn failed" } };
      }
      const sep = args.indexOf("--");
      const argv = args.slice(sep + 1);
      const labels = Object.fromEntries(args.flatMap((a, i) => a === "--label" ? [args[i + 1]!.split("=") as [string, string]] : []));
      if (this.timeoutRun.has(this.runs)) {
        this.log.push("run:timeout");
        this.lateQueue.push((overrides = {}) => {
          const address = `t${this.next++}`;
          this.terminals.set(address, { state: "live", argv, labels: { ...labels, ...overrides } });
          this.log.push(`run:late:${address}`);
          return address;
        });
        return { exit: -1, json: null, stdout: "", error: { message: "hc timed out" } };
      }
      const address = `t${this.next++}`;
      this.terminals.set(address, { state: "live", argv, labels });
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
    if (verb === "ls") {
      if (this.coreDown) return { exit: -1, json: null, stdout: "", error: { message: "timed out" } };
      const wanted = args.flatMap((a, i) => a === "--label" ? [args[i + 1]!.split("=") as [string, string]] : []);
      const terminals = [...this.terminals.entries()]
        .filter(([, t]) => t.state === "live" && wanted.every(([k, v]) => t.labels[k] === v))
        .map(([address, t]) => ({ address, ...t }));
      return { exit: 0, json: { terminals }, stdout: "" };
    }
    return { exit: 2, json: null, stdout: "" };
  };
}

let home: string;
let world: World;
let files: HerdrAppClientFiles;
let provider: HerdrAppProvider;

function makeProvider(opts: { ackTimeoutMs?: number; lateAckMs?: number; latePollMs?: number; hostname?: string; regrantDelaysMs?: number[]; core?: { session: string; socket?: string }; ensureMods?: () => Promise<{ ok: true; notes?: string[] } | { ok: false; error: string }> } = {}) {
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
    ensureMods: opts.ensureMods ?? (async () => ({ ok: true })), ackTimeoutMs: opts.ackTimeoutMs ?? 300, nonce: () => `n${++n}`, now: () => world.clock,
    latePollMs: opts.latePollMs ?? 20, ...(opts.lateAckMs !== undefined ? { lateAckMs: opts.lateAckMs } : {}),
    ...(opts.regrantDelaysMs ? { regrantDelaysMs: opts.regrantDelaysMs } : {}),
    ...(opts.hostname ? { hostname: () => opts.hostname! } : {}),
    runTmux: async (argv) => {
      world.tmuxCalls.push(argv);
      world.log.push(`tmux:${argv.slice(3).join(" ")}`);
      // The client is on the session it was listed for, unless the test moved it.
      const listed = argv.indexOf("list-clients");
      if (listed < 0) return "";
      return world.clientLine ?? `4242 /dev/pts/9 1 ${world.clientSession ?? argv[listed + 2]!.slice(1)}\n`;
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
afterEach(() => { provider?.stop(); rmSync(home, { recursive: true, force: true }); });

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

  it("skips local tmux keyboard handoff for remote ssh viewers (interactive or read-only) with no false read-only note, and migrates journals without attach", async () => {
    const remoteRw: ComposedPane = {
      seat: "dev.remote@demo", label: "dev.remote · S1", runtime: "claude-code", readOnly: false,
      paneCommand: "ssh -t box2 'tmux attach -t =dev.remote@demo'",
    };
    const remoteRo: ComposedPane = {
      seat: "dev.remote-ro@demo", label: "dev.remote-ro · S1", runtime: "claude-code", readOnly: true,
      paneCommand: "ssh -t box2 'tmux attach -r -t =dev.remote-ro@demo'",
    };
    const result = await provider.openView(composed([remoteRw, remoteRo]));
    expect(result.ok).toBe(true);
    expect(world.tmuxCalls).toEqual([]);
    expect((result.notes ?? []).join(" ")).not.toContain("stays read-only");
    const saved = await files.load();
    expect(saved.views[0]!.viewers.map((v) => v.attach)).toEqual(["remote", "remote"]);
    expect(saved.views[0]!.viewers[0]!.argv.slice(4)).toEqual(["n2", "/bin/sh", "-c", remoteRw.paneCommand]);

    // Old journal without `attach` migrates by checking whether argv contains "openrig-tile"
    const raw = JSON.parse(readFileSync(files.journalPath, "utf8")) as { views: Array<{ viewers: Array<Record<string, unknown>> }> };
    delete raw.views[0]!.viewers[0]!.attach;
    raw.views[0]!.viewers.push({
      cellId: "cell-local", seat: "dev.local@demo", label: "dev.local · S1", nonce: "n99",
      argv: ["/bin/sh", "-c", "wrapper", "openrig-viewer", "n99", "/bin/sh", "-c", "script", "openrig-tile", "dev.local@demo", "/usr/bin/tmux"],
      readOnly: false, terminal: "t99", state: "live",
    });
    writeFileSync(files.journalPath, JSON.stringify(raw));
    const migrated = await files.load();
    expect(migrated.views[0]!.viewers.map((v) => [v.seat, v.attach])).toEqual([
      ["dev.remote@demo", "remote"],
      ["dev.remote-ro@demo", "remote"],
      ["dev.local@demo", "local"],
    ]);
  });

  it("when the app never confirms the write, the open says so: nothing opened, every seat unconfirmed, viewers and journal kept, read-only", async () => {
    world.applies = false;
    const result = await provider.openView(composed([pane("dev.build@demo"), pane("dev.qa@demo")]));
    expect(result).toMatchObject({ ok: false, opened: [], pages: 1 });
    expect(result.degraded).toEqual([
      { seat: "dev.build@demo", host: "herdr-app", code: "pane_unconfirmed", reason: expect.stringContaining("has not confirmed showing this view") },
      { seat: "dev.qa@demo", host: "herdr-app", code: "pane_unconfirmed", reason: expect.stringContaining("has not confirmed showing this view") },
    ]);
    expect(result.notes?.join(" ")).toContain("stay read-only until it does");
    expect(result.notes?.join(" ")).not.toContain("appears there");
    // No retry and no rollback: the viewers run and the journal keeps them.
    expect(world.log.some((e) => e.startsWith("kill:"))).toBe(false);
    expect(world.runs).toBe(2);
    expect((await files.load()).views.flatMap((v) => v.viewers).map((v) => [v.seat, v.state])).toEqual([["dev.build@demo", "live"], ["dev.qa@demo", "live"]]);
    expect(world.log.some((e) => e.startsWith("do:layout.select"))).toBe(false);
    expect(world.tmuxCalls).toEqual([]);
  });

  it("a confirmed open lists every seat as opened and none as unconfirmed", async () => {
    const result = await provider.openView(composed([pane("dev.build@demo")]));
    expect(result).toMatchObject({ ok: true, opened: ["dev.build@demo"], degraded: [] });
  });

  describe("writable intent survives a late acknowledgement and a replaced tmux client", () => {
    const switches = () => world.tmuxCalls.filter((c) => c.includes("switch-client"));
    const viewers = async () => (await files.load()).views.flatMap((v) => v.viewers);
    const until = async (check: () => boolean) => { for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 10)); };

    it("a view the app shows only after the open's wait becomes writable then, without selecting it", async () => {
      world.applies = false;
      const result = await provider.openView(composed([pane("dev.build@demo"), pane("dev.qa@demo", true)]));
      expect(switches()).toEqual([]);
      expect((await viewers()).map((v) => v.writable)).toEqual(["pending", undefined]);
      // The app catches up after the 8 s wait.
      world.applies = true;
      world.render(files);
      await until(() => switches().length > 0);
      expect(switches()).toEqual([["/usr/bin/tmux", "-L", "openrig", "switch-client", "-c", "/dev/pts/9", "-t", "=dev.build@demo", "-r"]]);
      // The grant is journalled right after the handover.
      for (let i = 0; i < 100 && (await viewers())[0]!.writable !== "granted"; i++) await new Promise((r) => setTimeout(r, 10));
      expect((await viewers()).map((v) => v.writable)).toEqual(["granted", undefined]); // the read-only pane never is
      expect(world.log.some((e) => e.startsWith("do:layout.select"))).toBe(false);
      void result;
    });

    it("stops waiting for a late acknowledgement at its deadline", async () => {
      makeProvider({ lateAckMs: 50 });
      world.applies = false;
      await provider.openView(composed([pane("dev.build@demo")]));
      await new Promise((r) => setTimeout(r, 150));
      world.applies = true;
      world.render(files);
      await new Promise((r) => setTimeout(r, 100));
      expect(switches()).toEqual([]);
      expect((await viewers())[0]!.writable).toBe("pending");
    });

    it("a new tmux client for the same agent (after a handover or restart) gets the keyboard back", async () => {
      await provider.openView(composed([pane("dev.build@demo")]));
      expect((await viewers())[0]!.writable).toBe("granted");
      world.tmuxCalls = [];
      // The tile attached again: a new read-only client beneath the same viewer.
      world.parents[4343] = 4100;
      world.clientLine = "4343 /dev/pts/11 1 dev.build@demo\n";
      expect(await provider.regrant()).toEqual([]);
      expect(switches()).toEqual([["/usr/bin/tmux", "-L", "openrig", "switch-client", "-c", "/dev/pts/11", "-t", "=dev.build@demo", "-r"]]);
      // Already writable: nothing is toggled back.
      world.tmuxCalls = [];
      world.clientLine = "4343 /dev/pts/11 0 dev.build@demo\n";
      await provider.regrant();
      expect(switches()).toEqual([]);
    });

    it("never hands the keyboard to a read-only pane, another agent's client, or a client outside the viewer", async () => {
      await provider.openView(composed([pane("dev.build@demo"), pane("dev.qa@demo", true)]));
      world.tmuxCalls = [];
      world.clientSession = "someone-else@demo"; // the client shows another agent
      const notes = await provider.regrant();
      expect(switches()).toEqual([]);
      expect(notes.join(" ")).toContain("stays read-only (its tmux client shows someone-else@demo");
      world.clientSession = null;
      world.parents = { 4242: 1 }; // not beneath this viewer
      expect((await provider.regrant()).join(" ")).toContain("dev.build · S1: stays read-only");
      expect(switches()).toEqual([]);
    });

    it("a replacement schedules regrants, and stop() cancels them", async () => {
      makeProvider({ regrantDelaysMs: [20] });
      await provider.openView(composed([pane("dev.build@demo")]));
      world.tmuxCalls = [];
      world.parents[4343] = 4100;
      world.clientLine = "4343 /dev/pts/11 1 dev.build@demo\n";
      provider.regrantSoon();
      await until(() => switches().length > 0);
      expect(switches()).toHaveLength(1);
      world.tmuxCalls = [];
      provider.regrantSoon();
      provider.stop();
      await new Promise((r) => setTimeout(r, 60));
      expect(switches()).toEqual([]);
    });
  });

  it("opens nothing when herdr-app isn't answering, and gives no attach-by-hand recipe", async () => {
    world.statusKind = "unavailable";
    const result = await provider.openView(composed([pane("dev.build@demo")]));
    expect(result).toMatchObject({ ok: false, code: "herdr_app_unavailable" });
    expect(world.runs).toBe(0);
    expect(JSON.stringify(result)).not.toMatch(/ssh|tmux attach/);
  });

  it("with no window at the app home, says it looked on the daemon's own machine; a window that is there but doesn't answer isn't told that", async () => {
    makeProvider({ hostname: "daemon-host" });
    world.statusKind = "unavailable";
    const missing = await provider.openView(composed([pane("dev.build@demo")]));
    expect(missing.error).toContain("This daemon looked on its own machine (daemon-host); herdr-app has to run on the machine the daemon runs on.");
    world.statusKind = "unknown";
    const silent = await provider.openView(composed([pane("dev.build@demo")]));
    expect(silent).toMatchObject({ ok: false, code: "herdr_app_unavailable" });
    expect(silent.error).not.toContain("own machine");
    expect(world.runs).toBe(0);
  });

  it("refuses to overwrite a rig.json someone else wrote, before starting anything", async () => {
    writeFileSync(files.rigPath, "{\"id\":\"mine\"}\n");
    const result = await provider.openView(composed([pane("dev.build@demo")]));
    expect(result).toMatchObject({ ok: false, code: "rig_layout_not_owned" });
    expect(world.runs).toBe(0);
    expect(readFileSync(files.rigPath, "utf8")).toBe("{\"id\":\"mine\"}\n");
  });

  it("a mod folder the person changed doesn't block the open: it stays as it is, the other mods install, and the open's notes say why", async () => {
    const appHome = join(home, "app");
    mkdirSync(join(appHome, "mods", "rig-pad"), { recursive: true });
    writeFileSync(join(appHome, "mods", "rig-pad", "main.js"), "// the person's own rig-pad");
    // Wired as startup wires it: the real installer.
    makeProvider({
      ensureMods: async () => {
        const installed = await installRigMods(appHome);
        if (!installed.ok) return { ok: false, error: describeModInstall(installed) };
        return { ok: true, ...(installed.refused.length || installed.error ? { notes: [describeModInstall(installed)] } : {}) };
      },
    });
    const result = await provider.openView(composed([pane("dev.build@demo")]));
    expect(result).toMatchObject({ ok: true, opened: ["dev.build@demo"] });
    expect(result.notes?.[0]).toMatch(/kept rig-pad unchanged\. .*rig-pad isn't the copy OpenRig installed/);
    expect(readFileSync(join(appHome, "mods", "rig-pad", "main.js"), "utf8")).toBe("// the person's own rig-pad");
    expect(existsSync(join(appHome, "mods", "rig-strip", "main.js"))).toBe(true);
  });

  it("only a needed mod that is missing stops an open, before any hc run or layout write; closeView and reconcile on an earlier view still work", async () => {
    const opened = await provider.openView(composed([pane("dev.build@demo")]));
    expect(opened.ok).toBe(true);
    const viewId = opened.space!.id;
    const runsBefore = world.runs;
    const writesBefore = world.log.filter((e) => e.startsWith("write:")).length;

    makeProvider({
      ensureMods: async () => ({ ok: false, error: "OpenRig's herdr-app mods rig-pad are missing and could not be installed. OpenRig's rig-pad mod is missing from /shipped; reinstall OpenRig." }),
    });
    const refused = await provider.openView(composed([pane("dev.qa@demo")]));
    expect(refused).toMatchObject({ ok: false, code: "herdr_app_mods" });
    expect(refused.error).toBe("OpenRig's herdr-app mods rig-pad are missing and could not be installed. OpenRig's rig-pad mod is missing from /shipped; reinstall OpenRig. Nothing was started.");
    expect(world.runs).toBe(runsBefore);
    expect(world.log.filter((e) => e.startsWith("write:")).length).toBe(writesBefore);

    expect(await provider.reconcile()).toEqual([]);
    const closed = await provider.closeView(viewId);
    expect(closed.ok).toBe(true);
    expect(world.terminals.get("t10")!.state).toBe("finished");
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
    expect(noAck).toMatchObject({ ok: false, opened: [] });
    expect(noAck.notes?.join(" ")).toContain('herdr-core session "herdr-app-sb" (socket /srv/core.sock)');

    // 4. status() survives a corrupt journal and reports pendingStarts: "unknown"
    writeFileSync(files.journalPath, "{corrupt json");
    const corruptStatus = await provider.status();
    expect(corruptStatus.available).toBe(true);
    expect(corruptStatus.pendingStarts).toBe("unknown");
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

  it("tracks a viewer start whose hc run outcome is unknown, and resolves or expires it safely", async () => {
    // (a) run times out + ls empty -> viewer_start_failed, pendingEnds holds a terminal:null entry with the nonce
    world.timeoutRun.add(1);
    const failed = await provider.openView(composed([pane("dev.build@demo")]));
    expect(failed.code).toBe("viewer_start_failed");
    const stateA = await files.load();
    expect(stateA.pendingEnds).toHaveLength(1);
    expect(stateA.pendingEnds[0]).toMatchObject({ terminal: null, nonce: "n2", seat: "dev.build@demo" });
    expect((await provider.status()).pendingStarts).toBe(1);

    // (e) hc ls failing keeps the entry with a note
    world.coreDown = true;
    const downNotes = await provider.reconcile();
    expect(downNotes.join(" ")).toContain("could not be checked");
    expect((await files.load()).pendingEnds).toHaveLength(1);
    world.coreDown = false;

    // (b) the terminal appears later with matching labels+argv -> reconcile() kills it, pendingEnds empty
    const lateAddr = world.lateQueue.shift()!();
    expect(world.terminals.get(lateAddr)!.state).toBe("live");
    await provider.reconcile();
    expect(world.terminals.get(lateAddr)!.state).toBe("finished");
    expect((await files.load()).pendingEnds).toEqual([]);
    expect((await provider.status()).pendingStarts).toBe(0);

    // (c) appears with another openrig.daemon label -> left running, note "can't be verified as this OpenRig's"
    world.timeoutRun.add(world.runs + 1);
    await provider.openView(composed([pane("dev.build@demo")]));
    const foreignAddr = world.lateQueue.shift()!({ "openrig.daemon": "other-daemon" });
    const foreignNotes = await provider.reconcile();
    expect(world.terminals.get(foreignAddr)!.state).toBe("live");
    expect(foreignNotes.join(" ")).toContain("can't be verified as this OpenRig's");
    expect((await files.load()).pendingEnds).toEqual([]);

    // (d) never appears, clock past UNKNOWN_START_TTL_MS -> entry dropped with note
    world.timeoutRun.add(world.runs + 1);
    await provider.openView(composed([pane("dev.build@demo")]));
    world.lateQueue.shift(); // never spawns in core
    world.clock = new Date(world.clock.getTime() + UNKNOWN_START_TTL_MS + 1_000);
    const expiredNotes = await provider.reconcile();
    expect(expiredNotes.join(" ")).toContain("dev.build@demo: its viewer never appeared in the daemon's herdr-core; no longer tracked.");
    expect((await files.load()).pendingEnds).toEqual([]);

    // (f) a definite pre-spawn hc run error (invalid_params / not_found / conflict) tracks nothing
    for (const definiteKind of ["invalid_params", "not_found", "conflict"]) {
      world.failRunKind = definiteKind;
      world.failRun.add(world.runs + 1);
      const definite = await provider.openView(composed([pane("dev.build@demo")]));
      expect(definite.code).toBe("viewer_start_failed");
      expect((await files.load()).pendingEnds).toEqual([]);
    }

    // (g) herdr-core's default 'internal' error kind (or any unknown kind) is treated as uncertain and tracked
    world.failRunKind = "internal";
    world.failRun.add(world.runs + 1);
    const internalFail = await provider.openView(composed([pane("dev.build@demo")]));
    expect(internalFail.code).toBe("viewer_start_failed");
    const stateG = await files.load();
    expect(stateG.pendingEnds).toHaveLength(1);
    expect(stateG.pendingEnds[0]).toMatchObject({ terminal: null, seat: "dev.build@demo" });
    world.clock = new Date(world.clock.getTime() + UNKNOWN_START_TTL_MS + 1_000);
    await provider.reconcile();
    expect((await files.load()).pendingEnds).toEqual([]);

    // (h) a 'planned' viewer row left behind by a daemon crash mid-open is swept into pendingEnds on reconcile/open
    // rather than rendered as a phantom rig-ended cell
    const crashedState = await files.load();
    crashedState.views.push({
      id: "rv-crashed",
      name: "crashed",
      source: { view: "rig:demo", page: 0 },
      createdAt: world.clock.toISOString(),
      viewers: [{
        cellId: "rv-crashed:dev.build@demo:n-crash",
        seat: "dev.build@demo",
        label: "dev.build · s1",
        nonce: "n-crash",
        argv: ["sh", "-c", "exec tmux attach -r -t =dev.build@demo", "openrig-tile", "dev.build@demo", "tmux"],
        readOnly: false,
        attach: "local",
        terminal: null,
        state: "planned",
      }],
    });
    await files.save(crashedState);
    world.terminals.set("t99", {
      state: "live",
      pid: 999,
      argv: ["sh", "-c", "exec tmux attach -r -t =dev.build@demo", "openrig-tile", "dev.build@demo", "tmux"],
      labels: {
        "openrig.daemon": "inst1",
        "openrig.role": "viewer",
        "openrig.view": "rv-crashed",
        "openrig.op": "n-crash",
        "openrig.seat": "dev.build@demo",
        "openrig.cell": "rv-crashed:dev.build@demo:n-crash",
      },
    });
    expect((await provider.status()).pendingStarts).toBe(1);
    await provider.reconcile();
    expect(world.terminals.get("t99")!.state).toBe("finished");
    const afterCrashReconcile = await files.load();
    expect(afterCrashReconcile.views).toEqual([]);
    expect(afterCrashReconcile.pendingEnds).toEqual([]);
  });

  it("rejects non-object journal roots without overwriting the journal, and treats corrupt or non-object base layouts as missing", async () => {
    const { dirname } = await import("node:path");
    mkdirSync(dirname(files.journalPath), { recursive: true });
    for (const nonObject of ["null", "[]", "42", "\"scalar\""]) {
      writeFileSync(files.journalPath, nonObject);
      await expect(files.load()).rejects.toThrow("is not a journal object");
      expect(readFileSync(files.journalPath, "utf8")).toBe(nonObject);
    }
    rmSync(files.journalPath, { force: true });

    for (const badLayout of ["{ not json", "null", "[]", "42", "\"scalar\""]) {
      writeFileSync(files.layoutPath("main"), badLayout);
      expect(await files.readLayout("main")).toBeNull();
      const opened = await provider.openView(composed([pane("dev.build@demo")]));
      expect(opened).toMatchObject({ ok: false, code: "base_layout_missing" });
    }
  });

  it("watchHerdrApp retries after a child spawn error (e.g. ENOENT) and ignores stale child exit events", async () => {
    const { EventEmitter } = await import("node:events");
    const { createHerdrAppWatcher } = await import("../src/startup.js");

    type FakeChild = InstanceType<typeof EventEmitter> & {
      stdout: InstanceType<typeof EventEmitter>;
      unref: () => void;
    };
    const spawned: FakeChild[] = [];
    const spawnFn = (() => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        unref: () => {},
      });
      spawned.push(child);
      return child as unknown as import("node:child_process").ChildProcess;
    }) as unknown as typeof import("node:child_process").spawn;

    let reconciled = 0;
    const watch = createHerdrAppWatcher({
      daemonInstance: "inst1",
      env: {},
      reconcileAll: () => { reconciled++; },
      spawnFn,
      retryMs: 15,
    });

    watch();
    expect(spawned).toHaveLength(1);
    // Calling watch() while a child is active is a no-op.
    watch();
    expect(spawned).toHaveLength(1);

    // Emit a spawn error (Node emits 'error' without 'exit' on ENOENT): must clear herdrAppEvents and retry.
    const first = spawned[0]!;
    first.emit("error", Object.assign(new Error("spawn hc ENOENT"), { code: "ENOENT" }));
    await new Promise((r) => setTimeout(r, 35));
    expect(spawned).toHaveLength(2);

    // A late 'exit' from the stale first child must not clear or replace the active second child.
    first.emit("exit", 1, null);
    watch();
    expect(spawned).toHaveLength(2);

    // Data on the active second child triggers debounced reconcileAll.
    const second = spawned[1]!;
    second.stdout.emit("data", Buffer.from("{}\n"));
    await new Promise((r) => setTimeout(r, 230));
    expect(reconciled).toBe(1);
  });

  it("watchHerdrApp backs off while hc keeps failing, up to a cap, and starts over once a child reports", async () => {
    const { EventEmitter } = await import("node:events");
    const { createHerdrAppWatcher } = await import("../src/startup.js");
    const spawned: Array<InstanceType<typeof EventEmitter> & { stdout: InstanceType<typeof EventEmitter> }> = [];
    const spawnFn = (() => {
      const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), unref: () => {} });
      spawned.push(child);
      return child as unknown as import("node:child_process").ChildProcess;
    }) as unknown as typeof import("node:child_process").spawn;
    vi.useFakeTimers();
    try {
      const watch = createHerdrAppWatcher({ daemonInstance: "inst1", env: {}, reconcileAll: () => {}, spawnFn, retryMs: 100, maxRetryMs: 400 });
      watch();
      // Each failing child waits twice as long as the one before, up to the cap: 100, 200, 400, 400 ms.
      const waits: number[] = [];
      for (let i = 0; i < 4; i++) {
        const before = spawned.length;
        spawned.at(-1)!.emit("error", Object.assign(new Error("spawn hc ENOENT"), { code: "ENOENT" }));
        let waited = 0;
        while (spawned.length === before && waited < 1_000) { await vi.advanceTimersByTimeAsync(10); waited += 10; }
        waits.push(waited);
      }
      expect(waits).toEqual([100, 200, 400, 400]);
      // A child that reports resets it.
      spawned.at(-1)!.stdout.emit("data", Buffer.from("{}\n"));
      const before = spawned.length;
      spawned.at(-1)!.emit("exit", 1, null);
      await vi.advanceTimersByTimeAsync(100);
      expect(spawned.length).toBe(before + 1);
      watch.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("startup wiring (createHerdrAppProviders): passive lookups, views recovered after a restart, stop", () => {
  type FakeChild = import("node:events").EventEmitter & { stdout: import("node:events").EventEmitter; unref(): void; kill(): void; killed: boolean; exitCode: number | null; signalCode: string | null; args: string[] };
  let spawned: FakeChild[];
  let spawnFn: typeof import("node:child_process").spawn;
  let herdrAppDir: string;
  const hcCalls: string[][] = [];
  const hc: HcRunner = async (args) => {
    hcCalls.push(args);
    // The viewer recorded as live ended while the daemon was down.
    if (args[0] === "get") return { exit: 3, json: null, stdout: "", error: { kind: "not_found" } };
    return { exit: 0, json: { terminals: [] }, stdout: "" };
  };

  beforeEach(async () => {
    const { EventEmitter } = await import("node:events");
    spawned = [];
    hcCalls.length = 0;
    herdrAppDir = join(home, "openrig", "private", "herdr-app");
    spawnFn = ((_cmd: string, args: string[]) => {
      const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), unref: () => {}, killed: false, exitCode: null, signalCode: null, args,
        kill() { child.killed = true; child.emit("exit", null, "SIGTERM"); } }) as FakeChild;
      spawned.push(child);
      return child as unknown as import("node:child_process").ChildProcess;
    }) as unknown as typeof import("node:child_process").spawn;
  });

  const create = async () => {
    const { createHerdrAppProviders } = await import("../src/startup.js");
    return createHerdrAppProviders({ herdrAppDir, daemonInstance: "inst1", hcEnv: {}, hc, defaultAppHome: () => join(home, "app"), spawnFn });
  };

  it("a status, a listing and a refused open start no hc events and create no viewers folder", async () => {
    const herdrApp = await create();
    await herdrApp.recovered;
    const provider = herdrApp.resolve({})!;
    const status = await provider.status(); // no window answers at this app home
    expect(status.available).toBe(false);
    expect(await provider.listViews()).toEqual([]);
    expect((await provider.openView(composed([pane("dev.build@demo")]))).code).toBe("herdr_app_unavailable");
    expect(spawned).toEqual([]);
    expect(existsSync(join(herdrAppDir, "viewers"))).toBe(false);
    expect(hcCalls).toEqual([]);
    herdrApp.stop();
  });

  it("after a restart, a recorded view gets its owner back: the watcher starts and a viewer that ended outside OpenRig is rewritten", async () => {
    const appHome = join(home, "app");
    const journal = new HerdrAppClientFiles(appHome, join(herdrAppDir, "clients"));
    await journal.save({ appHome, base: "main", revision: null, writtenSha: null, pendingEnds: [], views: [{
      id: "rv-1", name: "demo", source: { view: "rig:demo", page: 0 }, createdAt: "2026-11-07T00:00:00.000Z",
      viewers: [{ cellId: "c-1", seat: "dev.build@demo", label: "dev.build · S1", nonce: "n1", argv: ["/bin/sh"], readOnly: false,
        attach: "local", writable: "granted", terminal: "t5", state: "live" }],
    }] });
    const herdrApp = await create();
    await herdrApp.recovered;
    expect(spawned.map((c) => c.args)).toEqual([["events", "--json", "--label", "openrig.daemon=inst1"]]);
    expect(existsSync(join(herdrAppDir, "viewers"))).toBe(true);
    const viewer = (await journal.load()).views[0]!.viewers[0]!;
    expect(viewer).toMatchObject({ state: "ended", terminal: null });
    const rig = readFileSync(journal.rigPath, "utf8");
    expect(rig).toContain("rv-1");
    expect(rig).not.toContain("\"t5\"");
    herdrApp.stop();
  });

  it("a journal with nothing left to own starts nothing", async () => {
    const appHome = join(home, "app");
    await new HerdrAppClientFiles(appHome, join(herdrAppDir, "clients")).save({ appHome, base: "main", revision: null, writtenSha: null, pendingEnds: [], views: [] });
    const herdrApp = await create();
    await herdrApp.recovered;
    expect(spawned).toEqual([]);
    herdrApp.stop();
  });

  it("stop() ends only OpenRig's own watcher child, and nothing restarts it", async () => {
    const appHome = join(home, "app");
    await new HerdrAppClientFiles(appHome, join(herdrAppDir, "clients")).save({ appHome, base: "main", revision: null, writtenSha: null, pendingEnds: [], views: [{
      id: "rv-1", name: "demo", source: { view: "rig:demo", page: 0 }, createdAt: "2026-11-07T00:00:00.000Z",
      viewers: [{ cellId: "c-1", seat: "dev.build@demo", label: "dev.build · S1", nonce: "n1", argv: ["/bin/sh"], readOnly: false, attach: "local", terminal: "t5", state: "live" }],
    }] });
    const herdrApp = await create();
    await herdrApp.recovered;
    expect(spawned).toHaveLength(1);
    herdrApp.stop();
    expect(spawned[0]!.killed).toBe(true);
    await new Promise((r) => setTimeout(r, 30));
    expect(spawned).toHaveLength(1); // the exit after stop() schedules no retry
    // A later owned-work request after shutdown starts nothing either.
    herdrApp.resolve({})!.closeView("rv-1").catch(() => {});
    await new Promise((r) => setTimeout(r, 30));
    expect(spawned).toHaveLength(1);
  });
});
