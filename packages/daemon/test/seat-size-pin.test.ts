// A writable Herdr tile is a tmux client of its seat, so watching a seat in Herdr resized the agent's real pane to the tile,
// and it stayed that size. These cells run real tmux on isolated servers: a 160x50 seat, and a 100x30 "tile" (a pane on a
// second server running the attach, as a Herdr tile does), with focus in and out sent as the terminal would send them.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pinSeatsForHerdr, SEAT_PIN_OPTION } from "../src/domain/terminal/seat-size-pin.js";

const servers: string[] = [];
const server = (name: string) => { const socket = `pin-${name}-${randomBytes(3).toString("hex")}`; servers.push(socket); return socket; };
const tmux = (socket: string, args: string[]) =>
  execFileSync("tmux", ["-L", socket, "-f", "/dev/null", ...args], { encoding: "utf8", env: { ...process.env, TMUX: "" } });
afterEach(() => { for (const socket of servers.splice(0)) { try { tmux(socket, ["kill-server"]); } catch { /* already gone */ } } });

async function eventually(read: () => string, want: string): Promise<string> {
  let seen = read();
  for (let i = 0; i < 80 && seen !== want; i++) { await new Promise(resolve => setTimeout(resolve, 50)); seen = read(); }
  return seen;
}

function seatOn(socket: string, session = "seat@rig") {
  tmux(socket, ["new-session", "-d", "-s", session, "-x", "160", "-y", "50", "sleep 120"]);
  const size = () => tmux(socket, ["display-message", "-p", "-t", `=${session}:`, "#{window_width}x#{window_height}"]).trim();
  const run = async (args: string[]) => tmux(socket, args);
  return { size, run, session };
}

describe("pinSeatsForHerdr: a Herdr view keeps each agent at its own size", () => {
  it("keeps the seat at its size while a tile watches, fits it only while the tile has focus, and gives the size back", async () => {
    const seatServer = server("seat");
    const seat = seatOn(seatServer);
    expect(await pinSeatsForHerdr(seat.run, "tmux", [seat.session])).toEqual([]);
    expect(tmux(seatServer, ["show-options", "-wv", "-t", `=${seat.session}:`, "window-size"]).trim()).toBe("manual");
    expect(tmux(seatServer, ["show-options", "-wv", "-t", `=${seat.session}:`, SEAT_PIN_OPTION]).trim()).toBe("160x50");

    const tileServer = server("tile");
    tmux(tileServer, ["new-session", "-d", "-s", "tile", "-x", "100", "-y", "30", `env -u TMUX tmux -L ${seatServer} attach -t ${seat.session}`]);
    expect(await eventually(() => tmux(seatServer, ["list-clients", "-F", "x"]).trim(), "x")).toBe("x");
    expect(seat.size()).toBe("160x50"); // watched: unchanged

    const focus = (key: "49" | "4f") => tmux(tileServer, ["send-keys", "-t", "tile", "-H", "1b", "5b", key]);
    focus("49");
    expect(await eventually(seat.size, "100x30")).toBe("100x30"); // typing: it fits the focused tile
    focus("4f");
    expect(await eventually(seat.size, "160x50")).toBe("160x50"); // focus elsewhere: its own size again
    focus("49");
    expect(await eventually(seat.size, "100x30")).toBe("100x30");
    tmux(tileServer, ["kill-server"]);
    expect(await eventually(seat.size, "160x50")).toBe("160x50"); // the tile closed: its own size again
  });

  it("leaves a window someone else fixed alone", async () => {
    const seatServer = server("fixed");
    const seat = seatOn(seatServer);
    tmux(seatServer, ["set-option", "-w", "-t", `=${seat.session}:`, "window-size", "manual"]);
    const notes = await pinSeatsForHerdr(seat.run, "tmux", [seat.session]);
    expect(notes).toEqual([`${seat.session} has a fixed window size set by someone else; Herdr views leave it as it is.`]);
    expect(tmux(seatServer, ["show-options", "-wqv", "-t", `=${seat.session}:`, SEAT_PIN_OPTION]).trim()).toBe("");
    expect(tmux(seatServer, ["show-hooks", "-t", seat.session])).not.toContain("resize-window");
  });

  it("pins once: a second open keeps the recorded size and sets each hook once", async () => {
    const seatServer = server("again");
    const seat = seatOn(seatServer);
    await pinSeatsForHerdr(seat.run, "tmux", [seat.session, seat.session]);
    tmux(seatServer, ["resize-window", "-t", `=${seat.session}:`, "-x", "120", "-y", "40"]); // as a focused tile would
    expect(await pinSeatsForHerdr(seat.run, "tmux", [seat.session])).toEqual([]);
    expect(tmux(seatServer, ["show-options", "-wv", "-t", `=${seat.session}:`, SEAT_PIN_OPTION]).trim()).toBe("160x50");
    const hooks = tmux(seatServer, ["show-hooks", "-t", seat.session]).split("\n").filter(line => line.includes("resize-window"));
    expect(hooks.map(line => line.split(" ")[0])).toEqual(["client-detached[93]", "client-focus-in[93]", "client-focus-out[93]"]);
  });

  it("pins again on the next open when the pin's window-size was dropped", async () => {
    const seatServer = server("dropped");
    const seat = seatOn(seatServer);
    await pinSeatsForHerdr(seat.run, "tmux", [seat.session]);
    // A client resized it, then (as a readable capture's note says how to) it follows its inherited sizing again.
    // resize-window itself sets window-size manual, so the drop comes after it.
    tmux(seatServer, ["resize-window", "-t", `=${seat.session}:`, "-x", "140", "-y", "45"]);
    tmux(seatServer, ["set-option", "-w", "-u", "-t", `=${seat.session}:`, "window-size"]);
    expect(await pinSeatsForHerdr(seat.run, "tmux", [seat.session])).toEqual([]);
    expect(tmux(seatServer, ["show-options", "-wv", "-t", `=${seat.session}:`, "window-size"]).trim()).toBe("manual");
    expect(tmux(seatServer, ["show-options", "-wv", "-t", `=${seat.session}:`, SEAT_PIN_OPTION]).trim()).toBe("140x45");
  });

  it("names a seat it couldn't pin and carries on with the rest", async () => {
    const run = vi.fn(async (args: string[]) => {
      if (args[0] === "display-message" && args[3] === "=gone@rig:") throw new Error("can't find session: gone@rig");
      return args[0] === "display-message" ? "$7 @4 160x50 latest \n" : "";
    });
    const notes = await pinSeatsForHerdr(run, "/usr/bin/tmux", ["gone@rig", "here@rig"]);
    expect(notes).toEqual(["gone@rig keeps tmux's usual sizing: its size couldn't be pinned (can't find session: gone@rig), so a Herdr tile may resize it."]);
    expect(run).toHaveBeenCalledWith(["set-option", "-w", "-t", "@4", "window-size", "manual"]);
    expect(run.mock.calls.filter(([args]) => args[0] === "set-hook")).toHaveLength(3);
    expect(run.mock.calls.find(([args]) => args[0] === "set-hook")![0][4]).toContain('"/usr/bin/tmux" -S "#{socket_path}" resize-window');
  });
});
