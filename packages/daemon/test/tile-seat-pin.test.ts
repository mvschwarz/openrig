// A Herdr view's writable tile is a tmux client of its seat, so watching a seat in Herdr resized the agent's real pane to
// the tile, where it stayed. These cells run the real pinned tile script on isolated tmux servers: a 160x50 seat, and a
// 100x30 "tile" (a pane on a second server running the tile's argv, as a Herdr tile does), with focus in and out sent as
// the terminal would send them.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { pinnedTileAttachArgv, SEAT_PIN_HEIGHT_OPTION, SEAT_PIN_WIDTH_OPTION, tileAttachArgv } from "../src/domain/terminal/tile-attach.js";
import { shellQuote } from "../src/adapters/shell-quote.js";
import { WINDOW_SIZE_PRIOR_OPTION } from "../src/terminal/window-pin.js";
import { composeView, type ViewMemberInput } from "../src/domain/terminal/view-composer.js";
import { TerminalService, type TerminalServiceDeps } from "../src/domain/terminal/terminal-service.js";
import { HerdrAdapter } from "../src/domain/terminal/herdr-adapter.js";
import type { ComposedView, OpenViewResult, TerminalProvider } from "../src/domain/terminal/terminal-provider.js";

const servers: string[] = [];
const server = (name: string) => { const socket = `tpin-${name}-${randomBytes(3).toString("hex")}`; servers.push(socket); return socket; };
const tmux = (socket: string, args: string[]) =>
  execFileSync("tmux", ["-L", socket, "-f", "/dev/null", ...args], { encoding: "utf8", stdio: "pipe", env: { ...process.env, TMUX: "" } });
afterEach(() => { for (const socket of servers.splice(0)) { try { tmux(socket, ["kill-server"]); } catch { /* already gone */ } } });
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function eventually(read: () => string, want: string): Promise<string> {
  let seen = read();
  for (let i = 0; i < 100 && seen !== want; i++) { await pause(50); try { seen = read(); } catch { seen = ""; } }
  return seen;
}

/** A seat session at 160x50 with a managed identity, on a server an anchor session keeps alive through a replacement. */
function seatOn(name: string, session = "seat@rig") {
  const socket = server(name);
  tmux(socket, ["new-session", "-d", "-s", "anchor", "sleep 120"]);
  const create = () => tmux(socket, ["new-session", "-d", "-s", session, "-x", "160", "-y", "50", "-e", "OPENRIG_NODE_ID=node1", "sleep 120"]);
  create();
  const read = (format: string) => tmux(socket, ["display-message", "-p", "-t", `=${session}:`, format]).trim();
  const option = (name: string) => tmux(socket, ["show-options", "-wqv", "-t", `=${session}:`, name]).trim();
  const hooks = () => tmux(socket, ["show-hooks", "-t", session]).split("\n").filter(line => line.includes("resize-window")).map(line => line.split(" ")[0]);
  const clients = () => tmux(socket, ["list-clients", "-F", "#{session_name}"]).trim();
  const clientPid = () => Number(tmux(socket, ["list-clients", "-F", "#{client_pid}"]).trim());
  return { socket, session, create, size: () => read("#{window_width}x#{window_height}"), sessionId: () => read("#{session_id}"), option, hooks, clients, clientPid };
}

/** The tile: the real pinned argv in a 100x30 pane on its own server. Focus in is ESC [ I, focus out ESC [ O. */
function tileOn(seat: ReturnType<typeof seatOn>) {
  const socket = server("tile");
  const argv = pinnedTileAttachArgv("tmux", ["-L", seat.socket], seat.session);
  tmux(socket, ["new-session", "-d", "-s", "tile", "-x", "100", "-y", "30", `env -u TMUX ${argv.map(shellQuote).join(" ")}`]);
  const focus = (key: "49" | "4f") => tmux(socket, ["send-keys", "-t", "tile", "-H", "1b", "5b", key]);
  const panePid = () => Number(tmux(socket, ["display-message", "-p", "-t", "tile", "#{pane_pid}"]).trim());
  return { socket, focusIn: () => focus("49"), focusOut: () => focus("4f"), close: () => tmux(socket, ["kill-server"]), panePid };
}

describe("a Herdr view's writable tile pins its seat before each attach", () => {
  it("keeps the seat at its size while the tile watches, fits it only while the tile has focus, and gives the size back", async () => {
    const seat = seatOn("watch");
    const tile = tileOn(seat);
    expect(await eventually(seat.clients, seat.session)).toBe(seat.session);
    expect(seat.size()).toBe("160x50"); // watched: unchanged
    expect([seat.option("window-size"), seat.option(SEAT_PIN_WIDTH_OPTION), seat.option(SEAT_PIN_HEIGHT_OPTION)]).toEqual(["manual", "160", "50"]);
    expect(seat.hooks()).toEqual(["client-detached[93]", "client-focus-in[93]", "client-focus-out[93]"]);

    tile.focusIn();
    expect(await eventually(seat.size, "100x30")).toBe("100x30"); // typing: it fits the focused tile
    tile.focusOut();
    expect(await eventually(seat.size, "160x50")).toBe("160x50"); // focus elsewhere: its own size again
    tile.focusIn();
    expect(await eventually(seat.size, "100x30")).toBe("100x30");
    tile.close();
    expect(await eventually(seat.size, "160x50")).toBe("160x50"); // the tile closed: its own size again
  });

  // A terminal closing a tile hangs up its pane. A tmux client that exits on a hangup leaves its session before tmux runs
  // client-detached, so that hook runs in another session's context and the seat's own hook isn't read: without the
  // tile's own give-back, the seat stayed at the tile's size. Each way of hanging up is driven exactly, not left to a race.
  it.each([
    ["its tmux client", (seat: ReturnType<typeof seatOn>) => process.kill(seat.clientPid(), "SIGHUP")],
    ["its whole pane", (_seat: ReturnType<typeof seatOn>, tile: ReturnType<typeof tileOn>) => process.kill(-tile.panePid(), "SIGHUP")],
  ] as const)("gives the seat its own size back when %s gets a hangup while the tile has focus", async (_label, hangUp) => {
    const seat = seatOn("hangup");
    const tile = tileOn(seat);
    expect(await eventually(seat.clients, seat.session)).toBe(seat.session);
    tile.focusIn();
    expect(await eventually(seat.size, "100x30")).toBe("100x30");
    hangUp(seat, tile);
    expect(await eventually(seat.size, "160x50")).toBe("160x50");
    expect([seat.option("window-size"), seat.option(SEAT_PIN_WIDTH_OPTION), seat.option(SEAT_PIN_HEIGHT_OPTION)]).toEqual(["manual", "160", "50"]);
  });

  it("pins a replacement session with the same seat identity before the tile attaches to it", async () => {
    const seat = seatOn("replace");
    tileOn(seat);
    expect(await eventually(seat.clients, seat.session)).toBe(seat.session);
    const first = seat.sessionId();
    tmux(seat.socket, ["kill-session", "-t", first]);
    seat.create(); // a handover, fresh launch or restart: same name, same managed identity, no new open
    const second = seat.sessionId();
    expect(second).not.toBe(first);
    expect(await eventually(seat.clients, seat.session)).toBe(seat.session); // the tile followed it
    expect(seat.size()).toBe("160x50");
    expect([seat.option("window-size"), seat.option(SEAT_PIN_WIDTH_OPTION), seat.option(SEAT_PIN_HEIGHT_OPTION)]).toEqual(["manual", "160", "50"]);
    expect(seat.hooks()).toEqual(["client-detached[93]", "client-focus-in[93]", "client-focus-out[93]"]);
  });

  it("stays unpinned once window-size is unset: focus, blur and detach leave the seat to its clients", async () => {
    const seat = seatOn("unpin");
    const tile = tileOn(seat);
    expect(await eventually(seat.clients, seat.session)).toBe(seat.session);
    expect(seat.option("window-size")).toBe("manual");
    tmux(seat.socket, ["set-option", "-w", "-u", "-t", `=${seat.session}:`, "window-size"]); // the documented unpin
    // The tile is its latest client now: 100x29 under the tile's status line. A focus fit would make it 100x30 and manual
    // again, and a blur or detach would give back 160x50.
    expect(await eventually(seat.size, "100x29")).toBe("100x29");
    for (const step of [tile.focusIn, tile.focusOut, tile.focusIn, tile.close]) {
      step();
      await pause(600); // the hooks run in the background; give a resize the time a fit takes above
      expect(seat.option("window-size")).toBe("");
      expect(seat.size()).toBe("100x29");
    }
  });

  it("after the complete unpin, a size the person fixes is theirs: focus, blur, close and the next tile leave it", async () => {
    const seat = seatOn("owner");
    const tile = tileOn(seat);
    expect(await eventually(seat.clients, seat.session)).toBe(seat.session);
    const w = `=${seat.session}:`;
    // The documented unpin: the window's setting and OpenRig's record together.
    tmux(seat.socket, ["set-window-option", "-t", w, "-u", "window-size", ";", "set-window-option", "-t", w, "-u", SEAT_PIN_WIDTH_OPTION,
      ";", "set-window-option", "-t", w, "-u", SEAT_PIN_HEIGHT_OPTION]);
    expect([seat.option(SEAT_PIN_WIDTH_OPTION), seat.option(SEAT_PIN_HEIGHT_OPTION)]).toEqual(["", ""]);
    tmux(seat.socket, ["resize-window", "-t", w, "-x", "90", "-y", "27"]); // the person's own fixed size (manual)
    for (const step of [tile.focusIn, tile.focusOut, tile.close]) {
      step();
      await pause(600);
      expect([seat.size(), seat.option("window-size")]).toEqual(["90x27", "manual"]);
    }
    tileOn(seat); // the next Herdr tile: a manual window without the record is someone else's
    expect(await eventually(seat.clients, seat.session)).toBe(seat.session);
    expect([seat.size(), seat.option(SEAT_PIN_WIDTH_OPTION)]).toEqual(["90x27", ""]);
  });

  it("after an unpin, a temporary window pin (a web terminal's or a readable capture's) holds the window without the hooks", async () => {
    const seat = seatOn("temporary");
    const tile = tileOn(seat);
    expect(await eventually(seat.clients, seat.session)).toBe(seat.session);
    tmux(seat.socket, ["set-option", "-w", "-u", "-t", `=${seat.session}:`, "window-size"]);
    // As window-pin.ts pins: its record, then manual at its own size.
    tmux(seat.socket, ["set-option", "-w", "-t", `=${seat.session}:`, WINDOW_SIZE_PRIOR_OPTION, "inherit 99999.1"]);
    tmux(seat.socket, ["set-option", "-w", "-t", `=${seat.session}:`, "window-size", "manual"]);
    tmux(seat.socket, ["resize-window", "-t", `=${seat.session}:`, "-x", "90", "-y", "27"]);
    for (const step of [tile.focusIn, tile.focusOut, tile.close]) {
      step();
      await pause(600);
      expect(seat.size()).toBe("90x27");
    }
  });

  it("leaves a window someone else fixed alone, hooks included", async () => {
    const seat = seatOn("fixed");
    tmux(seat.socket, ["set-option", "-w", "-t", `=${seat.session}:`, "window-size", "manual"]);
    tileOn(seat);
    expect(await eventually(seat.clients, seat.session)).toBe(seat.session);
    expect(seat.option(SEAT_PIN_WIDTH_OPTION)).toBe("");
    expect(seat.hooks()).toEqual([]);
    expect(seat.size()).toBe("160x50");
  });
});

describe("which tiles pin their seat", () => {
  const local = (seat: string, readOnly = false): ViewMemberInput => ({ seat, label: seat, tmuxSession: seat, host: null, readOnly, alive: true });
  const remote: ViewMemberInput = { seat: "r", label: "r", tmuxSession: "r", host: "edge", readOnly: false, alive: true };
  const resolveHost = (id: string) => (id === "edge" ? { id: "edge", transport: "ssh" as const, target: "fixture" } : null);

  it("a pinning provider's local writable tiles pin; read-only, ssh and other providers' tiles are unchanged", () => {
    const members = [local("a"), local("b", true), remote];
    const ctx = { resolveHost, localTmux: "/usr/bin/tmux", localTmuxServer: ["-L", "openrig"] };
    const pinned = composeView("v", members, { ...ctx, pinWritableSeats: true });
    const sizing = composeView("v", members, ctx);
    expect(pinned.opened[0]!.attachArgv).toEqual(pinnedTileAttachArgv("/usr/bin/tmux", ["-L", "openrig"], "a"));
    expect(sizing.opened[0]!.attachArgv).toEqual(tileAttachArgv("/usr/bin/tmux", ["-L", "openrig"], "a", false));
    expect(pinned.opened.slice(1)).toEqual(sizing.opened.slice(1));
    // Herdr takes a restart command only without apostrophes or control characters (herdrResumeArgv), so a Herdr restart
    // brings the pinned tile back rather than a shell.
    expect(pinned.opened[0]!.attachArgv!.filter(arg => /['\u0000-\u001f\u007f]/.test(arg))).toEqual([]);
    const transport = { probe: async () => ({ alive: false, version: null, protocol: null }), request: async () => ({}) };
    expect(new HerdrAdapter({ transportFactory: () => transport }).pinsWritableSeats).toBe(true);
  });

  class Recording implements TerminalProvider {
    readonly panesPerPage = 16;
    last: ComposedView | null = null;
    constructor(readonly name: string, readonly pinsWritableSeats?: boolean) {}
    async status() { return { provider: this.name, available: true, capabilities: {} }; }
    async liveness() { return { alive: true }; }
    async openView(view: ComposedView): Promise<OpenViewResult> {
      this.last = view;
      return { provider: this.name, ok: true, opened: view.opened.map((p) => p.seat), absent: view.absent, degraded: view.degraded, pages: view.pages.length };
    }
  }

  it.each([["herdr", true], ["cmux", undefined]] as const)("the service composes %s's tiles by the provider's own choice, and the preview's plan matches the open", async (name, pins) => {
    const provider = new Recording(name, pins);
    const rows = [{ canonicalSessionName: "a@r", attachmentType: "tmux" as const, tmuxSession: "a@r", rigName: "r", logicalId: "pod.a" }];
    const svc = new TerminalService({
      resolveProvider: (n: string) => (n === name ? provider : null), viewsStore: { get: () => null, list: () => [] },
      listRigSeats: (r: string) => (r === "r" ? rows : null), listPodSeats: () => null, listRigNames: () => ["r"],
      resolveHost: () => null, hasSession: () => true, resolveLocalTmux: () => "/usr/bin/tmux",
    } as TerminalServiceDeps);
    const preview = await svc.previewView({ view: "rig:r", provider: name }) as { planId: string };
    const res = await svc.openView({ view: "rig:r", provider: name, expectedPlan: preview.planId });
    expect(res.code).toBeUndefined();
    const argv = provider.last!.opened[0]!.attachArgv!;
    expect(argv).toEqual(pins ? pinnedTileAttachArgv(argv[5]!, argv.slice(6), "a@r") : tileAttachArgv(argv[5]!, argv.slice(6), "a@r", false));
  });
});
